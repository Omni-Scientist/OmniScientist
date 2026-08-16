# -*- coding: utf-8 -*-
"""EVIDENCE layer: turn any kind of scientific EVIDENCE into something the agent can reason over.

Four categories of evidence (NOT all "perception" -- only category 1 is):
  1. PERCEPTUAL  (image / micrograph / astro / medical / video / audio / spectrum / 3D / radar / LiDAR):
     raw, not-yet-symbolised observations -> need a PERCEIVER model. This is the multimodal moat.
  2. STRUCTURED  (table / curve / loss / scaling-law / ablation table / time-series / sensor data):
     already numeric -> read structure + native numeric analysis (NOT a picture; render is an optional gestalt).
  3. SYMBOLIC    (paper / formula / code / protocol / LaTeX / molecule(SMILES) / review):
     language/math/code -> read it + EXECUTE / VERIFY with specialist tools (sympy, RDKit, code runner).
  4. PROCEDURAL  (experiment trace / agent trace / tool-call sequence / simulation log / failure loop):
     sequences -> read the trace + find patterns.

Every category has a GENERAL default AND pluggable SPECIALISTS: a general VLM/LLM is the default, but a
specialist overrides where it is more reliable (a domain perceiver for a micrograph, RDKit for a 200-char
SMILES the LLM would mis-parse, sympy for an exact derivation). "perception"/PERCEIVER now name ONLY the
category-1 mechanism, not the whole module.

    tools  = evidence.tool_schemas(modalities)            # OpenAI tool schemas for the present modalities
    result = evidence.run(name, args, state, log, td, by_file)   # executor (shared by all stages)
    mods   = evidence.detect_modalities(members)          # infer modalities from member file extensions
"""
import os, json, glob
import pipeline
from pipeline import img_block

_RDIR = "/tmp/mmsci_perception"                            # where rendered pngs go

EXT2MOD = {
    ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image", ".bmp": "image",
    ".tif": "image", ".tiff": "image", ".webp": "image",
    ".csv": "table", ".tsv": "table", ".parquet": "table", ".xlsx": "table",
    ".wav": "audio", ".flac": "audio", ".mp3": "audio", ".ogg": "audio",
    ".mp4": "video", ".avi": "video", ".mov": "video", ".mkv": "video", ".webm": "video",
    ".xyz": "threeD", ".ply": "threeD", ".obj": "threeD", ".off": "threeD", ".npy": "signal",
    ".txt": "text", ".md": "text", ".log": "text", ".py": "text", ".r": "text",
    ".smi": "molecule", ".smiles": "molecule", ".mol": "molecule", ".tex": "symbolic",
    ".json": "trace",                                      # agent/run trace (procedural)
}
CATEGORY = {"image": "perceptual", "audio": "perceptual", "video": "perceptual", "threeD": "perceptual",
            "table": "structured", "signal": "structured",
            "text": "symbolic", "molecule": "symbolic", "symbolic": "symbolic",
            "trace": "procedural"}

# pluggable PERCEIVER routing (CATEGORY 1 only). default = general VLM; register specialists per domain.
PERCEIVERS = {"default": "claude-sonnet-5"}               # e.g. {"pathology": uni_fn, "radar": radar_fn}
PERCEIVER = PERCEIVERS["default"]                          # back-compat alias


def register_perceiver(domain, model_or_fn):
    PERCEIVERS[domain] = model_or_fn                       # specialist override for a perceptual domain


def detect_modalities(members):
    # a member may declare an explicit `modality` (canonical value: image/audio/video/threeD/
    # table/signal/text/molecule/symbolic/trace) which OVERRIDES the extension guess -- robust when
    # one extension (e.g. .npy = signal OR point cloud) is ambiguous. falls back to EXT2MOD if absent.
    mods = set()
    for m in members or []:
        explicit = m.get("modality")
        if explicit:
            mods.add(explicit); continue
        ext = os.path.splitext(str(m.get("file", "")))[1].lower()
        mods.add(EXT2MOD.get(ext, "image" if ext else None))
    mods.discard(None)
    return mods or {"image"}


# ---------------------------------------------------------------- helpers
def _resolve(fid, td, by_file):
    m = (by_file or {}).get(str(fid))
    p = os.path.join(td, m["file"]) if m else os.path.join(td, str(fid))
    return p if os.path.exists(p) else None


def _vlm(png, question, mt=350):
    return (pipeline.chat([{"type": "text", "text": question}, img_block(png)], PERCEIVER, mt) or "").strip()


def _render(plot_fn, tag):
    """plot_fn(ax) draws onto a matplotlib axes; returns a saved png path (the render bridge)."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    os.makedirs(_RDIR, exist_ok=True)
    out = os.path.join(_RDIR, "r_%s.png" % abs(hash(tag)))
    fig = plt.figure(figsize=(6, 4))
    plot_fn(fig)
    fig.tight_layout()
    fig.savefig(out, dpi=85)
    plt.close(fig)
    return out


def _load_series(path):
    """Load a 1D/2D numeric signal from .csv/.txt/.npy -> numpy array."""
    import numpy as np
    ext = os.path.splitext(path)[1].lower()
    if ext == ".npy":
        return np.load(path)
    if ext in (".csv", ".tsv", ".txt"):
        import pandas as pd
        sep = "\t" if ext == ".tsv" else (None if ext == ".txt" else ",")
        try:
            df = pd.read_csv(path, sep=sep, engine="python")
            return df.select_dtypes("number")
        except Exception:
            return np.loadtxt(path)
    raise ValueError("unsupported series file: " + ext)


_EXEMPLAR_CAP = {
    "image":  "Representative raw input images (one per class where available). Every downstream feature is computed "
              "from images like these.",
    "audio":  "Log-frequency spectrograms of representative raw audio clips (one per class where available). The "
              "spectro-temporal features are computed from time-frequency content like this.",
    "signal": "Representative raw multi-channel signals, one panel per example. All features are derived from waveform "
              "structure like this.",
    "threeD": "Orthographic (XY) projections of representative raw 3D point clouds (one per class where available). "
              "Shape descriptors are computed from geometry like this.",
    "video":  "Representative sampled frames of the raw video input.",
}


def exemplar_figure(td, members, out_path, n=4):
    """Render up to n representative RAW members (spanning labels) into ONE composite figure that SHOWS the actual
    perception modality -- X-ray/micrograph (image), spectrogram (audio), waveform (signal), point cloud (3D). Returns
    (out_path, caption, modality) or None (no perception modality present, or nothing renderable). Stage 3 inserts this
    as the paper's data-exemplar figure so a 'multimodal' paper actually shows its perception input, not only scalars."""
    import os
    membs = [m for m in (members or []) if isinstance(m, dict) and m.get("file")]
    if not membs:
        return None
    mod = next((m for m in ("image", "threeD", "audio", "signal", "video") if m in detect_modalities(membs)), None)
    if not mod:
        return None
    def _lab(m):
        return str(m.get("label", m.get("class", m.get("y", "")))).strip()
    picks, seen = [], set()
    for m in membs:                                   # diversify by label first, then top up
        l = _lab(m)
        if l and l not in seen:
            picks.append(m); seen.add(l)
        if len(picks) >= n:
            break
    for m in membs:
        if len(picks) >= n:
            break
        if m not in picks:
            picks.append(m)
    picks = picks[:n]
    import numpy as np
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    def _draw(ax, path):
        if mod == "image":
            from PIL import Image
            im = Image.open(path)
            ax.imshow(np.asarray(im), cmap="gray" if im.mode in ("L", "I", "I;16", "1") else None)
            ax.set_xticks([]); ax.set_yticks([])
        elif mod == "threeD":
            ext = os.path.splitext(path)[1].lower()
            pts = (np.load(path) if ext == ".npy"
                   else np.loadtxt(path)[:, :3] if ext == ".xyz" else _read_ply_xyz(path))
            pts = np.asarray(pts)[:, :3]
            ax.scatter(pts[:, 0], pts[:, 1], s=0.4); ax.set_aspect("equal", "box")
            ax.set_xticks([]); ax.set_yticks([])
        elif mod == "audio":
            from scipy.io import wavfile
            sr, y = wavfile.read(path); y = (y.mean(axis=1) if y.ndim == 2 else y).astype(float)
            ax.specgram(y, Fs=sr); ax.set_ylabel("Hz", fontsize=7); ax.set_xlabel("s", fontsize=7)
        elif mod == "signal":
            a = _load_series(path); a = a.values if hasattr(a, "values") else np.asarray(a)
            a = a if a.ndim == 2 else a.reshape(-1, 1)
            if a.shape[0] < a.shape[1]:
                a = a.T
            step = max(1, a.shape[0] // 3000)
            for j in range(min(a.shape[1], 3)):
                ax.plot(a[::step, j], lw=0.5)
            ax.set_xlabel("sample", fontsize=7)
        elif mod == "video":
            import imageio.v3 as iio
            ax.imshow(np.asarray(next(iter(iio.imiter(path))))); ax.set_xticks([]); ax.set_yticks([])

    k = len(picks)
    if mod in ("audio", "signal"):
        fig, axes = plt.subplots(k, 1, figsize=(6.4, 1.7 * k), squeeze=False)
    else:
        nc = 1 if k == 1 else 2
        fig, axes = plt.subplots((k + nc - 1) // nc, nc, figsize=(3.1 * nc, 3.1 * ((k + nc - 1) // nc)), squeeze=False)
    axes = axes.ravel()
    drawn = 0
    for i, m in enumerate(picks):
        path = os.path.join(td, str(m["file"]))
        if not os.path.exists(path):
            axes[i].axis("off"); continue
        try:
            _draw(axes[i], path)
            if _lab(m):
                axes[i].set_title(_lab(m), fontsize=9)
            drawn += 1
        except Exception:
            axes[i].text(0.5, 0.5, "(render failed)", ha="center", va="center", fontsize=8); axes[i].axis("off")
    for j in range(len(picks), len(axes)):
        axes[j].axis("off")
    if not drawn:
        plt.close(fig); return None
    fig.tight_layout()
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    fig.savefig(out_path, dpi=115); plt.close(fig)
    return out_path, _EXEMPLAR_CAP.get(mod, "Representative raw input data."), mod


def draw_pipeline(stages, out_path):
    """Draw a simple left-to-right method schematic (rounded boxes + arrows) from 2-5 short stage labels. Returns
    out_path or None. Used by stage 3 as the paper's 'overview of the method' figure (the model/structure diagram)."""
    stages = [str(s).strip() for s in (stages or []) if str(s).strip()][:5]
    if len(stages) < 2:
        return None
    import textwrap
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import matplotlib.patches as mpatches
    n = len(stages)
    fig, ax = plt.subplots(figsize=(min(2.5 * n, 12.5), 1.9))
    ax.set_xlim(0, n); ax.set_ylim(0, 1); ax.axis("off")
    bw, gap = 0.86, 0.14
    for i, s in enumerate(stages):
        x0 = i + gap / 2
        ax.add_patch(mpatches.FancyBboxPatch((x0, 0.30), bw, 0.44,
                     boxstyle="round,pad=0.015,rounding_size=0.05", fc="#eef3fb", ec="#3b6fb0", lw=1.4))
        ax.text(i + 0.5, 0.52, "\n".join(textwrap.wrap(s, 16)), ha="center", va="center", fontsize=9)
        if i < n - 1:
            ax.annotate("", xy=(i + 1 + gap / 2, 0.52), xytext=(x0 + bw, 0.52),
                        arrowprops=dict(arrowstyle="-|>", color="#3b6fb0", lw=1.5))
    fig.tight_layout()
    import os as _os
    _os.makedirs(_os.path.dirname(out_path) or ".", exist_ok=True)
    fig.savefig(out_path, dpi=150, bbox_inches="tight"); plt.close(fig)
    return out_path


# ---------------------------------------------------------------- per-modality perceive functions
def _p_image(args, td, by_file, state, log):
    files = args.get("files") or []
    files = [files] if isinstance(files, str) else files
    q = args.get("question") or "What is scientifically notable in this image?"
    out = []
    for fid in files[:4]:
        if state["img_used"] >= state["img_budget"]:
            out.append("(image budget reached -- only characterize items/classes you ACTUALLY viewed; do NOT "
                       "describe groups you did not see)"); break
        p = _resolve(fid, td, by_file)
        if not p:
            out.append("%s: NOT FOUND" % fid); continue
        ans = _vlm(p, q)[:600]
        m = (by_file or {}).get(str(fid)) or {}
        given = {k: v for k, v in m.items() if k != "file"}           # the item's GIVEN metadata (labels etc.)
        gtxt = ((" | GIVEN metadata for this item: %s. RECONCILE your visual read with this: if they DISAGREE, "
                 "do NOT trust the read -- flag the mismatch, re-check the id/label mapping, and lower confidence. "
                 "Never name a category outside the given label space."
                 % json.dumps(given, ensure_ascii=False)) if given else "")
        out.append("%s: %s%s" % (fid, ans, gtxt)); state["img_used"] += 1
    log("  [tool] look_at_image x%d (used=%d/%d)" % (len(files), state["img_used"], state["img_budget"]))
    return "\n".join(out)


def _p_table(args, td, by_file, state, log):
    import pandas as pd
    p = _resolve(args.get("file"), td, by_file)
    if not p:
        return "table NOT FOUND"
    try:
        df = pd.read_parquet(p) if p.endswith(".parquet") else pd.read_csv(p, sep=None, engine="python")
    except Exception as e:
        return "could not read table: %s" % e
    log("  [tool] look_at_table %s (%dx%d)" % (os.path.basename(p), df.shape[0], df.shape[1]))
    head = df.head(8).to_string()[:1500]
    desc = df.describe(include="all").to_string()[:1500]
    return "shape=%s\ncolumns/dtypes:\n%s\n\nhead:\n%s\n\nsummary:\n%s" % (
        df.shape, df.dtypes.to_string()[:600], head, desc)


def _p_signal(args, td, by_file, state, log):
    """Curve / time-series / spectrum / loss: render to a line plot, VLM perceives its SHAPE."""
    if state["img_used"] >= state["img_budget"]:
        return "(image budget reached)"
    import numpy as np
    p = _resolve(args.get("file"), td, by_file)
    if not p:
        return "signal NOT FOUND"
    try:
        arr = _load_series(p)
        v = arr.values if hasattr(arr, "values") else np.asarray(arr)
    except Exception as e:
        return "could not load signal: %s" % e
    cols = list(getattr(arr, "columns", []))

    def _mono(c):
        d = np.diff(c); d = d[np.abs(d) > 1e-12]
        return (max((d > 0).sum(), (d < 0).sum()) / d.size) if d.size else 1.0

    def draw(fig):
        if v.ndim >= 3:                                    # multi-dim field -> axis-0 profile (not a dense ravel)
            a = v.reshape(v.shape[0], -1).mean(axis=1).reshape(-1, 1)
        else:
            a = v if v.ndim == 2 else v.reshape(-1, 1)
        if a.shape[0] < a.shape[1] and (a.shape[0] <= 16 or a.shape[1] >= 4 * a.shape[0]):   # (channels, samples) -> time on x
            a = a.T
        if a.shape[1] == 2:                                # x-y spectrum/curve: one monotonic axis + a value column
            m = [_mono(a[:, 0]), _mono(a[:, 1])]
            if max(m) >= 0.98 and min(m) < 0.9:            # plot the value against its axis (not two parallel lines)
                xi, yi = int(np.argmax(m)), int(np.argmin(m))
                ax = fig.add_subplot(111)
                ax.plot(a[:, xi], a[:, yi], lw=0.7)
                ax.set_xlabel(str(cols[xi]) if len(cols) == 2 else "axis", fontsize=8)
                ax.set_ylabel(str(cols[yi]) if len(cols) == 2 else "value", fontsize=8)
                ax.set_title(os.path.basename(p), fontsize=9)
                return
        n, nch = a.shape[0], min(a.shape[1], 8)
        step = max(1, n // 4000)                           # downsample very long series so the shape stays legible
        x = np.arange(0, n, step)
        named = len(cols) == a.shape[1]                    # column names only valid if they match the plotted axis
        if nch > 1:                                        # multi-channel: stack one panel per channel (real waveform view)
            for j in range(nch):
                ax = fig.add_subplot(nch, 1, j + 1)
                ax.plot(x, a[::step, j], lw=0.6)
                ax.set_ylabel(str(cols[j]) if named else "ch%d" % j, fontsize=8)
                if j == 0:
                    ax.set_title("%s  (%d channels x %d samples)" % (os.path.basename(p), a.shape[1], n), fontsize=9)
                if j < nch - 1:
                    ax.set_xticklabels([])
            ax.set_xlabel("sample index", fontsize=8)
        else:
            ax = fig.add_subplot(111)
            ax.plot(x, a[::step, 0], lw=0.7)
            ax.set_xlabel("sample / bin index", fontsize=8); ax.set_title(os.path.basename(p), fontsize=9)
    png = _render(draw, p)
    q = args.get("question") or ("This is a rendered line plot of a real 1D/multichannel signal (time series, "
                                 "waveform, or spectrum). Describe its SHAPE per channel: baseline vs transient bursts, "
                                 "oscillation, envelope, peaks, onset, change-points, and anything scientifically "
                                 "notable. If the plot looks like only a few points or is empty, say the render failed "
                                 "rather than inventing structure.")
    state["img_used"] += 1
    log("  [tool] look_at_signal %s (used=%d/%d)" % (os.path.basename(p), state["img_used"], state["img_budget"]))
    return "rendered %s -> %s" % (os.path.basename(p), _vlm(png, q, 400)[:700])


def _p_audio(args, td, by_file, state, log):
    """Audio: render waveform + log-spectrogram, VLM perceives texture/structure."""
    if state["img_used"] >= state["img_budget"]:
        return "(image budget reached)"
    import numpy as np
    p = _resolve(args.get("file"), td, by_file)
    if not p:
        return "audio NOT FOUND"
    try:
        from scipy.io import wavfile
        sr, y = wavfile.read(p)
        y = y.mean(axis=1) if y.ndim == 2 else y
        y = y.astype(float)
    except Exception as e:
        return "audio read needs a WAV (scipy.io.wavfile) -- could not read %s: %s" % (os.path.basename(p), e)

    def draw(fig):
        ax1 = fig.add_subplot(211); ax1.plot(y[:: max(1, len(y) // 4000)]); ax1.set_title("waveform")
        ax2 = fig.add_subplot(212); ax2.specgram(y, Fs=sr); ax2.set_title("spectrogram")
    png = _render(draw, p)
    q = args.get("question") or "Describe this audio's structure from its waveform and spectrogram."
    state["img_used"] += 1
    log("  [tool] look_at_audio %s (sr=%s)" % (os.path.basename(p), sr))
    return "rendered audio %s -> %s" % (os.path.basename(p), _vlm(png, q, 400)[:700])


def _p_video(args, td, by_file, state, log):
    """Video: sample frames, VLM looks at them (motion/scene perception)."""
    p = _resolve(args.get("file"), td, by_file)
    if not p:
        return "video NOT FOUND"
    try:
        import imageio.v3 as iio
        import numpy as np
        from PIL import Image
        n = max(int(args.get("n_frames", 3)), 1)
        os.makedirs(_RDIR, exist_ok=True)
        allf = []                                          # materialise (short scientific clips) -> robust to
        for fr in iio.imiter(p):                           # unknown/inf meta nframes, and lets us spread over TIME
            allf.append(fr)
            if len(allf) >= 600:
                break
        if not allf:
            return "video has no readable frames: %s" % os.path.basename(p)
        idxs = sorted(set(int(i) for i in np.linspace(0, len(allf) - 1, min(n, len(allf)))))
        q = args.get("question") or "Describe what these video frames show and any change across them (temporal dynamics)."
        out = []
        for k in idxs:
            if state["img_used"] >= state["img_budget"]:
                break
            fp = os.path.join(_RDIR, "vf_%s_%d.png" % (abs(hash(p)), k))
            Image.fromarray(np.asarray(allf[k])).save(fp)
            out.append("frame %d/%d: %s" % (k, len(allf), _vlm(fp, q)[:400])); state["img_used"] += 1
        log("  [tool] look_at_video %s (%d of %d frames)" % (os.path.basename(p), len(out), len(allf)))
        return "\n".join(out) or "no frames sampled"
    except Exception as e:
        return "video perception needs imageio + a readable codec -- failed on %s: %s" % (os.path.basename(p), e)


def _p_3d(args, td, by_file, state, log):
    """3D point cloud / mesh: render orthographic projections, VLM perceives geometry."""
    if state["img_used"] >= state["img_budget"]:
        return "(image budget reached)"
    import numpy as np
    p = _resolve(args.get("file"), td, by_file)
    if not p:
        return "3D file NOT FOUND"
    ext = os.path.splitext(p)[1].lower()
    try:
        if ext == ".npy":
            arr = np.load(p)
            if arr.ndim == 3:                               # dense voxel VOLUME (D,H,W), not a point cloud
                return _p_volume(arr, p, args, state, log)
            pts = arr
        elif ext == ".xyz":
            pts = np.loadtxt(p)[:, :3]
        elif ext == ".ply":
            pts = _read_ply_xyz(p)
        else:
            return "3D format %s not supported without trimesh; export to .xyz/.npy/.ply point cloud" % ext
        pts = np.asarray(pts)[:, :3]
    except Exception as e:
        return "could not load 3D points: %s" % e

    def draw(fig):
        for i, (a, b, name) in enumerate([(0, 1, "XY"), (0, 2, "XZ"), (1, 2, "YZ")]):
            ax = fig.add_subplot(1, 3, i + 1); ax.scatter(pts[:, a], pts[:, b], s=1); ax.set_title(name)
            ax.set_aspect("equal", "box")
    png = _render(draw, p)
    q = args.get("question") or "Describe the 3D geometry/shape from these XY/XZ/YZ projections."
    state["img_used"] += 1
    log("  [tool] look_at_3d %s (%d pts)" % (os.path.basename(p), len(pts)))
    return "rendered 3D %s -> %s" % (os.path.basename(p), _vlm(png, q, 400)[:700])


def _p_volume(vol, p, args, state, log):
    """Dense 3D voxel volume: render 3 orthogonal centre slices + 3 max-intensity projections; VLM perceives structure."""
    if state["img_used"] >= state["img_budget"]:
        return "(image budget reached)"
    import numpy as np
    v = np.asarray(vol, float)
    D, H, W = v.shape[:3]

    def draw(fig):
        views = [("slice z=%d" % (D // 2), v[D // 2]), ("slice y=%d" % (H // 2), v[:, H // 2]),
                 ("slice x=%d" % (W // 2), v[:, :, W // 2]),
                 ("MIP z", v.max(0)), ("MIP y", v.max(1)), ("MIP x", v.max(2))]
        for i, (name, im) in enumerate(views):
            ax = fig.add_subplot(2, 3, i + 1); ax.imshow(im, cmap="gray"); ax.set_title(name, fontsize=8)
            ax.set_xticks([]); ax.set_yticks([])
    png = _render(draw, p)
    q = args.get("question") or ("This is a dense 3D voxel volume shown as three orthogonal centre slices (top row) "
                                 "and three max-intensity projections (bottom row). Describe the 3D structure: overall "
                                 "shape, internal texture, connectivity/porosity, boundaries, symmetry, and anything "
                                 "scientifically notable. If it looks blank, say the render failed rather than inventing "
                                 "structure.")
    state["img_used"] += 1
    log("  [tool] look_at_3d %s (volume %dx%dx%d)" % (os.path.basename(p), D, H, W))
    return "rendered 3D volume %s -> %s" % (os.path.basename(p), _vlm(png, q, 400)[:700])


def _read_ply_xyz(path):
    import numpy as np
    lines = open(path, "rb").read().split(b"\n")
    i = next((k for k, l in enumerate(lines) if l.strip() == b"end_header"), 0) + 1
    pts = []
    for l in lines[i:]:
        s = l.split()
        if len(s) >= 3:
            try:
                pts.append([float(s[0]), float(s[1]), float(s[2])])
            except Exception:
                break
    return np.array(pts)


# ---------------------------------------------------------------- NATIVE analysis (numbers/text, NOT images)
def _a_signal(args, td, by_file, state, log):
    """Native numeric features of a 1D signal -- NOT a picture (FFT peaks, trend, change). Use run_python for more."""
    import numpy as np
    p = _resolve(args.get("file"), td, by_file)
    if not p:
        return "signal NOT FOUND"
    try:
        arr = _load_series(p)
        v = np.asarray(arr.values if hasattr(arr, "values") else arr, float)
    except Exception as e:
        return "could not load signal: %s" % e
    if v.ndim >= 3:                                        # a multi-dim field (e.g. a PDE snapshot) -> axis-0 profile, not a garbage ravel
        v = v.reshape(v.shape[0], -1).mean(axis=1)
    if v.ndim == 2 and v.shape[1] == 0:
        return "signal has no numeric columns to analyze"
    # (channels, samples) with few channels OR a much longer sample axis -> transpose so time is on axis 0 (ratio test
    # also catches >16-channel EEG/MEG that the plain <=16 cap would miss)
    if v.ndim == 2 and v.shape[0] < v.shape[1] and (v.shape[0] <= 16 or v.shape[1] >= 4 * v.shape[0]):
        v = v.T
    if v.ndim == 2 and v.shape[1] >= 2:
        # pick the VALUE column, not a monotonic independent axis (wavenumber / wavelength / time / index). The axis
        # is (near-)monotonic; the measured signal is not. Only override col-0 when a clear axis+value pair exists.
        def _mono(c):
            d = np.diff(c); d = d[np.abs(d) > 1e-12]
            return (max((d > 0).sum(), (d < 0).sum()) / d.size) if d.size else 1.0
        sc = [_mono(v[:, j]) for j in range(min(v.shape[1], 12))]
        x = v[:, int(np.argmin(sc))] if (max(sc) >= 0.98 and min(sc) < 0.9) else v[:, 0]
    elif v.ndim == 2:
        x = v[:, 0]
    else:
        x = v.ravel()
    n = len(x)
    if n == 0:
        return "signal is empty"
    out = {"n": n, "mean": round(float(np.mean(x)), 4), "std": round(float(np.std(x)), 4),
           "min": round(float(np.min(x)), 4), "max": round(float(np.max(x)), 4),
           "first": round(float(x[0]), 4), "last": round(float(x[-1]), 4),
           "net_change": round(float(x[-1] - x[0]), 4)}
    try:
        out["trend_slope"] = round(float(np.polyfit(np.arange(n), x, 1)[0]), 6)
    except Exception:
        pass
    try:
        from numpy.fft import rfft, rfftfreq
        sp = np.abs(rfft(x - x.mean())); fr = rfftfreq(n)
        out["dominant_freqs"] = [round(float(f), 4) for f in fr[np.argsort(sp)[-3:][::-1]]]
    except Exception:
        pass
    try:
        from scipy.signal import find_peaks
        out["n_peaks"] = int(len(find_peaks(x)[0]))
    except Exception:
        pass
    log("  [tool] analyze_signal %s" % os.path.basename(p))
    return "native signal features: " + json.dumps(out)


def _a_audio(args, td, by_file, state, log):
    """Native audio features (spectral centroid, dominant freq, RMS...). NOT a picture. ASR needs a model."""
    import numpy as np
    p = _resolve(args.get("file"), td, by_file)
    if not p:
        return "audio NOT FOUND"
    try:
        from scipy.io import wavfile
        sr, y = wavfile.read(p)
        y = (y.mean(axis=1) if y.ndim == 2 else y).astype(float)
    except Exception as e:
        return "native audio analysis needs a WAV (scipy.io.wavfile): %s" % e
    n = len(y)
    cen = dom = None
    try:
        from numpy.fft import rfft, rfftfreq
        sp = np.abs(rfft(y)); fr = rfftfreq(n, 1.0 / sr)
        cen = float(np.sum(fr * sp) / (np.sum(sp) + 1e-9)); dom = float(fr[np.argmax(sp)])
    except Exception:
        pass
    out = {"duration_s": round(n / sr, 3), "sample_rate": int(sr), "rms": round(float(np.sqrt(np.mean(y ** 2))), 3),
           "spectral_centroid_hz": round(cen, 1) if cen else None, "dominant_freq_hz": round(dom, 1) if dom else None,
           "zero_crossing_rate": round(float(np.mean(np.abs(np.diff(np.sign(y))) > 0)), 4),
           "note": "audio->text (ASR) needs a speech model, not installed; these are spectral features, "
                   "or render look_at_audio for the spectrogram"}
    log("  [tool] analyze_audio %s" % os.path.basename(p))
    return "native audio features: " + json.dumps(out)


def _a_video(args, td, by_file, state, log):
    """Native video features (frame count, fps, motion). True captioning needs a video model."""
    import numpy as np
    p = _resolve(args.get("file"), td, by_file)
    if not p:
        return "video NOT FOUND"
    try:
        import imageio.v3 as iio
        meta = iio.immeta(p)
        prev, diffs, shape, k = None, [], None, 0
        for fr in iio.imiter(p):
            g = np.asarray(fr, float)
            shape = list(g.shape)
            g = g.mean(-1) if g.ndim == 3 else g
            if prev is not None:
                diffs.append(float(np.mean(np.abs(g - prev))))
            prev = g; k += 1
            if k >= 60:
                break
        try:
            nfm = int(meta.get("nframes", 0) or 0)             # some mp4s report nframes=inf -> int() overflows
        except (OverflowError, ValueError, TypeError):
            nfm = None
        out = {"n_frames_read": k, "n_frames_meta": nfm, "fps": meta.get("fps"),
               "frame_shape": shape, "mean_frame_motion": round(float(np.mean(diffs)), 3) if diffs else None,
               "note": "true video captioning needs a video model; this is metadata + frame-diff motion. "
                       "Use look_at_video for visual frames."}
        log("  [tool] analyze_video %s" % os.path.basename(p))
        return "native video features: " + json.dumps(out)
    except Exception as e:
        return "native video analysis failed: %s" % e


def _a_3d(args, td, by_file, state, log):
    """Native 3D geometry (bbox, centroid, extent, PCA axes). NOT a picture."""
    import numpy as np
    p = _resolve(args.get("file"), td, by_file)
    if not p:
        return "3D NOT FOUND"
    ext = os.path.splitext(p)[1].lower()
    try:
        if ext == ".npy":
            arr = np.load(p)
            if arr.ndim == 3:                               # dense voxel VOLUME, not a point cloud
                return _a_volume(arr, p, log)
            pts = arr
        else:
            pts = np.loadtxt(p)[:, :3] if ext == ".xyz" else _read_ply_xyz(p)
        pts = np.asarray(pts)[:, :3]
    except Exception as e:
        return "could not load 3D points: %s" % e
    mn, mx, c = pts.min(0), pts.max(0), pts.mean(0)
    try:
        ev = np.sort(np.linalg.eigvalsh(np.cov((pts - c).T)))[::-1]
        axes = [round(float(e), 4) for e in ev]
    except Exception:
        axes = None
    out = {"n_points": int(len(pts)), "bbox_min": [round(float(x), 3) for x in mn],
           "bbox_max": [round(float(x), 3) for x in mx], "centroid": [round(float(x), 3) for x in c],
           "extent": [round(float(x), 3) for x in (mx - mn)], "pca_axis_variances": axes}
    log("  [tool] analyze_3d %s (%d pts)" % (os.path.basename(p), len(pts)))
    return "native 3D geometry: " + json.dumps(out)


def _a_volume(vol, p, log):
    """Native stats of a dense 3D voxel volume: occupancy/porosity, intensity, per-axis occupied extent, components."""
    import numpy as np
    v = np.asarray(vol); fv = v.astype(float)
    D, H, W = v.shape[:3]
    binary = set(np.unique(v).tolist()).issubset({0, 1})
    thr = 0.5 if binary else float(fv.mean())
    occ = fv > thr
    out = {"shape": [int(D), int(H), int(W)], "dtype": str(v.dtype), "binary": bool(binary),
           "intensity_min": float(v.min()), "intensity_max": float(v.max()),
           "intensity_mean": round(float(fv.mean()), 3), "intensity_std": round(float(fv.std()), 3),
           "occupied_fraction": round(float(occ.mean()), 4),
           "occupied_extent_zyx": [int(occ.any(axis=(1, 2)).sum()), int(occ.any(axis=(0, 2)).sum()),
                                   int(occ.any(axis=(0, 1)).sum())]}
    try:
        from scipy import ndimage
        out["n_connected_components"] = int(ndimage.label(occ)[1])
    except Exception:
        pass
    log("  [tool] analyze_3d %s (volume %dx%dx%d)" % (os.path.basename(p), D, H, W))
    return "native 3D volume stats: " + json.dumps(out)


def _p_text(args, td, by_file, state, log):
    p = _resolve(args.get("file"), td, by_file)
    if not p:
        return "text NOT FOUND"
    try:
        txt = open(p, encoding="utf-8", errors="replace").read()
    except Exception as e:
        return "could not read text: %s" % e
    log("  [tool] read_text %s (%d chars)" % (os.path.basename(p), len(txt)))
    return txt[:6000]


# ---------------------------------------------------------------- SYMBOLIC specialists (math / molecule)
def _check_math(args, td, by_file, state, log):
    """Verify/simplify a math expression with sympy (specialist) -- not the LLM eyeballing arithmetic."""
    expr = args.get("expression", "")
    try:
        import sympy
        e = sympy.sympify(expr)
        out = {"input": expr, "simplified": str(sympy.simplify(e)), "latex": sympy.latex(e)}
        try:
            out["value"] = str(e.evalf())
        except Exception:
            pass
    except Exception as ex:
        return "sympy could not parse %r: %s" % (expr[:80], ex)
    log("  [tool] check_math %r" % expr[:50])
    return "sympy: " + json.dumps(out, ensure_ascii=False)


def _parse_molecule(args, td, by_file, state, log):
    """Parse a SMILES with RDKit (specialist): a long SMILES the general LLM mis-reads -> canonical + descriptors."""
    smi = args.get("smiles", "")
    if not smi and args.get("file"):
        p = _resolve(args.get("file"), td, by_file)
        smi = (open(p).read().strip().split() or [""])[0] if p else ""
    try:
        from rdkit import Chem
        from rdkit.Chem import Descriptors, rdMolDescriptors
        m = Chem.MolFromSmiles(smi)
        if m is None:
            return "RDKit: INVALID SMILES %r" % smi[:80]
        out = {"canonical_smiles": Chem.MolToSmiles(m), "n_atoms": m.GetNumAtoms(),
               "mol_weight": round(Descriptors.MolWt(m), 2), "logp": round(Descriptors.MolLogP(m), 2),
               "n_rings": rdMolDescriptors.CalcNumRings(m), "valid": True}
        log("  [tool] parse_molecule (%d atoms)" % m.GetNumAtoms())
        return "RDKit: " + json.dumps(out)
    except ImportError:
        return ("RDKit not installed -- a specialist molecular parser is the right tool for a long SMILES "
                "(the general LLM mis-reads long strings). `pip install rdkit`; for now treat %r as text." % smi[:60])
    except Exception as ex:
        return "RDKit failed on %r: %s" % (smi[:80], ex)


# ---------------------------------------------------------------- PROCEDURAL (read an agent/run trace)
def _read_trace(args, td, by_file, state, log):
    """Read a procedural TRACE json: a movement/track TRAJECTORY, or an agent/run tool-call log. Summarise the sequence."""
    p = _resolve(args.get("file"), td, by_file)
    if not p:
        return "trace NOT FOUND"
    try:
        tr = json.load(open(p, encoding="utf-8"))
    except Exception as ex:
        return "could not parse trace json: %s" % ex
    # --- trajectory form: dict carrying an ordered list of [t, x, y] points ---
    if isinstance(tr, dict) and (tr.get("coords") or tr.get("points")):
        c = tr.get("coords") or tr.get("points")
        fmt = lambda r: "t=%s (%.4f,%.4f)" % (r[0], r[1], r[2])
        head = "; ".join(fmt(r) for r in c[:4] if r and len(r) >= 3)
        tail = "; ".join(fmt(r) for r in c[-2:] if r and len(r) >= 3)
        meta = {k: tr.get(k) for k in ("id", "domain", "frame", "labels") if k in tr}
        log("  [tool] read_trace %s (trajectory, %d pts)" % (os.path.basename(p), len(c)))
        return ("trajectory %s: %d ordered points; start[%s] ... end[%s]. "
                "Use analyze_trajectory for geometry, look_at_trajectory to see the path shape."
                % (json.dumps(meta), len(c), head, tail))
    # --- agent/run trace form: list of role/step/calls ---
    steps = []
    for e in (tr if isinstance(tr, list) else []):
        if e.get("role") == "assistant":
            steps.append("step%s: %s" % (e.get("step"), ", ".join(c.get("tool", "?") for c in e.get("calls", []))))
        elif e.get("role") in ("exit_gate", "end"):
            steps.append("[%s] %s" % (e.get("role"), str(e.get("text", ""))[:60]))
    log("  [tool] read_trace %s" % os.path.basename(p))
    return "trace tool-sequence:\n" + "\n".join(steps[:60])


def _load_trajectory(p):
    """Load a trajectory json -> (obj, t, x, y) numpy arrays; None if not an ordered coords trajectory."""
    import numpy as np
    try:
        obj = json.load(open(p, encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(obj, dict):
        return None
    coords = obj.get("coords") or obj.get("points")
    if not coords:
        return None
    arr = np.array([[c[0], c[1], c[2]] for c in coords
                    if c and len(c) >= 3 and all(v is not None for v in c[:3])], dtype=float)
    arr = arr[np.isfinite(arr).all(axis=1)]
    if arr.shape[0] < 2:
        return None
    return obj, arr[:, 0], arr[:, 1], arr[:, 2]


def _haversine(x1, y1, x2, y2):
    """great-circle distance (km) for lon/lat degrees; vectorised."""
    import numpy as np
    R = 6371.0088
    p1, p2 = np.radians(y1), np.radians(y2)
    a = np.sin(np.radians(y2 - y1) / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(np.radians(x2 - x1) / 2) ** 2
    return 2 * R * np.arcsin(np.sqrt(np.clip(a, 0, 1)))


def _traj_geom(obj, t, x, y):
    """native geometry stats of a trajectory (great-circle km for lon/lat, else Euclidean units)."""
    import numpy as np
    frame = obj.get("frame", "xy")
    if frame == "lonlat":
        seg = _haversine(x[:-1], y[:-1], x[1:], y[1:]); unit = "km"
        net = float(_haversine(np.array(x[0]), np.array(y[0]), np.array(x[-1]), np.array(y[-1])))
    else:
        seg = np.hypot(np.diff(x), np.diff(y)); unit = "units"
        net = float(np.hypot(x[-1] - x[0], y[-1] - y[0]))
    path = float(seg.sum())
    dt = np.diff(t).astype(float); dt[dt == 0] = np.nan
    spd = seg / dt; spd = spd[np.isfinite(spd)]
    ang = np.arctan2(np.diff(y), np.diff(x))
    dang = (np.diff(ang) + np.pi) % (2 * np.pi) - np.pi        # wrapped turn angle [-pi, pi]
    out = {"id": obj.get("id"), "domain": obj.get("domain"), "frame": frame,
           "n_points": int(len(t)), "duration": round(float(t[-1] - t[0]), 3),
           "path_length_" + unit: round(path, 4), "net_displacement_" + unit: round(net, 4),
           "straightness": round(net / path, 4) if path > 0 else None,
           "bbox": [round(float(x.min()), 5), round(float(y.min()), 5),
                    round(float(x.max()), 5), round(float(y.max()), 5)],
           "mean_speed": round(float(np.mean(spd)), 5) if spd.size else None,
           "max_speed": round(float(np.max(spd)), 5) if spd.size else None,
           "turn_abs_mean_rad": round(float(np.mean(np.abs(dang))), 4) if dang.size else None,
           "turn_std_rad": round(float(np.std(dang)), 4) if dang.size else None}
    for k, v in (obj.get("aux") or {}).items():                # optional co-recorded series (e.g. storm wind/pressure)
        try:
            a = np.array([z for z in v if z is not None], float)
            if a.size:
                out["aux_%s_min" % k], out["aux_%s_max" % k] = round(float(a.min()), 3), round(float(a.max()), 3)
        except Exception:
            pass
    return out


def _a_trajectory(args, td, by_file, state, log):
    """NATIVE geometry of a movement/track trajectory json -- numbers, not a picture."""
    p = _resolve(args.get("file"), td, by_file)
    if not p:
        return "trajectory NOT FOUND"
    tr = _load_trajectory(p)
    if not tr:
        return "not a trajectory json (need a dict with an ordered 'coords':[[t,x,y],...])"
    out = _traj_geom(*tr)
    log("  [tool] analyze_trajectory %s (%d pts)" % (os.path.basename(p), out["n_points"]))
    return "trajectory geometry: " + json.dumps(out)


def _p_trajectory(args, td, by_file, state, log):
    """Render a trajectory's spatial path (coloured by time) + speed profile; VLM perceives the route shape."""
    if state["img_used"] >= state["img_budget"]:
        return "(image budget reached)"
    import numpy as np
    p = _resolve(args.get("file"), td, by_file)
    if not p:
        return "trajectory NOT FOUND"
    tr = _load_trajectory(p)
    if not tr:
        return "not a trajectory json (need an ordered 'coords':[[t,x,y],...])"
    obj, t, x, y = tr
    frame = obj.get("frame", "xy")

    def draw(fig):
        ax = fig.add_subplot(121)
        ax.plot(x, y, lw=0.4, color="gray", alpha=0.6)
        ax.scatter(x, y, c=np.linspace(0, 1, len(x)), cmap="viridis", s=6)
        ax.scatter([x[0]], [y[0]], c="lime", s=45, marker="o", edgecolor="k", zorder=5, label="start")
        ax.scatter([x[-1]], [y[-1]], c="red", s=45, marker="s", edgecolor="k", zorder=5, label="end")
        ax.set_title("path %s" % (obj.get("id") or os.path.basename(p)), fontsize=9)
        ax.set_xlabel("lon" if frame == "lonlat" else "x", fontsize=8)
        ax.set_ylabel("lat" if frame == "lonlat" else "y", fontsize=8)
        if frame == "lonlat":
            ax.set_aspect("equal", adjustable="datalim")
        ax.legend(fontsize=7)
        seg = _haversine(x[:-1], y[:-1], x[1:], y[1:]) if frame == "lonlat" else np.hypot(np.diff(x), np.diff(y))
        dt = np.diff(t).astype(float); dt[dt == 0] = np.nan
        ax2 = fig.add_subplot(122)
        ax2.plot(np.arange(len(seg)), seg / dt, lw=0.7)
        ax2.set_title("speed vs step", fontsize=9)
        ax2.set_xlabel("step", fontsize=8); ax2.set_ylabel("speed", fontsize=8)

    png = _render(draw, p)
    q = args.get("question") or ("This is the spatial PATH of a real movement/track trajectory (points coloured by "
                                 "time; start=green circle, end=red square) with its per-step speed profile. Describe "
                                 "the route SHAPE: directed vs tortuous, loops, stopovers/stalls, recurvature, straight "
                                 "runs, and anything scientifically notable. If it looks like a single point or is "
                                 "blank, say the render failed rather than inventing structure.")
    state["img_used"] += 1
    log("  [tool] look_at_trajectory %s (used=%d/%d)" % (os.path.basename(p), state["img_used"], state["img_budget"]))
    return "rendered trajectory %s -> %s" % (os.path.basename(p), _vlm(png, q, 400)[:700])


# ---------------------------------------------------------------- registry + dispatch
_FN = {"look_at_image": _p_image, "look_at_table": _p_table, "look_at_signal": _p_signal,
       "look_at_audio": _p_audio, "look_at_video": _p_video, "look_at_3d": _p_3d, "read_text": _p_text,
       "analyze_signal": _a_signal, "analyze_audio": _a_audio, "analyze_video": _a_video, "analyze_3d": _a_3d,
       "check_math": _check_math, "parse_molecule": _parse_molecule, "read_trace": _read_trace,
       "analyze_trajectory": _a_trajectory, "look_at_trajectory": _p_trajectory}

# which tools a modality unlocks. NATIVE analysis (numbers/text) FIRST, then the optional VISUAL render channel.
# A modality is NOT forced into a picture: the agent picks native features, the visual gestalt, or both.
_MOD_TOOLS = {"image": ["look_at_image"], "table": ["look_at_table"], "text": ["read_text"],
              "signal": ["analyze_signal", "look_at_signal"], "audio": ["analyze_audio", "look_at_audio"],
              "video": ["analyze_video", "look_at_video"], "threeD": ["analyze_3d", "look_at_3d"],
              "molecule": ["parse_molecule"], "symbolic": ["read_text", "check_math"],
              "trace": ["read_trace", "analyze_trajectory", "look_at_trajectory"]}

_SCHEMA = {
    "look_at_image": ("Inspect a FEW specific image files with the VLM (file ids from the materials).",
                      {"files": {"type": "array", "items": {"type": "string"}}, "question": {"type": "string"}},
                      ["files", "question"]),
    "look_at_table": ("Get a structured view of a TABLE (csv/tsv/parquet): shape, columns/dtypes, head, summary stats.",
                      {"file": {"type": "string"}, "question": {"type": "string"}}, ["file"]),
    "look_at_signal": ("PERCEIVE the SHAPE of a 1D or MULTICHANNEL numeric signal by rendering it and looking "
                       "(csv/txt/npy). Adaptive + auto-oriented: a multichannel WAVEFORM (several channels sampled "
                       "over time) is drawn as one time-series panel per channel over a "
                       "sample axis; a single TIME-SERIES / SPECTRUM / loss curve is drawn as one line. Look for "
                       "onset and transient bursts, oscillation, envelope decay, peaks and change-points, per "
                       "channel. Pass 'question' to focus it. If the plot shows only a few points or is blank, treat "
                       "it as a render failure, do NOT infer structure.",
                       {"file": {"type": "string"}, "question": {"type": "string"}}, ["file"]),
    "look_at_audio": ("PERCEIVE audio (wav) via its rendered waveform + spectrogram.",
                      {"file": {"type": "string"}, "question": {"type": "string"}}, ["file"]),
    "look_at_video": ("PERCEIVE a video by sampling a few frames and looking at them.",
                      {"file": {"type": "string"}, "question": {"type": "string"},
                       "n_frames": {"type": "integer"}}, ["file"]),
    "look_at_3d": ("PERCEIVE 3D geometry (point cloud / mesh: xyz/npy/ply) via rendered XY/XZ/YZ projections.",
                   {"file": {"type": "string"}, "question": {"type": "string"}}, ["file"]),
    "read_text": ("Read a text/code/log/paper file as text.",
                  {"file": {"type": "string"}}, ["file"]),
    "analyze_signal": ("NATIVE numeric features of a 1D signal (curve/time-series/spectrum/loss): trend, FFT "
                       "dominant freqs, peaks, stats -- numbers, NOT a picture. (look_at_signal is the visual view.)",
                       {"file": {"type": "string"}}, ["file"]),
    "analyze_audio": ("NATIVE audio features (duration, sample rate, RMS, spectral centroid, dominant freq, "
                      "zero-crossing) -- numbers. ASR transcription needs a speech model (noted if absent).",
                      {"file": {"type": "string"}}, ["file"]),
    "analyze_video": ("NATIVE video features (frame count, fps, resolution, frame-diff motion) -- numbers. "
                      "True captioning needs a video model.",
                      {"file": {"type": "string"}}, ["file"]),
    "analyze_3d": ("NATIVE 3D geometry of a point cloud/mesh (n_points, bbox, centroid, extent, PCA axes) -- "
                   "numbers, NOT a picture. (look_at_3d is the visual projection view.)",
                   {"file": {"type": "string"}}, ["file"]),
    "check_math": ("SPECIALIST symbolic math (sympy): simplify / verify / evaluate a formula exactly, instead "
                   "of the LLM eyeballing arithmetic. Pass the expression string.",
                   {"expression": {"type": "string"}}, ["expression"]),
    "parse_molecule": ("SPECIALIST molecular parser (RDKit): canonicalise a SMILES + compute descriptors -- the "
                       "right tool for a long SMILES the LLM would mis-read. Pass smiles or a file.",
                       {"smiles": {"type": "string"}, "file": {"type": "string"}}, []),
    "read_trace": ("Read a procedural TRACE json -- a movement/track TRAJECTORY (ordered [t,x,y] points) or an "
                   "agent/run tool-call log -- and summarise the ordered sequence.",
                   {"file": {"type": "string"}}, ["file"]),
    "analyze_trajectory": ("NATIVE geometry of a movement/track TRAJECTORY json (n_points, duration, path length, "
                           "net displacement, straightness, bbox, mean/max speed, turning-angle stats; great-circle "
                           "km for lon/lat) -- numbers, NOT a picture. (look_at_trajectory is the visual path view.)",
                           {"file": {"type": "string"}}, ["file"]),
    "look_at_trajectory": ("PERCEIVE the spatial PATH of a trajectory: render it (points coloured by time, start/end "
                           "marked) plus a speed profile, and look. Reveals route shape -- directedness, tortuosity, "
                           "loops, stopovers/stalls, recurvature, straight runs. Pass 'question' to focus it.",
                           {"file": {"type": "string"}, "question": {"type": "string"}}, ["file"]),
}


def tool_schemas(modalities):
    names, seen = [], set()
    for mod in modalities:
        for nm in _MOD_TOOLS.get(mod, []):
            if nm not in seen:
                seen.add(nm); names.append(nm)
    out = []
    for nm in names:
        desc, props, req = _SCHEMA[nm]
        out.append({"type": "function", "function": {"name": nm, "description": desc,
                    "parameters": {"type": "object", "properties": props, "required": req}}})
    return out


def run(name, args, state, log, td, by_file):
    state.setdefault("img_used", 0); state.setdefault("img_budget", 8)
    fn = _FN.get(name)
    if not fn:
        return None                                       # not a perception tool -> caller handles it
    return fn(args, td, by_file, state, log)
