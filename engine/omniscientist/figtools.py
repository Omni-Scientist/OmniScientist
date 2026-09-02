"""figtools -- the ONE sanctioned way to make paper figures in stage 2.

A copy of this file is dropped into the task directory before the experiment
loop starts, so `import figtools` always works from run_python code. It exists
because agent-authored matplotlib defaults produced raster PNGs in default
blue/orange/green with sans-serif text -- none of which survives review.

Contract (enforced by the stage-2 exit gate + paperlint):
  import figtools
  fig, ax = figtools.new(width='col')            # or width='wide' for a true multi-panel figure
  ...plot using figtools palettes...
  figtools.save('accuracy_by_group')             # -> fig_accuracy_by_group.pdf (vector) + .png (preview)

Design rules baked in (2026-08-28):
  - vector PDF output, Times-metric serif, fonttype 42;
  - figure is created AT ITS FINAL PRINTED WIDTH, so in-figure text is a real
    8.5-10pt on the page (body is 10pt; figure text may be 0-2pt smaller, never more);
  - bars wear LIGHT fills with a DARKER same-family edge; lines/markers wear
    DEEP colours with distinct marker shapes (hue+shape double coding);
  - the matplotlib default colour cycle (#1f77b4 blue et al.) is unreachable:
    rcParams are overridden at import;
  - a 'wide' figure must earn its width (multi-panel or genuinely wide content);
    a sparse wide figure is flagged in figmeta.json and the gate rejects it.
"""
import json
import os

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

# ---------------------------------------------------------------- geometry
# Final printed widths in inches, per venue. Stage 2 writes figconfig.json
# next to this file ({"col_in": ..., "wide_in": ..., "body_pt": ...}); the
# two-column default below matches the physics/earth/chem skins.
_CFG = {"col_in": 3.43, "wide_in": 7.0, "body_pt": 10.0}
try:
    _CFG.update(json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                            "figconfig.json"))))
except Exception:
    pass

COL_W = float(_CFG["col_in"])
WIDE_W = float(_CFG["wide_in"])
BASE_PT = float(_CFG["body_pt"]) - 1.5          # in-figure text: body minus 1.5pt (allowed band: body-2 .. body)

# ---------------------------------------------------------------- palettes (NPG / Nature-family)
# Deep line/marker colours: saturated, far-apart hues for series that must be told apart.
LINE = ["#E64B35", "#3C5488", "#00A087", "#845B97", "#B07C3F", "#4DBBD5", "#DC5F8E", "#7E6148"]
MARKERS = ["o", "s", "^", "D", "v", "P", "X", "*"]

# Bar families: LIGHT fill + DARKER same-family edge (never a saturated slab).
BAR_FILLS = ["#CEE6F3", "#FBD2E0", "#CEEDC6", "#FFDBA6", "#C8D1D6", "#CABAE6"]
BAR_EDGES = ["#54798F", "#C3728E", "#55875B", "#B08A4F", "#6E7C85", "#7A6699"]

INK, RULE, GRIDC = "#1A1A1A", "#4D4D4D", "#D9D9D9"
SERIF = ["Nimbus Roman", "Times New Roman", "Liberation Serif", "STIXGeneral", "DejaVu Serif"]

from matplotlib.colors import LinearSegmentedColormap
SEQ = LinearSegmentedColormap.from_list("npgseq", ["#F5FAFC", "#C5E5EF", "#4DBBD5", "#3C7FA8", "#3C5488"])
DIV = LinearSegmentedColormap.from_list("npgdiv", ["#E64B35", "#F3B5AA", "#F7F7F7", "#A9B4CC", "#3C5488"])

from cycler import cycler
plt.rcParams.update({
    "font.family": "serif", "font.serif": SERIF, "mathtext.fontset": "stix",
    "font.size": BASE_PT, "axes.titlesize": BASE_PT, "axes.labelsize": BASE_PT,
    "xtick.labelsize": BASE_PT - 0.5, "ytick.labelsize": BASE_PT - 0.5,
    "legend.fontsize": BASE_PT - 0.5, "figure.titlesize": BASE_PT,
    "axes.prop_cycle": cycler(color=LINE),      # default cycle can never be the matplotlib blue/orange/green
    "axes.edgecolor": RULE, "axes.linewidth": 0.8, "axes.labelcolor": INK,
    "text.color": INK, "xtick.color": INK, "ytick.color": INK,
    "xtick.direction": "out", "ytick.direction": "out",
    "xtick.major.width": 0.8, "ytick.major.width": 0.8,
    "xtick.major.size": 2.8, "ytick.major.size": 2.8,
    "grid.color": GRIDC, "grid.linewidth": 0.6, "grid.linestyle": (0, (2, 2)),
    "legend.frameon": False, "legend.handlelength": 1.5, "legend.columnspacing": 1.2,
    "lines.linewidth": 1.3, "lines.markersize": 4.5,
    "axes.xmargin": 0.02, "axes.ymargin": 0.03,   # tight axis padding: whitespace is not content
    # NO bbox='tight': it crops the canvas below the contracted width, so includegraphics would re-scale the
    # figure and silently inflate every font. The canvas IS the printed size; constrained_layout (in new())
    # keeps labels inside it.
    "figure.dpi": 150, "savefig.dpi": 300,
    "savefig.facecolor": "white", "pdf.fonttype": 42, "ps.fonttype": 42,
})

_META_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "figmeta.json")
_fig_class = {}          # id(fig) -> 'col' | 'wide'


def new(width="col", ratio=0.50, nrows=1, ncols=1, **kw):
    """Create a figure at its FINAL printed width. width='col' (single column,
    the default) or 'wide' (full text width; only for multi-panel / wide content).
    ratio = height/width; it is CLAMPED so a figure is neither a skinny ribbon
    nor a page-hogging tower (2026-08-30: stat charts need no more height
    than the data does -- default trimmed 0.62 -> 0.50). Returns (fig, ax)."""
    w = WIDE_W if width == "wide" else COL_W
    lo = max(0.36, 0.44 * nrows / max(1, ncols))          # per-panel aspect >= 0.44 AND whole-figure >= 0.36
    hi = max(lo, min(1.15, 0.9 * nrows / max(1, ncols)))
    r = min(max(float(ratio), lo), hi)
    if abs(r - float(ratio)) > 1e-6:
        print("[figtools] ratio %.2f clamped to %.2f (%dx%d panels must not print as a skinny ribbon)"
              % (float(ratio), r, nrows, ncols))
    kw.setdefault("layout", "constrained")
    fig, ax = plt.subplots(nrows, ncols, figsize=(w, w * r), **kw)
    _fig_class[id(fig)] = "wide" if width == "wide" else "col"
    return fig, ax


def bar_style(i):
    """kwargs for the i-th bar series: light fill, darker same-family edge."""
    return {"color": BAR_FILLS[i % len(BAR_FILLS)],
            "edgecolor": BAR_EDGES[i % len(BAR_EDGES)], "linewidth": 0.9, "zorder": 3}


def line_style(i):
    """kwargs for the i-th line/scatter series: deep colour + distinct marker."""
    return {"color": LINE[i % len(LINE)], "marker": MARKERS[i % len(MARKERS)],
            "markersize": 4.5, "linewidth": 1.3, "zorder": 3}


def grid(ax, axis="y"):
    ax.grid(True, axis=axis, zorder=0)
    ax.set_axisbelow(True)


def _legend_collides(ax, leg, fig):
    """True if the legend's pixel box overlaps plotted data (points, line vertices, or bar patches)."""
    import numpy as np
    lb = leg.get_window_extent(fig.canvas.get_renderer())
    for ln in ax.lines:
        xy = ln.get_xydata()
        if len(xy):
            p = ax.transData.transform(xy)
            if ((p[:, 0] >= lb.x0) & (p[:, 0] <= lb.x1) & (p[:, 1] >= lb.y0) & (p[:, 1] <= lb.y1)).any():
                return True
    for coll in ax.collections:
        off = getattr(coll, "get_offsets", lambda: [])()
        if len(off):
            p = ax.transData.transform(np.asarray(off))
            if ((p[:, 0] >= lb.x0) & (p[:, 0] <= lb.x1) & (p[:, 1] >= lb.y0) & (p[:, 1] <= lb.y1)).any():
                return True
    for pt in ax.patches:
        bb = pt.get_window_extent(fig.canvas.get_renderer())
        if bb.width and bb.height and lb.overlaps(bb):
            return True
    return False


def _fix_legends(fig):
    """A legend may NEVER sit on the data (house rule). For each axes whose legend collides with plotted
    artists, move it OUTSIDE: few entries -> a horizontal row above the axes; many -> a column at the right.
    constrained_layout then reflows the axes to make room."""
    fig.canvas.draw()
    for ax in fig.get_axes():
        leg = ax.get_legend()
        if leg is None:
            continue
        try:
            collides = _legend_collides(ax, leg, fig)
        except Exception:
            collides = False
        if not collides:
            continue
        handles, labels = ax.get_legend_handles_labels()
        if not labels:                             # legend built from proxy artists (e.g. bare Patch handles):
            handles = list(getattr(leg, "legend_handles", []) or [])   # they never register on the axes, so
            labels = [t.get_text() for t in leg.get_texts()]           # recover both from the legend itself
        n = len(labels)
        if n == 0:
            continue
        if n <= 4:
            ax.legend(handles, labels, loc="lower center", bbox_to_anchor=(0.5, 1.01),
                      ncol=min(n, 4), borderaxespad=0.0)
        else:
            ax.legend(handles, labels, loc="center left", bbox_to_anchor=(1.02, 0.5),
                      ncol=1 + (n > 8), borderaxespad=0.0)
        print("[figtools] legend overlapped the data -> moved outside the axes (%d entries)" % n)
    fig.canvas.draw()


def _fix_ticklabels(fig):
    """Crowded categorical x tick labels (adjacent boxes overlapping) are rotated 30 degrees -- unreadable
    label pile-ups shipped in a published figure once."""
    fig.canvas.draw()
    for ax in fig.get_axes():
        labs = [t for t in ax.get_xticklabels() if t.get_text().strip()]
        if len(labs) < 3 or any(t.get_rotation() for t in labs):
            continue
        boxes = [t.get_window_extent(fig.canvas.get_renderer()) for t in labs]
        if any(b1.x1 > b2.x0 + 1 for b1, b2 in zip(boxes, boxes[1:])):
            for t in labs:
                t.set_rotation(30)
                t.set_ha("right")
            print("[figtools] crowded x tick labels -> rotated 30 degrees")


def save(name, fig=None):
    """Save the current (or given) figure as fig_<name>.pdf (vector, the one the
    paper uses) + fig_<name>.png (preview), and record its width class + a
    sparseness flag in figmeta.json. Returns the .png filename (list THAT in
    'figures')."""
    fig = fig or plt.gcf()
    name = str(name)
    if name.startswith("fig_"):
        name = name[4:]
    name = os.path.splitext(name)[0]
    cls = _fig_class.get(id(fig))
    if cls is None:                               # figure made without new() -> classify by its actual width
        cls = "wide" if fig.get_size_inches()[0] > (COL_W + WIDE_W) / 2 else "col"
    floor = BASE_PT - 0.5                         # printed text may sit at [body-2, body]pt; below that is illegible
    import matplotlib.text as _mtext
    for t in fig.findobj(_mtext.Text):
        if t.get_text().strip() and t.get_fontsize() < floor:
            t.set_fontsize(floor)                 # agent-set tiny fonts are silently lifted to the floor
    _fix_legends(fig)                             # a legend never sits on the data
    _fix_ticklabels(fig)                          # crowded x labels rotate instead of colliding
    axes = [a for a in fig.get_axes() if a.get_visible()]
    n_art = sum(len(a.lines) + len(a.patches) + len(a.collections) + len(a.images) for a in axes)
    sparse = bool(cls == "wide" and len(axes) < 2 and n_art < 6)
    if sparse:
        print("[figtools] WARNING fig_%s: a WIDE figure with one sparse panel reads as empty space. "
              "Remake it with width='col', or add panels/series." % name)
    pdf, png = "fig_%s.pdf" % name, "fig_%s.png" % name
    fig.savefig(pdf)
    fig.savefig(png, dpi=300)
    try:
        meta = json.load(open(_META_PATH)) if os.path.exists(_META_PATH) else {}
    except Exception:
        meta = {}
    meta[png] = {"width": cls, "panels": len(axes), "artists": n_art, "sparse": sparse}
    json.dump(meta, open(_META_PATH, "w"), indent=1)
    _fig_class.pop(id(fig), None)                 # id() may be reused after close -> never misclassify a later figure
    plt.close(fig)
    print("[figtools] saved %s (vector) + %s [%s%s]" % (pdf, png, cls, ", SPARSE" if sparse else ""))
    return png
