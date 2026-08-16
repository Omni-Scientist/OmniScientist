#!/usr/bin/env python3
"""blind_features.py -- build the STRONG-BLIND (scalar-baseline) arm of the perception ablation.

The blind arm NEVER sees the raw observation: it gets ONLY a table of generic, hand-computed
scalar features (one row per item) + the label, and must do its science on those. This is the
fair test of "does access to the raw observation help", and it operationalises the paper's own
'blind' framing (prior systems reason only on derived numbers).

Generation still uses the SAME new agentic framework: this only produces a data-block variant
examples/<case>__blind/ whose series.json carries a scalar-feature CSV instead of raw-file
members (so detect_modalities returns empty -> no perception tools, and there are no raw files
to Image.open). The numpy stat functions are inlined here -- ZERO dependency on the retired engine.

Usage: python scripts/blind_features.py <case> [--n 1500]
"""
import os, sys, json, csv, argparse
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
EX = os.path.join(ROOT, "examples")
LABEL_KEYS = ("label", "class", "target", "morph", "part_class", "plant", "species", "cell_line", "category")

# ---- inlined, domain-agnostic scalar feature extractors (one dict per item) ----
def _img_feats(path):
    from PIL import Image
    a = np.asarray(Image.open(path).convert("RGB"), dtype=float)
    g = 0.299 * a[..., 0] + 0.587 * a[..., 1] + 0.114 * a[..., 2]
    gy, gx = np.gradient(g / 255.0)
    return {"brightness": g.mean() / 255, "contrast": g.std() / 255,
            "edge_density": float((gx ** 2 + gy ** 2).var()),
            "mean_R": a[..., 0].mean() / 255, "mean_G": a[..., 1].mean() / 255, "mean_B": a[..., 2].mean() / 255,
            "colorfulness": float(np.std(a[..., 0] - a[..., 1]) + np.std(a[..., 1] - a[..., 2])) / 255,
            "saturation": float((a.max(-1) - a.min(-1)).mean()) / 255}

def _wave_feats(ch, tag):
    ch = np.asarray(ch, dtype=float); ch = ch - ch.mean()
    sd = ch.std() + 1e-9
    F = np.abs(np.fft.rfft(ch)); F = F / (F.sum() + 1e-9); n = len(F)
    return {tag + "_rms": float(np.sqrt((ch ** 2).mean())), tag + "_peak": float(np.abs(ch).max()),
            tag + "_std": float(ch.std()), tag + "_zcr": float((np.diff(np.sign(ch)) != 0).mean()),
            tag + "_kurtosis": float(((ch / sd) ** 4).mean()),
            tag + "_band_lo": float(F[:n // 4].sum()), tag + "_band_mid": float(F[n // 4:n // 2].sum()),
            tag + "_band_hi": float(F[n // 2:].sum())}

def _sig_feats(path):
    a = np.load(path).astype(float)
    if a.ndim == 1:
        a = a[None, :]
    if a.shape[0] > a.shape[1]:
        a = a.T                                             # -> (channels, time)
    out = {}
    for i, ch in enumerate(a[:3]):
        out.update(_wave_feats(ch, "ch%d" % i))
    return out

def _audio_feats(path):
    from scipy.io import wavfile
    sr, a = wavfile.read(path); a = a.astype(float)
    if a.ndim > 1:
        a = a.mean(1)
    return {**_wave_feats(a, "sig"), "sample_rate": float(sr), "duration_s": round(len(a) / (sr + 1e-9), 3)}

def _3d_feats(path):
    pts = np.loadtxt(path, max_rows=8192)
    pts = np.atleast_2d(pts)[:, :3].astype(float)
    c = pts.mean(0); p = pts - c
    ext = pts.max(0) - pts.min(0)
    ev = np.sort(np.linalg.eigvalsh(np.cov(p.T) + 1e-9 * np.eye(3)))[::-1]
    s = ev.sum() + 1e-9
    return {"n_pts": len(pts), "bbox_x": float(ext[0]), "bbox_y": float(ext[1]), "bbox_z": float(ext[2]),
            "extent_ratio": float(ext.max() / (ext.min() + 1e-9)),
            "pca1": float(ev[0]), "pca2": float(ev[1]), "pca3": float(ev[2]),
            "linearity": float((ev[0] - ev[1]) / s), "planarity": float((ev[1] - ev[2]) / s),
            "sphericity": float(ev[2] / s), "spread": float(np.sqrt((p ** 2).sum(1)).mean())}

EXT2FEAT = {".png": _img_feats, ".jpg": _img_feats, ".jpeg": _img_feats,
            ".npy": _sig_feats, ".wav": _audio_feats, ".flac": _audio_feats,
            ".xyz": _3d_feats, ".txt": _3d_feats, ".pts": _3d_feats}

def _label(m):
    for k in LABEL_KEYS:
        if m.get(k) not in (None, ""):
            return str(m[k])
    return "unlabelled"

def build(case, n=1500):
    base = os.path.join(EX, case)
    d = json.load(open(os.path.join(base, "series.json")))
    members = d.get("members") or []
    if not members:
        print("[blind] %s has no members (already tabular?) -- skip" % case); return None
    ext = os.path.splitext(members[0].get("file", ""))[1].lower()
    feat_fn = EXT2FEAT.get(ext)
    if feat_fn is None:
        print("[blind] %s: no feature extractor for %s" % (case, ext)); return None
    # even subsample across the item list (keeps class balance roughly)
    step = max(1, len(members) // n)
    sub = members[::step][:n]
    rows, cols = [], None
    for m in sub:
        fp = os.path.join(base, m["file"])
        if not os.path.exists(fp):
            continue
        try:
            feats = feat_fn(fp)
        except Exception as e:
            continue
        feats = {k: (round(v, 6) if isinstance(v, float) else v) for k, v in feats.items()}
        feats["label"] = _label(m)
        rows.append(feats)
        cols = cols or list(feats.keys())
    if len(rows) < 20:
        print("[blind] %s: only %d rows extracted -- abort" % (case, len(rows))); return None

    vdir = os.path.join(EX, case + "__blind")
    os.makedirs(os.path.join(vdir, "data"), exist_ok=True)
    csvp = os.path.join(vdir, "data", "features.csv")
    with open(csvp, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols); w.writeheader()
        for r in rows:
            w.writerow(r)
    # blind variant series.json = data block only (no members -> no perception, no raw files)
    labels = sorted({r["label"] for r in rows})
    nfeat = len(cols) - 1
    summary = ("BLIND SCALAR BASELINE. You are given ONLY %d generic hand-computed scalar features per item "
               "(FEATURES_CSV: %d rows x %d numeric features + 'label'); you do NOT have and cannot open the "
               "raw observation (the %s files were withheld on purpose). Do the science from these scalars alone. "
               "Label values: %s." % (nfeat, len(rows), nfeat, ext, ", ".join(labels[:12])))
    blind = {"role": d.get("role", "a researcher"), "subject": d.get("subject", "item"),
             "property": d.get("property", "a property"),
             "request": ("Using ONLY the precomputed scalar features (you cannot see the raw observation), "
                         "investigate " + str(d.get("subject", "the items")) + " and their " +
                         str(d.get("property", "measured property")) + "."),
             "style_of": d.get("style_of") or d.get("style"),
             "data": {"n_items": len(rows), "files": {"FEATURES_CSV": "data/features.csv"},
                      "schema": "FEATURES_CSV: %d rows x %d numeric scalar features + 'label' (%d classes)." % (
                          len(rows), nfeat, len(labels)),
                      "summary": summary}}
    json.dump(blind, open(os.path.join(vdir, "series.json"), "w"), indent=1)
    print("[blind] %s -> %s  (%d items x %d scalar feats, %d labels)" % (case, vdir, len(rows), nfeat, len(labels)))
    return vdir

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cases", nargs="+")
    ap.add_argument("--n", type=int, default=1500)
    a = ap.parse_args()
    for c in a.cases:
        build(c, a.n)

if __name__ == "__main__":
    main()
