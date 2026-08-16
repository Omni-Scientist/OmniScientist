#!/usr/bin/env python3
"""score.py -- decoupled cross-family LLM-judge panel for Omnist papers.

Scores a FINISHED run WITHOUT any re-inference: it reads the produced paper
(stages/03_paper.tex), the run's figures + result ledger (02_experiment.json),
and sends them to a panel of cross-family judges. Each judge scores a 7-dimension
rubric (aligned with tab:eval-dims): the five standard review dimensions plus the
two the framework makes mandatory -- multimodal grounding and factual accuracy.

Design notes
- NO PDF rasterization. We feed the LaTeX text + the few fig_*.png the paper
  actually includes (from 02_experiment.json['figures'], lead-first). Cheap.
- Quality dims are judged BLIND (paper + figures only). factual_accuracy is
  judged against the authors' result LEDGER (02_experiment.json key_numbers).
- CROSS-FAMILY iron rule: judges (Google / DeepSeek / Alibaba-Qwen) share no
  family with the backbones under test (Anthropic / OpenAI), so self-preference
  is controlled by construction.
- gemini/deepseek are reached through an OpenAI-compatible gateway (set
  OMNIST_GATEWAY_URL + OMNIST_GATEWAY_KEY); some providers behind it REQUIRE
  stream=True. A local Qwen judge is added when OMNIST_QWEN_URL is set.

Usage
  python scripts/score.py --task stead_seismic
  python scripts/score.py --all
  python scripts/score.py --all --csv eval_matrix.csv
  python scripts/score.py --task stead_seismic --judges gemini-2.5-pro,deepseek-v4-flash
  python scripts/score.py --task stead_seismic --repeat 3 --temp 0.7   # self-consistency
"""
import os, sys, re, json, glob, argparse, csv, statistics
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pipeline  # img_block, parse_json, PRICE

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)                      # engine/
EXAMPLES = os.path.join(ROOT, "examples")

DIMS = ["novelty", "soundness", "clarity", "significance",
        "reproducibility", "mm_grounding", "factual_accuracy"]

# judge registry: name -> (transport, model_id, sees_images)
JUDGES = {
    "gemini-2.5-pro":    ("gateway", "google/gemini-2.5-pro",       True),
    "deepseek-v4-flash": ("gateway", "deepseek/deepseek-v4-flash",  False),
}
# local Qwen judge is opt-in via env, so the panel works without it
_QURL = os.environ.get("OMNIST_QWEN_URL")         # e.g. http://localhost:8010/v1
if _QURL:
    JUDGES["qwen-local"] = ("qwen", os.environ.get("OMNIST_QWEN_MODEL", "qwen"), True)

# grammar-constrained JSON: forces a rambling local model (Qwen3.5 reasons for 14k chars otherwise)
# to emit ONLY the 8 integer scores -> reliable + fast (3s vs 90s). Gateway judges keep the CSV path.
_JSON_SCHEMA = {"type": "json_schema", "json_schema": {"name": "rubric", "strict": True, "schema": {
    "type": "object", "properties": {k: {"type": "integer", "minimum": 1, "maximum": 10} for k in DIMS + ["overall"]},
    "required": DIMS + ["overall"], "additionalProperties": False}}}

_CLIENTS = {}
def _client(transport):
    """Lazily build (and cache) the OpenAI-compatible client for a transport."""
    if transport in _CLIENTS:
        return _CLIENTS[transport]
    from openai import OpenAI
    if transport == "gateway":
        url = os.environ.get("OMNIST_GATEWAY_URL")
        if not url:
            raise RuntimeError("gateway judge needs OMNIST_GATEWAY_URL + OMNIST_GATEWAY_KEY in the environment")
        c = OpenAI(base_url=url, api_key=os.environ.get("OMNIST_GATEWAY_KEY", "EMPTY"))
    elif transport == "qwen":
        c = OpenAI(base_url=_QURL, api_key=os.environ.get("OMNIST_QWEN_KEY", "EMPTY"))
    else:
        raise ValueError("unknown transport " + transport)
    _CLIENTS[transport] = c
    return c

def _stream(transport, model, content, max_tokens=900, temperature=0.0, seed=0, schema=None):
    """Streaming chat call (some gateway-proxied providers require streaming). If schema is given
    (local Qwen), pass response_format so sglang grammar-constrains the output to clean JSON."""
    cl = _client(transport)
    kw = dict(model=model, messages=[{"role": "user", "content": content}],
              max_tokens=max_tokens, temperature=temperature, stream=True)
    if schema is not None:
        kw["response_format"] = schema
    try:
        kw["seed"] = seed
        s = cl.chat.completions.create(**kw)
    except TypeError:
        kw.pop("seed", None)
        s = cl.chat.completions.create(**kw)
    out = []
    for ch in s:
        if ch.choices and ch.choices[0].delta and ch.choices[0].delta.content:
            out.append(ch.choices[0].delta.content)
    return "".join(out)


# ---------- assemble the material a judge sees ----------
def _paper_text(task, stages):
    """LaTeX body (preamble stripped), capped; falls back to abstract if no tex."""
    tex = os.path.join(stages, "03_paper.tex")
    if os.path.exists(tex):
        t = open(tex, encoding="utf-8", errors="ignore").read()
        i = t.find("\\begin{document}")
        if i > 0:
            t = t[i + len("\\begin{document}"):]
        t = re.sub(r"(?m)^\s*%.*$", "", t)                 # drop comment lines
        return t.strip()[:16000]
    pj = os.path.join(stages, "03_paper.json")
    if os.path.exists(pj):
        d = json.load(open(pj))
        return (str(d.get("title", "")) + "\n\n" + str(d.get("abstract", "")))[:16000]
    return ""

def _ledger_and_figs(task, stages):
    """Result ledger (for factual check) + resolved figure files (lead-first)."""
    ep = os.path.join(stages, "02_experiment.json")
    ledger, figs = {}, []
    if os.path.exists(ep):
        d = json.load(open(ep))
        ledger = {"verdict": d.get("verdict"), "lead": d.get("lead"),
                  "result_statement": d.get("result_statement"),
                  "key_numbers": d.get("key_numbers"),
                  "stat_tests": d.get("stat_tests")}
        casedir = os.path.join(EXAMPLES, task)
        for f in (d.get("figures") or []):
            name = f.get("file") if isinstance(f, dict) else str(f)
            if not name:
                continue
            hits = ([os.path.join(casedir, name)] if os.path.exists(os.path.join(casedir, name))
                    else glob.glob(os.path.join(casedir, "**", os.path.basename(name)), recursive=True))
            if hits:
                figs.append({"path": hits[0], "caption": (f.get("caption") if isinstance(f, dict) else "")})
    return ledger, figs

RUBRIC = (
    "Score these SEVEN dimensions, each an INTEGER 1-10 (1=very poor, 10=excellent), and be strict "
    "-- an incremental or workshop-level paper must be scored as such, never rubber-stamped:\n"
    "1. novelty -- originality against real prior art.\n"
    "2. soundness -- method and statistics correct (controls, multiple-comparison correction, no leakage).\n"
    "3. clarity -- presentation and structure.\n"
    "4. significance -- importance of the finding.\n"
    "5. reproducibility -- enough detail to re-run.\n"
    "6. mm_grounding -- does the paper GENUINELY use the visual/observational evidence (the attached "
    "figures of raw observations), or is it just statistics on scalar features? Reward papers that "
    "SHOW and INTERPRET raw observations; penalize ones whose figures are absent, unreadable, or decorative.\n"
    "7. factual_accuracy -- does EVERY headline number in the paper trace to the AUTHORS' RESULT LEDGER "
    "below? Penalize any statistic or claim not supported by the ledger.\n")

def _build_content(paper, ledger, figs, sees_images):
    prompt = (
        "You are an expert, critical peer reviewer for a top venue, reviewing ONE paper produced by an "
        "automated multimodal research system. Judge ONLY what is written in the paper and shown in its "
        "figures. Do NOT inflate scores.\n\n" + RUBRIC +
        ("\nNOTE: you cannot see the figures directly; score mm_grounding from how the paper DESCRIBES its "
         "use of visual/observational evidence.\n" if not sees_images else "\n") +
        "\n=== PAPER (LaTeX source) ===\n" + paper +
        "\n\n=== AUTHORS' RESULT LEDGER (use ONLY for the factual_accuracy check) ===\n" +
        json.dumps(ledger, default=str)[:4000] +
        ("\n\nFigure captions:\n" + "\n".join("- " + str(f.get("caption", ""))[:200] for f in figs) if figs else "") +
        "\n\nOUTPUT FORMAT -- this is strict. Your FIRST line must be EXACTLY the eight integer scores "
        "(1-10 each), comma-separated, in THIS order and NOTHING else on the line (no words, no JSON, no "
        "markdown fence):\n"
        "novelty,soundness,clarity,significance,reproducibility,mm_grounding,factual_accuracy,overall\n"
        "Example first line: 6,8,7,7,6,5,9,6\n"
        "Then on the next line write: NOTE: <one sentence, key strength + biggest weakness>.")
    if sees_images and figs:
        content = [{"type": "text", "text": prompt}]
        for f in figs[:5]:                                 # cap figures to keep tokens/cost down
            try:
                content.append(pipeline.img_block(f["path"]))
            except Exception:
                pass
        return content
    return prompt


def _extract_scores(raw):
    """Truncation-proof: prefer the compact 8-integer CSV first line (survives the
    ~100-char gateway gemini stream cutoff); fall back to JSON / per-key regex."""
    order = DIMS + ["overall"]
    raw = raw or ""
    # 1) eight comma-separated 1-2 digit integers, anywhere (the required first line)
    m = re.search(r"(?<!\d)" + r"\s*,\s*".join([r"(\d{1,2})"] * 8) + r"(?!\d)", raw)
    if m:
        obj = {k: float(v) for k, v in zip(order, m.groups())}
        nm = re.search(r"(?:notes?|NOTE)\s*[:\-]\s*(.+)", raw, re.S)
        if nm:
            obj["notes"] = nm.group(1).strip()[:600]
        return obj
    # 2) JSON or per-key regex fallback (for judges that ignore the CSV instruction)
    obj = pipeline.parse_json(raw) or {}
    if not all(isinstance(obj.get(k), (int, float)) for k in DIMS):
        obj = {}
        for k in order:
            mm = re.search(r'"?%s"?\s*[:=]\s*(\d+(?:\.\d+)?)' % k, raw)
            if mm:
                obj[k] = float(mm.group(1))
        nm = re.search(r'"?notes?"?\s*[:=]\s*"?([^"]+)', raw)
        if nm:
            obj["notes"] = nm.group(1).strip()[:600]
    return obj

def _one_judge(judge, content, temperature=0.0, seed=0):
    transport, model, _ = JUDGES[judge]
    schema = _JSON_SCHEMA if transport == "qwen" else None      # local Qwen rambles -> grammar-constrain to JSON
    mt = 500 if transport == "qwen" else 1200
    last = "no valid JSON"
    for attempt in range(3):
        try:
            raw = _stream(transport, model, content, max_tokens=mt, temperature=temperature, seed=seed, schema=schema)
            obj = _extract_scores(raw)
            if all(obj.get(k) is not None for k in DIMS):
                sc = {k: _clip(obj.get(k)) for k in DIMS}
                sc["overall"] = _clip(obj.get("overall"))
                sc["composite"] = round(statistics.mean(sc[k] for k in DIMS), 3)
                sc["notes"] = str(obj.get("notes", ""))[:600]
                return sc
            last = "missing dims (raw %dc)" % len(raw or "")
        except Exception as e:
            last = str(e)[:160]
    return {"_failed": True, "reason": last}

def _clip(v):
    try:
        return max(1, min(10, int(round(float(v)))))
    except Exception:
        return None


def score_task(task, judges, repeat=1, temperature=0.0, write=True):
    stages = os.path.join(EXAMPLES, task, "stages")
    if not os.path.exists(os.path.join(stages, "03_paper.tex")) and \
       not os.path.exists(os.path.join(stages, "03_paper.json")):
        print("[score] %s: no paper (03_paper.*) -- skip" % task); return None
    paper = _paper_text(task, stages)
    ledger, figs = _ledger_and_figs(task, stages)
    result = {"task": task, "n_figs": len(figs),
              "figs": [os.path.basename(f["path"]) for f in figs], "judges": {}}
    for j in judges:
        _, _, sees = JUDGES[j]
        content = _build_content(paper, ledger, figs, sees)
        runs = []
        for r in range(repeat):
            sc = _one_judge(j, content, temperature=temperature, seed=r)
            runs.append(sc)
            tag = ("comp=%.2f overall=%s" % (sc["composite"], sc["overall"])) if not sc.get("_failed") else "FAILED"
            print("  [score] %-22s %-18s %s" % (task, j, tag))
        result["judges"][j] = runs[0] if repeat == 1 else {"runs": runs, "mean_composite": _mean([x.get("composite") for x in runs])}
    # panel aggregate over the (first-run) per-dim scores
    ok = {j: (v if repeat == 1 else v["runs"][0]) for j, v in result["judges"].items()}
    ok = {j: v for j, v in ok.items() if not v.get("_failed")}
    if ok:
        result["panel"] = {k: _mean([v.get(k) for v in ok.values()]) for k in DIMS + ["overall", "composite"]}
    if write:
        json.dump(result, open(os.path.join(stages, "06_scores.json"), "w"), indent=1)
    return result

def _mean(xs):
    xs = [x for x in xs if isinstance(x, (int, float))]
    return round(statistics.mean(xs), 3) if xs else None


def _all_tasks():
    out = []
    for d in sorted(os.listdir(EXAMPLES)):
        if os.path.exists(os.path.join(EXAMPLES, d, "stages", "03_paper.tex")):
            out.append(d)
    return out

def _write_csv(results, path):
    rows = []
    for res in results:
        if not res:
            continue
        p = res.get("panel", {})
        row = {"task": res["task"], "n_figs": res["n_figs"]}
        for k in DIMS + ["overall", "composite"]:
            row["panel_" + k] = p.get(k)
        for j, v in res["judges"].items():
            vv = v if "composite" in v else v
            row[j + "_composite"] = vv.get("composite") if isinstance(vv, dict) else None
        rows.append(row)
    if not rows:
        print("[score] nothing to write"); return
    keys = sorted({k for r in rows for k in r})
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["task", "n_figs"] + [k for k in keys if k not in ("task", "n_figs")])
        w.writeheader()
        for r in rows:
            w.writerow(r)
    print("[score] wrote %s (%d rows)" % (path, len(rows)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--task")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--judges", default=",".join(JUDGES.keys()))
    ap.add_argument("--repeat", type=int, default=1)
    ap.add_argument("--temp", type=float, default=0.0)
    ap.add_argument("--csv")
    a = ap.parse_args()
    judges = [j.strip() for j in a.judges.split(",") if j.strip() in JUDGES]
    if not judges:
        print("no valid judges; available:", list(JUDGES)); sys.exit(1)
    print("[score] judges:", judges)
    tasks = _all_tasks() if a.all else ([a.task] if a.task else [])
    if not tasks:
        print("give --task <name> or --all"); sys.exit(1)
    results = []
    for t in tasks:
        results.append(score_task(t, judges, repeat=a.repeat, temperature=a.temp))
    if a.csv:
        _write_csv(results, a.csv)
    print("\n[score] done. judge-side spend ~$%.4f (approx; the gateway underprices vs PRICE fallback)" % pipeline.spend())

if __name__ == "__main__":
    main()
