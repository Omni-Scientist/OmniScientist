#!/usr/bin/env python3
"""pairwise.py -- head-to-head (捉对厮杀) perception ablation.

Instead of scoring each paper on an absolute scale, show a judge BOTH papers (Perception vs the
Blind scalar-baseline), anonymised as A/B with the order RANDOMISED per run, and ask -- for each
rubric dimension -- which is better (A / B / tie). LLM judges are far more reliable at relative
than absolute judgement, so this yields a directly interpretable WIN RATE. Multi-run for variance
control: local judges (Qwen / Gemma, free) run many times; remote judges (deepseek / gemini, paid)
run fewer. Local judges are grammar-constrained to a clean verdict JSON.

Judges are read from env: OMNIST_QWEN_URL / OMNIST_GEMMA_URL for the local pair (+ their _MODEL/_KEY),
plus gateway deepseek / gemini. Reuses score.py for paper text, figures and the judging pipeline.

Usage:
  python scripts/pairwise.py --runs-local 5 --runs-remote 2 --judges qwen-27b,deepseek-v4-flash
"""
import os, sys, re, json, argparse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import score as S
from openai import OpenAI

DIMS = S.DIMS
_SCHEMA = {"type": "json_schema", "json_schema": {"name": "verdict", "strict": True, "schema": {
    "type": "object", "properties": {k: {"type": "string", "enum": ["A", "B", "tie"]} for k in DIMS + ["overall"]},
    "required": DIMS + ["overall"], "additionalProperties": False}}}

# the 6 headline pairs: (label, perception_task, blind_task)
PAIRS = [("Galaxy", "galaxy_xsurvey"), ("Pathology", "histopath_demo"), ("Seismology", "stead_seismic"),
         ("Cardiology", "heartsound"), ("Mech.CAD", "mcb_cad"), ("Plant", "plant_pheno3d")]

def judges_from_env():
    J = {}
    if os.environ.get("OMNIST_QWEN_URL"):
        J["qwen-27b"] = dict(url=os.environ["OMNIST_QWEN_URL"], model=os.environ.get("OMNIST_QWEN_MODEL", "qwen3.5-27b-judge"),
                             key=os.environ.get("OMNIST_QWEN_KEY", "EMPTY"), sees=True, local=True)
    if os.environ.get("OMNIST_GEMMA_URL"):
        J["gemma-27b"] = dict(url=os.environ["OMNIST_GEMMA_URL"], model=os.environ.get("OMNIST_GEMMA_MODEL", "gemma-3-27b-it"),
                              key=os.environ.get("OMNIST_GEMMA_KEY", "token-gemma27"), sees=True, local=True)
    if os.environ.get("OMNIST_GATEWAY_URL"):               # cross-family judges via a bring-your-own OpenAI-compatible gateway
        _gw = os.environ["OMNIST_GATEWAY_URL"]; _gk = os.environ.get("OMNIST_GATEWAY_KEY", "")
        J["deepseek-v4-flash"] = dict(url=_gw, model="deepseek/deepseek-v4-flash", key=_gk, sees=False, local=False)
        J["gemini-2.5-pro"]    = dict(url=_gw, model="google/gemini-2.5-pro",      key=_gk, sees=True,  local=False)
    return J

_CL = {}
def _client(url, key):
    if url not in _CL:                                      # generous timeout + retries: the OpenAI-compatible gateway blips 500/slow
        _CL[url] = OpenAI(base_url=url, api_key=key or "EMPTY", timeout=300, max_retries=3)
    return _CL[url]

def _call(jd, content, temperature, seed):
    kw = dict(model=jd["model"], messages=[{"role": "user", "content": content}],
              max_tokens=(400 if jd["local"] else 1200), temperature=temperature, stream=True)
    if jd["local"]:
        kw["response_format"] = _SCHEMA
    try:
        kw["seed"] = seed
        s = _client(jd["url"], jd["key"]).chat.completions.create(**kw)
    except TypeError:
        kw.pop("seed", None)
        s = _client(jd["url"], jd["key"]).chat.completions.create(**kw)
    out = []
    for ch in s:
        if ch.choices and ch.choices[0].delta and ch.choices[0].delta.content:
            out.append(ch.choices[0].delta.content)
    return "".join(out)

def _bundle(task, cap=8000):
    st = os.path.join(S.EXAMPLES, task, "stages")
    return S._paper_text(task, st)[:cap], S._ledger_and_figs(task, st)[1]

def _content(A, B, sees, nfig=3):
    (tA, fA), (tB, fB) = A, B
    p = ("Two papers, A and B, were produced by an automated multimodal research system on the SAME task and "
         "data. For EACH dimension decide which paper is better: answer 'A', 'B', or 'tie' (use 'tie' only when "
         "genuinely indistinguishable). Dimensions:\n"
         "novelty; soundness; clarity; significance; reproducibility; "
         "mm_grounding = does the paper genuinely SHOW and INTERPRET the raw observation (images / waveforms / "
         "point clouds) rather than only derived scalar statistics; factual_accuracy.\n\n"
         "=== PAPER A ===\n" + tA + "\n\n=== PAPER B ===\n" + tB +
         '\n\nReturn ONLY JSON: {"novelty":"A|B|tie","soundness":"...","clarity":"...","significance":"...",'
         '"reproducibility":"...","mm_grounding":"...","factual_accuracy":"...","overall":"A|B|tie"}.')
    if not sees:
        return p
    c = [{"type": "text", "text": p}]
    for f in fA[:nfig]:
        try:
            c.append(S.pipeline.img_block(f["path"]))
        except Exception:
            pass
    c.append({"type": "text", "text": "[the images above are PAPER A's figures; the images below are PAPER B's figures]"})
    for f in fB[:nfig]:
        try:
            c.append(S.pipeline.img_block(f["path"]))
        except Exception:
            pass
    return c

def _parse(raw):
    obj = S.pipeline.parse_json(raw) or {}
    out = {}
    for k in DIMS + ["overall"]:
        v = str(obj.get(k, "")).strip().upper()
        if v in ("A", "B", "TIE"):
            out[k] = "tie" if v == "TIE" else v
        else:
            m = re.search(r'"%s"\s*:\s*"?(A|B|tie)' % k, raw, re.I)
            if m:
                out[k] = "tie" if m.group(1).lower() == "tie" else m.group(1).upper()
    return out

def compare(jd, perc, blind, runs):
    """runs of head-to-head; returns list of {dim -> 'perception'|'blind'|'tie'}."""
    P, Bl = _bundle(perc), _bundle(blind)
    res = []
    for r in range(runs):
        perc_is_A = (r % 2 == 0)                            # randomise order to cancel position bias
        A, B = (P, Bl) if perc_is_A else (Bl, P)
        for _try in range(2 if jd["local"] else 5):         # the remote gateway gets more tries to ride through blips
            try:
                raw = _call(jd, _content(A, B, jd["sees"]), temperature=(0.6 if runs > 1 else 0.0), seed=r)
                v = _parse(raw)
                if len(v) >= len(DIMS):
                    res.append({k: ("tie" if ab == "tie" else ("perception" if (ab == "A") == perc_is_A else "blind"))
                                for k, ab in v.items()})
                    break
            except Exception:
                continue
    return res

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--judges", default="qwen-27b,gemma-27b,deepseek-v4-flash")
    ap.add_argument("--runs-local", type=int, default=5)
    ap.add_argument("--runs-remote", type=int, default=2)
    ap.add_argument("--out", default=os.path.join(S.ROOT, "pairwise_results.json"))
    a = ap.parse_args()
    J = judges_from_env()
    want = [j.strip() for j in a.judges.split(",") if j.strip() in J]
    print("[pairwise] judges:", want)

    tally = {d: {"perception": 0, "blind": 0, "tie": 0} for d in DIMS + ["overall"]}
    per_case = {}
    detail = {}
    for lab, base in PAIRS:
        bl = base + "__blind"
        if not os.path.exists(os.path.join(S.EXAMPLES, bl, "stages", "03_paper.tex")):
            print("  [skip] %s: no blind paper" % lab); continue
        cc = {d: {"perception": 0, "blind": 0, "tie": 0} for d in DIMS + ["overall"]}
        for jn in want:
            jd = J[jn]
            runs = a.runs_local if jd["local"] else a.runs_remote
            rows = compare(jd, base, bl, runs)
            for row in rows:
                for d, who in row.items():
                    if d in cc:
                        cc[d][who] += 1; tally[d][who] += 1
            print("  %-11s %-16s runs=%d  overall P/B/T = %d/%d/%d"
                  % (lab, jn, len(rows), sum(1 for x in rows if x.get("overall") == "perception"),
                     sum(1 for x in rows if x.get("overall") == "blind"),
                     sum(1 for x in rows if x.get("overall") == "tie")))
        per_case[lab] = cc
    detail = {"tally": tally, "per_case": per_case, "judges": want,
              "runs_local": a.runs_local, "runs_remote": a.runs_remote}
    json.dump(detail, open(a.out, "w"), indent=1)

    def wr(t):                                              # win rate = P wins / decisive (excl ties)
        dec = t["perception"] + t["blind"]
        return (t["perception"] / dec) if dec else None
    print("\n=== Perception win-rate vs Blind (excl. ties) ===")
    for d in DIMS + ["overall"]:
        t = tally[d]; w = wr(t)
        print("  %-16s %s  (P/B/tie = %d/%d/%d)" % (d, ("%.0f%%" % (100 * w)) if w is not None else "n/a",
                                                    t["perception"], t["blind"], t["tie"]))
    print("[pairwise] wrote", a.out)

if __name__ == "__main__":
    main()
