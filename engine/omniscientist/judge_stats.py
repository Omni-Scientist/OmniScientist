#!/usr/bin/env python3
"""judge_stats.py -- validity of the LLM-judge panel (fills tab:eval-judge).

Reads every examples/<case>/stages/06_scores.json (written by score.py) and reports,
across the panel of judges:
  - inter-judge agreement    : Krippendorff's alpha (interval metric) on composite
  - judge vs human           : Spearman rho vs a human file if present (else n/a)
  - self-preference bias     : own-minus-others; 0 BY CONSTRUCTION here (judges share
                               no model family with the Sonnet/GPT backbones)
  - verbosity bias           : Spearman(score, paper length) -- should be ~0
Also prints per-judge mean+/-sd (surfaces e.g. the text-only judge's mm-grounding offset).

No external deps beyond numpy/scipy. Krippendorff alpha implemented inline (no pkg).
"""
import os, sys, json, glob, argparse
import numpy as np
from scipy import stats

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
EXAMPLES = os.path.join(ROOT, "examples")
DIMS = ["novelty", "soundness", "clarity", "significance", "reproducibility", "mm_grounding", "factual_accuracy"]

def krippendorff_alpha_interval(units):
    """units: list of per-item lists of numeric ratings (None allowed, omitted)."""
    us = [[x for x in u if x is not None] for u in units]
    us = [u for u in us if len(u) >= 2]
    n = sum(len(u) for u in us)
    if n < 2:
        return None
    Do = 0.0
    for u in us:
        m = len(u)
        s = sum((u[i] - u[j]) ** 2 for i in range(m) for j in range(i + 1, m))
        Do += (2.0 / (m - 1)) * s
    Do /= n
    allv = [x for u in us for x in u]
    N = len(allv)
    s = sum((allv[i] - allv[j]) ** 2 for i in range(N) for j in range(i + 1, N))
    De = (2.0 * s) / (N * (N - 1)) if N > 1 else 0.0
    if De == 0:
        return 1.0
    return 1.0 - Do / De

def load(csv_only=False):
    """case -> {judge -> composite, '_len'->paper chars}. Prefers score.py's eval_matrix.csv
    (authoritative, deduped) over globbing 06_scores.json, which can mix in stale re-scores."""
    import csv as _csv
    csvp = os.path.join(ROOT, "eval_matrix.csv")
    if os.path.exists(csvp):
        out = {}
        rows = list(_csv.DictReader(open(csvp)))
        judges = sorted({k[:-10] for r in rows for k in r
                         if k.endswith("_composite") and not k.startswith("panel")})
        for r in rows:
            rec = {}
            for j in judges:
                try:
                    rec[j] = float(r[j + "_composite"])
                except (TypeError, ValueError, KeyError):
                    pass
            tex = os.path.join(EXAMPLES, r["task"], "stages", "03_paper.tex")
            rec["_len"] = os.path.getsize(tex) if os.path.exists(tex) else 0
            if sum(1 for k in rec if not k.startswith("_")) >= 2:
                out[r["task"]] = rec
        return out
    out = {}
    for sp in sorted(glob.glob(os.path.join(EXAMPLES, "*", "stages", "06_scores.json"))):
        try:
            d = json.load(open(sp))
        except Exception:
            continue                                       # skip a file being written concurrently

        task = d.get("task") or os.path.basename(os.path.dirname(os.path.dirname(sp)))
        rec = {"_dims": {}}
        for j, v in d.get("judges", {}).items():
            if isinstance(v, dict) and not v.get("_failed") and v.get("composite") is not None:
                rec[j] = v["composite"]
                rec["_dims"][j] = {k: v.get(k) for k in DIMS}
        tex = os.path.join(EXAMPLES, task, "stages", "03_paper.tex")
        rec["_len"] = os.path.getsize(tex) if os.path.exists(tex) else 0
        if len(rec) > 2:
            out[task] = rec
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--human", help="optional JSON {case: human_composite} for Spearman rho")
    ap.add_argument("--out", default=os.path.join(ROOT, "judge_validity.json"))
    a = ap.parse_args()
    data = load()
    if not data:
        print("[judge_stats] no 06_scores.json yet"); return
    judges = sorted({j for r in data.values() for j in r if not j.startswith("_")})
    print("[judge_stats] %d papers, judges: %s" % (len(data), judges))

    # inter-judge Krippendorff alpha (composite)
    units = [[r.get(j) for j in judges] for r in data.values()]
    alpha = krippendorff_alpha_interval(units)

    # per-judge mean +/- sd, and pairwise correlations
    perjudge = {}
    for j in judges:
        vals = [r[j] for r in data.values() if j in r]
        perjudge[j] = {"mean": round(float(np.mean(vals)), 2), "sd": round(float(np.std(vals)), 2), "n": len(vals)}
    pair_rho = []
    for a_i in range(len(judges)):
        for b_i in range(a_i + 1, len(judges)):
            xj, yj = judges[a_i], judges[b_i]
            xs = [r[xj] for r in data.values() if xj in r and yj in r]
            ys = [r[yj] for r in data.values() if xj in r and yj in r]
            if len(xs) >= 3:
                pair_rho.append((xj, yj, round(float(stats.spearmanr(xs, ys).correlation), 2)))

    # verbosity bias: composite vs paper length
    comps = [np.mean([r[j] for j in judges if j in r]) for r in data.values()]
    lens = [r["_len"] for r in data.values()]
    verb = round(float(stats.spearmanr(comps, lens).correlation), 2) if len(comps) >= 3 else None

    # human anchor (optional)
    rho_h = None
    if a.human and os.path.exists(a.human):
        hj = json.load(open(a.human))
        keys = [k for k in data if k in hj]
        if len(keys) >= 3:
            pj = [np.mean([data[k][j] for j in judges if j in data[k]]) for k in keys]
            hh = [hj[k] for k in keys]
            rho_h = round(float(stats.spearmanr(pj, hh).correlation), 2)

    res = {"n_papers": len(data), "judges": judges,
           "krippendorff_alpha": round(alpha, 3) if alpha is not None else None,
           "per_judge": perjudge, "pairwise_spearman": pair_rho,
           "verbosity_bias_rho": verb, "self_preference": "0 by construction (judges disjoint from backbones)",
           "judge_vs_human_rho": rho_h}
    json.dump(res, open(a.out, "w"), indent=1)
    print(json.dumps(res, indent=1))
    print("[judge_stats] wrote", a.out)

if __name__ == "__main__":
    main()
