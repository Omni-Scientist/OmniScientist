#!/usr/bin/env python3
"""run_matrix.py -- batch driver for the Omnist evaluation generation matrix.

Runs `agentic.py --stage run` over a (case x model x vision) matrix, each variant
ISOLATED in its own examples/<variant>/ dir (series.json copied + data symlinked to
the base case, exactly like the hand-made stead_gpt55), so vision-off never
overwrites vision-on and every run stays re-scorable. Captures per-run tokens/$ via
the agentic OMNIST_COST_OUT hook into cost_ledger_eval.jsonl (feeds tab:eval-cost).

Reuse: a (sonnet-5, vision-on) cell whose base case already has stages/03_paper.tex
is REUSED, not rerun. Concurrency is API-bound; default 4 workers.

Usage
  python scripts/run_matrix.py --dry-run
  python scripts/run_matrix.py --only stead_seismic__off --workers 1     # smoke one
  python scripts/run_matrix.py --workers 4                                # full core matrix
"""
import os, sys, json, time, shutil, argparse, subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)                       # engine/
EXAMPLES = os.path.join(ROOT, "examples")
LEDGER = os.path.join(ROOT, "cost_ledger_eval.jsonl")

MODEL_ID = {"sonnet": "claude-sonnet-5", "gpt55": "gpt-5.5",
            "opus48": "claude-opus-4-8", "fable5": "claude-fable-5",
            # open-weight backbones served locally (vLLM / sglang, $0); needs OMNIST_LOCAL_URL/KEY in env.
            # cross-family judge rule: qwen27 backbone -> judges exclude qwen; gemma431 -> judges exclude google.
            "qwen27": "local/qwen3.5-27b", "gemma431": "local/gemma-4-31b", "qwen9": "local/qwen3.5-9b", "gemma426": "local/gemma-4-26b", "qwen122": "local/qwen3.5-122b",
            "terra": "gpt-5.6-terra",   # OpenAI-official reasoning model (gpt- prefix -> _openai_client, paid)
            "minimax": "or/minimax/minimax-m3", "doubao": "or/bytedance-seed/seed-1.6",
            "step": "or/stepfun/step-3.7-flash", "glm": "or/z-ai/glm-5.2",
            "kimi": "or/moonshotai/kimi-k2.7-code", "qwen37": "or/qwen/qwen3.7-max"}   # OpenRouter aggregator (or/ prefix, cheap)

# ---- the Core-first matrix (base_case, model_tag, vision) ----
# headline vision on/off (Sonnet-5): 6 named cases x {on, off}
# backbone axis (GPT-5.5, vision-on): 4 new cells (stead_gpt55 already exists -> reused by name)
MATRIX = [
    ("stead_seismic",  "sonnet", "on"),  ("stead_seismic",  "sonnet", "off"),
    ("heartsound",     "sonnet", "on"),  ("heartsound",     "sonnet", "off"),
    ("mcb_cad",        "sonnet", "on"),  ("mcb_cad",        "sonnet", "off"),
    ("plant_pheno3d",  "sonnet", "on"),  ("plant_pheno3d",  "sonnet", "off"),
    ("histopath_demo", "sonnet", "on"),  ("histopath_demo", "sonnet", "off"),
    ("galaxy_xsurvey", "sonnet", "on"),  ("galaxy_xsurvey", "sonnet", "off"),
    ("nffa_sem",       "gpt55",  "on"),
    ("histopath_demo", "gpt55",  "on"),
    ("birdaudio",      "gpt55",  "on"),
    ("mcb_cad",        "gpt55",  "on"),
]

def variant_name(base, model_tag, vision):
    s = base
    if model_tag != "sonnet":
        s += "__" + model_tag
    if vision == "off":
        s += "__off"
    return s

def _data_prefixes(base):
    """Top-level dirs the base case's members live under (data, data5k, imgs, ...)."""
    pref = set()
    sj = os.path.join(EXAMPLES, base, "series.json")
    if os.path.exists(sj):
        d = json.load(open(sj))
        for m in (d.get("members") or []):
            f = m.get("file") if isinstance(m, dict) else None
            if f and "/" in f:
                pref.add(f.split("/", 1)[0])
    # also catch conventional data dirs even if members use a data block
    for cand in ("data", "data5k", "data1k", "imgs", "mapping"):
        if os.path.isdir(os.path.join(EXAMPLES, base, cand)):
            pref.add(cand)
    return {p for p in pref if os.path.exists(os.path.join(EXAMPLES, base, p))}

def setup_variant(base, variant):
    """Create examples/<variant>/ = series.json copy + data symlinks to base. Idempotent."""
    if variant == base:
        return
    vdir = os.path.join(EXAMPLES, variant)
    os.makedirs(vdir, exist_ok=True)
    src_sj = os.path.join(EXAMPLES, base, "series.json")
    dst_sj = os.path.join(vdir, "series.json")
    if not os.path.exists(dst_sj):
        shutil.copy2(src_sj, dst_sj)
    for p in _data_prefixes(base):
        link = os.path.join(vdir, p)
        if not os.path.exists(link):
            rel = os.path.relpath(os.path.join(EXAMPLES, base, p), vdir)
            try:
                os.symlink(rel, link)
            except FileExistsError:
                pass

def has_paper(variant):
    return os.path.exists(os.path.join(EXAMPLES, variant, "stages", "03_paper.tex"))

def run_one(base, model_tag, vision, force=False):
    variant = variant_name(base, model_tag, vision)
    tag = "%s (%s,%s)" % (variant, MODEL_ID[model_tag], vision)
    # reuse an already-produced paper (esp. the sonnet-5 vision-on base cases)
    if has_paper(variant) and not force:
        print("[reuse] %-40s already has 03_paper.tex" % tag, flush=True)
        return {"variant": variant, "base": base, "model": MODEL_ID[model_tag],
                "vision": vision, "status": "reuse", "wall_s": 0}
    setup_variant(base, variant)
    cost_out = os.path.join(EXAMPLES, variant, "cost.json")
    env = os.environ.copy()
    env["OMNIST_MODEL"] = MODEL_ID[model_tag]
    env["OMNIST_COST_OUT"] = cost_out
    env["PYTHONUNBUFFERED"] = "1"
    if vision == "off":
        env["MMSCI_NO_VISION"] = "1"
    else:
        env.pop("MMSCI_NO_VISION", None)
    logp = os.path.join(EXAMPLES, variant, "run.log")
    print("[start] %-40s -> %s" % (tag, logp), flush=True)
    t0 = time.time()
    with open(logp, "w") as lg:
        p = subprocess.run([sys.executable, "scripts/agentic.py", "--task", variant, "--stage", "run"],
                           cwd=ROOT, env=env, stdout=lg, stderr=subprocess.STDOUT)
    wall = round(time.time() - t0, 1)
    ok = has_paper(variant) and p.returncode == 0
    rec = {"variant": variant, "base": base, "model": MODEL_ID[model_tag], "vision": vision,
           "status": "ok" if ok else "FAILED", "returncode": p.returncode, "wall_s": wall}
    if os.path.exists(cost_out):
        try:
            c = json.load(open(cost_out))
            rec["spend"] = c.get("spend"); rec["usage"] = c.get("usage")
        except Exception:
            pass
    with open(LEDGER, "a") as f:
        f.write(json.dumps(rec) + "\n")
    print("[done ] %-40s status=%s wall=%ss $%s" %
          (tag, rec["status"], wall, rec.get("spend")), flush=True)
    return rec

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--only", default="", help="substring filter on variant name")
    ap.add_argument("--vision", default="all", choices=["on", "off", "all"], help="run only on/off cells")
    ap.add_argument("--cases", default="", help="comma list of base cases to run vision-on (breadth/backbone pass), overrides MATRIX")
    ap.add_argument("--model", default="sonnet", choices=list(MODEL_ID), help="backbone tag for the --cases pass (e.g. qwen27 for the open-weight axis)")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--force", action="store_true", help="rerun even if a paper exists")
    a = ap.parse_args()

    # local vLLM/sglang serve DOES batch concurrent requests (continuous batching -- neither serve pbs caps
    # --max-num-seqs, so sglang/vLLM default to high concurrency). The earlier forced --workers 1 was
    # over-conservative and left the H200 idle between requests. Honor --workers: the server queues requests
    # beyond KV capacity rather than OOMing (141GB = 62GB weights + ~79GB KV batches many reqs, most well
    # under the 64-128k ctx cap). Bump the local default so a bare run is already concurrent.
    if MODEL_ID.get(a.model, "").startswith("local/") and a.workers <= 1:
        a.workers = 12
        print("[concurrent] local backbone %s -> --workers %d (continuous batching)" % (MODEL_ID[a.model], a.workers), flush=True)

    if a.cases:
        jobs = [(c.strip(), a.model, "on") for c in a.cases.split(",") if c.strip()]
    else:
        jobs = [(b, m, v) for (b, m, v) in MATRIX
                if (not a.only or a.only in variant_name(b, m, v))
                and (a.vision == "all" or v == a.vision)]
    print("[matrix] %d cells (filter=%r, workers=%d)" % (len(jobs), a.only, a.workers), flush=True)
    for b, m, v in jobs:
        vn = variant_name(b, m, v)
        state = "REUSE" if (has_paper(vn) and not a.force) else "run"
        print("   %-42s base=%-16s %-16s %-4s [%s]" % (vn, b, MODEL_ID[m], v, state), flush=True)
    if a.dry_run:
        return

    results = []
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        futs = [ex.submit(run_one, b, m, v, a.force) for (b, m, v) in jobs]
        for f in as_completed(futs):
            results.append(f.result())
    n_ok = sum(1 for r in results if r["status"] == "ok")
    n_re = sum(1 for r in results if r["status"] == "reuse")
    n_f = sum(1 for r in results if r["status"] == "FAILED")
    spent = sum(r.get("spend") or 0 for r in results)
    print("\n[matrix] done: %d ok, %d reused, %d FAILED | new spend ~$%.2f | ledger: %s"
          % (n_ok, n_re, n_f, spent, LEDGER), flush=True)
    if n_f:
        print("  FAILED:", [r["variant"] for r in results if r["status"] == "FAILED"], flush=True)

if __name__ == "__main__":
    main()
