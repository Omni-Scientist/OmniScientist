"""paperlint -- machine acceptance checks for a stage-3 paper (PAPER_QUALITY_SPEC section 3).

Usage:
    python scripts/paperlint.py --task feynman            # lints examples/feynman/stages/03_paper.{pdf,tex}
    python scripts/paperlint.py --task feynman --json     # machine-readable report only

Every check returns (ok, detail). The point is a REASON you can act on, so the
fix loop can rerun only the failing stage (make_figs.py for figure checks,
stage 3 for text/layout checks) instead of restarting from scratch.
"""
import argparse
import glob
import json
import os
import re
import sys

import pymupdf

HERE = os.path.dirname(os.path.abspath(__file__))

# The one place the reference floor is written down. stage 3 blocks BEFORE writing when the search cannot reach
# it (there is no point spending a writing pass on a paper that must fail refs_count), and reads it from here --
# it used to carry its own hardcoded 20 in three spots while its comment claimed 15.
REFS_FLOOR = 15

# matplotlib default cycle (the banned "flowery quilt" colours), as rgb tuples
_BANNED = {(0.1216, 0.4667, 0.7059): "#1f77b4 default blue",
           (1.0000, 0.4980, 0.0549): "#ff7f0e default orange",
           (0.1725, 0.6275, 0.1725): "#2ca02c default green",
           (0.8392, 0.1529, 0.1569): "#d62728 default red",
           (0.5804, 0.4039, 0.7412): "#9467bd default purple"}


def _near(c, target, tol=0.004):
    return c is not None and len(c) == 3 and all(abs(a - b) <= tol for a, b in zip(c, target))


def _is_results_section(name):
    """The sections the number-density rule applies to. Shared with agentic._fix_density so the checker and the
    fixer cannot drift (they did once). 'Experiments' (cs_ml's results section) counts; 'Experimental Section'
    (chem's METHODS) and 'Experimental Setup' do not -- a methods section owes its parameter listings."""
    n = (name or "").strip()
    return bool(re.search(r"result|discussion|conclu|finding|evaluation", n, re.I)
                or re.fullmatch(r"(?:\d+\.?\s*)?experiments?", n, re.I))


def _prose_paragraphs(tex, results_only=False):
    """Body paragraphs with floats/captions/math/comments stripped -- the text a reader actually reads.
    results_only=True keeps only paragraphs under Results/Discussion/Conclusion-type sections: the number-
    density rule targets DESCRIPTIVE result numbers, not the parameter listings a Methods section owes."""
    m = re.search(r"\\begin\{document\}(.*?)(\\bibliographystyle|\\bibliography\{|\\end\{document\})", tex, re.S)
    body = m.group(1) if m else tex
    body = re.sub(r"(?<!\\)%.*", "", body)
    for env in ("figure", "figure*", "table", "table*", "equation", "equation*", "align", "align*",
                "eqnarray", "displaymath", "abstract"):
        body = re.sub(r"\\begin\{%s\}.*?\\end\{%s\}" % (re.escape(env), re.escape(env)), "", body, flags=re.S)
    body = re.sub(r"(?<!\\)\\\[.*?\\\]", "", body, flags=re.S)   # display math \[...\] is not prose; the '\\[0.6em]'
                                                                # row spacing in the two-column header is NOT a math open
    if results_only:
        keep, cur = [], False
        for chunk in re.split(r"(\\section\*?\{[^}]*\})", body):
            hm = re.match(r"\\section\*?\{([^}]*)\}", chunk)
            if hm:
                cur = _is_results_section(hm.group(1))
            elif cur:
                keep.append(chunk)
        body = "\n\n".join(keep)
    body = re.sub(r"\\(?:sub)*section\*?\{[^}]*\}", "\n\n", body)
    body = re.sub(r"\\caption\{[^}]*\}", "", body)
    return [p.strip() for p in re.split(r"\n\s*\n", body) if len(p.strip()) > 80]


def _abstract_text(tex, stages=None, abstract=None):
    """The abstract as written, across BOTH venue skins: the abstract environment, and the \\centerline{...Abstract}
    + \\noindent form the reskinned templates emit. 03_paper.json is the last resort so a future skin cannot turn
    this check into a silent pass."""
    m = re.search(r"\\begin\{abstract\}(.*?)\\end\{abstract\}", tex, re.S)
    if m:
        return m.group(1)
    m = re.search(r"\\centerline\{[^}]*[Aa]bstract\}(.*?)(?=\n\s*\n|\\section)", tex, re.S)
    if m:
        return m.group(1)
    if abstract is not None:                               # caller already holds the text (skill: sections["ABSTRACT"])
        return abstract
    if stages:
        try:
            return str(json.load(open(os.path.join(stages, "03_paper.json"))).get("abstract", ""))
        except Exception:
            pass
    return ""


_COUNT_NOUN = (r"clips?|windows?|records?|samples?|plants?|pixels?|images?|events?|observations?|"
               r"trials?|runs?|cells?|subjects?|scans?|instances?|examples?|frames?|equations?|"
               r"datasets?|groups?|classes?|bands?|channels?|files?|sequences?|traces?|species|specimens?|"
               r"clouds?|spectra|tokens?|words?|documents?|nodes?|edges?|reads?|epochs?|segments?|tiles?")
# ('points' and 'units' left the list: 'a 12-point gain' and '15 points of F1' are effects; a point-cloud SIZE is
#  still stripped below, but only for 3+ digit counts)
_UNIT = r"(?:s|seconds?|ms|min|minutes?|h|hours?|Hz|kHz|MHz|nm|mm|cm|km|K|px|fps|dpi)"


def _result_numbers(par):
    """Result-flavoured numeric tokens in a prose paragraph: decimals, percentages, big integers.
    Years, figure/table/section/equation pointers and citation keys do not count. Neither do the three
    things the rule never meant by "a result number": math notation (\\log_{10}R, 10^{-12}), the
    confidence level and bracketed interval hanging off an effect that was already counted, and sample
    sizes -- written `n=739` or bare, as in `750 noise windows`."""
    p = re.sub(r"\\(?:cite[a-zA-Z]*|ref|label|eqref|autoref|cref|pageref)(?:\[[^\]]*\])*\{[^}]*\}", "", par)
    p = re.sub(r"\\(?:url|href|footnote)\{[^}]*\}", "", p)                 # URLs, DOIs and footnotes are not results
    p = re.sub(r"(?:Figures?|Figs?\.|Tables?|Sections?|Sec\.|Eqs?\.|Equations?)~?\s*\(?\d+\)?(?:\s*(?:,|and|to|--)\s*\(?\d+\)?)*", "", p)
    p = re.sub(r"\$([^$]*)\$", r" \1 ", p)        # unwrap inline math so the rules below see its digits
    p = p.replace("\\%", "%")                     # an escaped percent is still a percent ('5\%, 7\%' are effects)
    # instrument SETTINGS are not effects, but a unit alone does not make a setting ('0.8 K', '12 cm$^{-1}$' and
    # '300 ms to 120 ms' are results): a unit-bearing number is stripped only in a settings context -- a laser line
    # ('532 nm'), a hyphenated qualifier ('30-s epoch'), a settings noun after it ('60 second windows', '100 Hz
    # sampling') or a settings verb before it ('sampled at 100 Hz', 'excited at 532 nm').
    p = re.sub(r"(?<![.\d])\d{3,4}\s*(?:~|\\,)?\s*nm\b", " ", p)
    p = re.sub(r"\d+-(?:s|second|minute|hour|day|ms|Hz)\b", " ", p)
    p = re.sub(r"\d[\d.]*(?:/\d[\d.]*)?\s*(?:~|\\,)?\s*" + _UNIT + r"\s+(?:windows?|epochs?|segments?|bins?|frames?|clips?|"
               r"resolution|sampling|excitation|laser|exposure|integration|steps?|intervals?|cadence|spacing|grid|kernel|"
               r"detector|filter|cutoff|threshold|array)\b", " ", p, flags=re.I)
    p = re.sub(r"(?:sampled|resampled|recorded|acquired|binned|excited|excitation|integrated|windowed|smoothed|filtered|"
               r"cropped|resolution of|rate of|every|each)\s+(?:at\s+|to\s+|of\s+)?\d[\d.]*(?:/\d[\d.]*)?\s*(?:~|\\,)?\s*"
               + _UNIT + r"\b", " ", p, flags=re.I)
    # identifiers are not results: 'ID 06', 'unit No. 3', a leading-zero integer ('06' is a label, never a measurement)
    p = re.sub(r"\b(?:ID|Id|No\.|no\.|#)\s*\d+\b", " ", p)
    p = re.sub(r"(?<![.\d])0\d+\b", " ", p)
    # a COORDINATED sample size ('83 maize and 140 tomato point clouds') is one sample size, both counts go
    p = re.sub(r"(?<![.\d])\d{2,}\s+[A-Za-z]+\s+(?:and|or|vs\.?|versus|plus)\s+\d{2,}\s+[A-Za-z]+(?:\s+[A-Za-z]+){0,2}\s+(?:%s)\b"
               % _COUNT_NOUN, " ", p, flags=re.I)
    p = re.sub(r"(?<![.\d])\d{3,}\s+(?:[A-Za-z]+[\s-]+){0,2}points?\b", " ", p, flags=re.I)   # '2048 points' = cloud size
    # sample sizes are scale, not effect -- the house rule targets EFFECT numbers. The trailing list matters:
    # "n=50, 200, and 1000" is ONE sample-size sweep, and charging for the 2nd and 3rd entry read as a
    # number wall in the feynman paper when the paragraph was actually carrying three effects.
    p = re.sub(r"\b[nN]\s*=\s*\d+(?:\s*,\s*\d+)*(?:\s*,?\s*and\s+\d+)?", "", p)
    p = re.sub(r"\\log_\{?\d+\}?", "", p)                                  # the base of a log is notation
    # ... so is a power of ten. No \b before the 10: in "8.7\times10^{-12}" there is no word boundary
    # between the 's' of \times and the '1', so \b left the exponent behind as a bare "12".
    p = re.sub(r"(?:\\times\s*)?(?<!\d)10\s*\^\s*\{?[-+]?\d+\}?", "", p)
    p = re.sub(r"\d+\s*\\?%?\s*(?:CI\b|confidence)[^,;.]*?[\[(][^\])]*[\])]", "", p, flags=re.I)   # level + interval
    p = re.sub(r"\d+\s*\\?%?\s*(?:CI\b|confidence)", "", p, flags=re.I)
    p = re.sub(r"(?<![.\d])\d{2,}\s*-\s*(?:pixel|sample|frame|clip|band|class)\w*", "", p, flags=re.I)
    # gap words are LETTERS only and at most two: with \w and three, '85 on the 12 datasets' ate the 85
    p = re.sub(r"(?<![.\d])\d{2,}\s+(?:[A-Za-z]+[\s-]+){0,2}(?:%s)\b" % _COUNT_NOUN, "", p, flags=re.I)
    # lookbehind excludes dotted identifiers like Feynman law ids ('I.12.5' must not count as 12.5)
    toks = re.findall(r"(?<![.\d])-?\d+\.\d+(?:e-?\d+)?%?|(?<![.\d])-?\d+%|(?<![.\d])\b\d{2,}\b", p)
    return [t for t in toks if not re.fullmatch(r"(?:19|20)\d{2}", t)]


def lint(stages, figdir=None, cfg=None):
    """Research layout: stages = <task>/stages dir with 03_paper.{pdf,tex}, latex_03_paper/, 01_ideation.json.
    Returns {check: {"ok": bool, "detail": str}, "_ok": bool}. Thin wrapper over lint_paths()."""
    task_dir = os.path.dirname(stages.rstrip("/"))
    figdir = figdir or task_dir
    return lint_paths(os.path.join(stages, "03_paper.pdf"), os.path.join(stages, "03_paper.tex"),
                      bib_path=os.path.join(stages, "latex_03_paper", "references.bib"),
                      compile_log=os.path.join(stages, "latex_03_paper", "compile.log"),
                      fig_pdfs=sorted(glob.glob(os.path.join(figdir, "fig_*.pdf"))),
                      ideation_json=os.path.join(stages, "01_ideation.json"),
                      cfg=cfg, figconfig=os.path.join(figdir, "figconfig.json"), stages=stages)


def lint_paths(pdf_path, tex_path, bib_path=None, compile_log=None, fig_pdfs=None, abstract=None,
               ideation_json=None, cfg=None, figconfig=None, stages=None, skip=()):
    """The acceptance lint with every input named explicitly, so a different on-disk layout (the desktop skill
    keeps host/paper.pdf, host/latex/references.bib, host/latex/figures/*.pdf) runs the SAME checks as the
    research pipeline instead of a re-implementation that drifts. Checks whose input is absent are skipped,
    not failed: no ideation record -> no paradigm check; no compile.log -> overfull reports that fact.
    `skip` names checks that encode a convention the caller's layout does not define (see the skill's
    _acceptance_lint); they are dropped from the report rather than reported red forever."""
    R = {}
    cfg = dict(cfg or {"col_in": 3.43, "wide_in": 7.0, "body_pt": 10.0})
    if figconfig:
        try:
            cfg.update(json.load(open(figconfig)))
        except Exception:
            pass
    if not (os.path.exists(pdf_path) and os.path.exists(tex_path)):
        return {"_ok": False, "exists": {"ok": False, "detail": "missing %s/.tex" % os.path.basename(pdf_path)}}
    # a replay whose compile failed rewrites the tex but cannot refresh the pdf: judging the new tex against the
    # old pdf let the heal loop print SELF_HEAL_OK on a stale build. (stage 3 also deletes the stale pdf now.)
    if os.path.getmtime(tex_path) - os.path.getmtime(pdf_path) > 2.0:
        return {"_ok": False, "exists": {"ok": False, "detail": "%s is older than %s (stale build)"
                                                    % (os.path.basename(pdf_path), os.path.basename(tex_path))}}
    try:
        cfg = {k: (float(v) if k in ("col_in", "wide_in", "body_pt") else v) for k, v in cfg.items()}
    except (TypeError, ValueError) as e:
        return {"_ok": False, "exists": {"ok": False, "detail": "figconfig.json has a non-numeric size: %s" % e}}
    body_pt = float(cfg["body_pt"])
    tex = open(tex_path, errors="replace").read()
    try:
        doc = pymupdf.open(pdf_path)
        if doc.page_count == 0:
            raise ValueError("no pages")
    except Exception as e:
        return {"_ok": False, "exists": {"ok": False, "detail": "%s unreadable: %s" % (os.path.basename(pdf_path), e)}}

    # ---- references: count what the READER SEES -- entries actually typeset in the PDF's References
    #      section. Intermediate files lie: a stale .bbl showed 28-40 while the shipped PDF printed 4-8
    #      (caught, of all things, by reading the PDF). Fallbacks: .bbl, then .bib.
    #      Entries are found by plainnat's HANGING INDENT -- an entry's first line sits at its column's
    #      left edge, continuations are indented -- per column, so the two-column skins count too. The
    #      old rule counted lines *ending* in a year or page range, which silently dropped every entry
    #      whose bibtex record carried no year: plant_pheno3d printed 22 and linted as 14.
    bibs = [bib_path] if (bib_path and os.path.exists(bib_path)) else []
    n_refs, bad_names = 0, []
    _rows = []                                             # (column, x0, text) in reading order
    for pg in doc:
        mid = pg.rect.width / 2.0
        for blk in pg.get_text("dict")["blocks"]:
            if blk.get("type") != 0:
                continue
            for ln in blk["lines"]:
                t = "".join(s["text"] for s in ln["spans"]).strip()
                if t:
                    _rows.append((0 if ln["bbox"][0] < mid else 1, ln["bbox"][0], t))
    _start = next((i for i, r in enumerate(_rows) if re.fullmatch(r"references", r[2], re.I)), None)
    if _start is not None:
        _seg = _rows[_start + 1:]
        _stop = next((i for i, r in enumerate(_seg)
                      if re.match(r"(?i)^(?:[A-Z]\.?\s+)?(appendix|supplementary)\b", r[2])), len(_seg))
        _seg = _seg[:_stop]
        for _col in (0, 1):
            _xs = [r[1] for r in _seg if r[0] == _col]
            if _xs:
                _left = min(_xs)
                n_refs += sum(1 for x in _xs if abs(x - _left) < 1.0)
    # NO fallback to .bbl/.bib: when the PDF shows no References heading the reader sees no references, and the
    # intermediate files are exactly what lied before ("28-40 in the bbl, 4-8 printed").
    _no_heading = _start is None
    if bibs:
        for a in re.findall(r"author\s*=\s*[{\"](.+?)[}\"]\s*,?\n", open(bibs[0], errors="replace").read()):
            for name in re.split(r"\s+and\s+", a):
                if name.strip() and name.strip() == name.strip().lower():
                    bad_names.append(name.strip())
    R["refs_count"] = {"ok": n_refs >= REFS_FLOOR and not _no_heading,
                       "detail": ("no References heading in the PDF" if _no_heading
                                  else "%d PRINTED references (need >=%d)" % (n_refs, REFS_FLOOR))}
    R["refs_names"] = {"ok": not bad_names, "detail": ("all-lowercase authors: " + ", ".join(bad_names[:4])) if bad_names else "author casing clean"}

    # ---- layout: nothing figure/table after the References heading
    ref_pos, caps_after = None, []
    for pno, page in enumerate(doc):
        for x0, y0, x1, y1, text, bno, *_ in page.get_text("blocks"):
            t = text.strip()
            if ref_pos is None and re.match(r"^references$", t.split("\n")[0].strip(), re.I):
                ref_pos = (pno, bno)                       # block order follows the content stream (column-safe)
            m = re.match(r"^(Figure|Table)\s+\d+[.:]", t)
            if m and ref_pos and (pno, bno) > ref_pos:
                caps_after.append("%s p%d" % (m.group(0), pno + 1))
    R["figs_after_refs"] = {"ok": not caps_after,
                            "detail": ("floats after References: " + "; ".join(caps_after)) if caps_after
                            else ("References found, no floats after it" if ref_pos else "no References heading found")}
    if ref_pos is None:
        R["figs_after_refs"] = {"ok": False, "detail": "no References heading found in PDF"}

    # ---- stat figures must be vector: the .tex may only \includegraphics rasters for the data exemplar
    rasters = [g for g in re.findall(r"\\includegraphics\[[^\]]*\]\{([^}]+)\}", tex)
               if g.lower().endswith(".png") and "fdata" not in g]
    R["vector_figs"] = {"ok": not rasters, "detail": ("raster stat figures: " + ", ".join(rasters)) if rasters else "all stat figures vector"}

    # ---- per-figure source checks: banned colours, in-figure text size, serif fonts, width class
    fig_pdfs = sorted(fig_pdfs or [])
    col_pt, wide_pt = cfg["col_in"] * 72.0, cfg["wide_in"] * 72.0
    banned_hits, size_bad, font_bad, aspect_bad = [], [], [], []
    fig_unreadable = []
    for fp in fig_pdfs:
        try:
            fd = pymupdf.open(fp)
            pg = fd[0]
        except Exception as e:                            # 0-byte or corrupt figure: report it, keep linting
            fig_unreadable.append("%s (%s)" % (os.path.basename(fp), type(e).__name__))
            continue
        w = pg.rect.width
        # ---- shape: figures print wide and short (house shape 10:4.3). A single-column figure taller
        #      than 0.58x its width, or a full-width one taller than 0.30x, hogs the page for sparse ink.
        h = pg.rect.height
        if w:
            # A raster (png/jpg) carries pixels, not printed points, so its width says nothing about
            # whether it lands in one column or two; judge those against the lenient single-column band.
            if fd.is_pdf:
                is_wide = abs(w - wide_pt) < abs(w - col_pt)
                cls, limit = ("wide", 0.30) if is_wide else ("col", 0.58)
            else:
                cls, limit = "raster, col band assumed", 0.58
            if h / w > limit:
                aspect_bad.append("%s: h/w=%.2f (%s limit %.2f)" % (os.path.basename(fp), h / w, cls, limit))
        target = col_pt if abs(w - col_pt) < abs(w - wide_pt) else wide_pt
        scale = target / w if w else 1.0
        for d in pg.get_drawings():
            for c in (d.get("fill"), d.get("color")):
                for t, label in _BANNED.items():
                    if _near(c, t):
                        banned_hits.append("%s: %s" % (os.path.basename(fp), label))
        sizes = sorted(s["size"] * scale for b in pg.get_text("dict")["blocks"] if b.get("type") == 0
                       for l in b["lines"] for s in l["spans"] if s["text"].strip())
        # judge the BODY size (median), not the minimum: mathtext sub/superscripts (log-axis 10^x ticks)
        # legitimately print at ~0.7x and were false-failing every log-scaled figure.
        med = sizes[len(sizes) // 2] if sizes else 0
        # min floor = 0.65x of the smallest legal body size: a mathtext sub/superscript renders at ~0.7x its
        # parent, so a legal (body-2)pt tick label legitimately carries (body-2)*0.7 superscripts.
        if sizes and not (body_pt - 2.4 <= med <= body_pt + 0.6 and min(sizes) >= (body_pt - 2) * 0.65):
            size_bad.append("%s: median %.1fpt, min %.1fpt printed (body band %.1f-%.1f)"
                            % (os.path.basename(fp), med, min(sizes), body_pt - 2, body_pt))
        fonts = {s["font"] for b in pg.get_text("dict")["blocks"] if b.get("type") == 0
                 for l in b["lines"] for s in l["spans"]}
        nonserif = [f for f in fonts if not re.search(r"Times|Nimbus|STIX|Liberation ?Serif|TeX Gyre Termes", f, re.I)]
        if nonserif:
            font_bad.append("%s: %s" % (os.path.basename(fp), ",".join(sorted(nonserif)[:3])))
        fd.close()
    R["fig_colors"] = {"ok": not banned_hits, "detail": ("; ".join(sorted(set(banned_hits))[:6])) or "no default-cycle colours"}
    R["fig_readable"] = {"ok": not fig_unreadable, "detail": ("unreadable figure PDF(s): " + ", ".join(fig_unreadable[:4]))
                         if fig_unreadable else "%d figure PDF(s) open cleanly" % len(fig_pdfs)}
    R["fig_text_size"] = {"ok": not size_bad, "detail": "; ".join(size_bad[:4]) or "in-figure text within [body-2, body] pt"}
    R["fig_fonts"] = {"ok": not font_bad, "detail": "; ".join(font_bad[:4]) or "all figure text serif (Times family)"}
    R["fig_aspect"] = {"ok": not aspect_bad, "detail": "; ".join(aspect_bad[:4])
                       or "all figures wide and short (col<=0.58, wide<=0.30 of width)"}

    # ---- prose: DESCRIPTIVE result-number density in Results/Discussion/Conclusion paragraphs.
    #      <=3 per paragraph, no exemption. The old rule let ONE paragraph carry up to 10, which is
    #      a number wall by any reading -- dropped 2026-08-31. What a "result number" is was
    #      tightened at the same time (_result_numbers), so the budget is spent on effects only.
    #      Methods parameter listings stay exempt via results_only.
    dens = [(len(_result_numbers(p)), p) for p in _prose_paragraphs(tex, results_only=True)]
    over = sorted([d for d in dens if d[0] > 3], key=lambda x: -x[0])
    R["number_density"] = {"ok": not over,
                           "detail": ("%d paragraphs exceed 3 result numbers (worst %d: '%s...')"
                                      % (len(over), over[0][0], re.sub(r"\s+", " ", over[0][1])[:70])) if over
                           else "all paragraphs <=3 result numbers"}

    # ---- tables: the house iron rules
    tables = re.findall(r"\\begin\{table\*?\}.*?\\end\{table\*?\}", tex, re.S)
    tab_bad = []
    for i, t in enumerate(tables):
        if "\\pm" in t or "±" in t:
            tab_bad.append("table %d: uses +/-" % (i + 1))
        if "\\resizebox" in t:
            tab_bad.append("table %d: resizebox" % (i + 1))
        if re.search(r"&\s*,\s*(?:&|\\\\)", t):
            tab_bad.append("table %d: empty ',' cells" % (i + 1))
        cells = re.sub(r"\\caption(?:\[[^\]]*\])?\{(?:[^{}]|\{[^{}]*\})*\}", "", t)   # nesting-aware; caption is prose
        if re.search(r"\d\s*/\s*\d", cells):
            tab_bad.append("table %d: slash-composite values" % (i + 1))
        # '0.81 (n=739)' and '(12 runs)' are clutter; a header's '($\eta^2$)' is not, so inline math goes first
        if re.search(r"\([^)]*\d[^)]*\)", re.sub(r"\\label\{[^}]*\}|\$[^$]*\$", "", cells)):
            tab_bad.append("table %d: parenthetical stat clutter in cells" % (i + 1))
        # \begin{tabular}[t]{lrr}, \begin{tabular*}{\textwidth}{@{\extracolsep{\fill}}lrr}, tabularx{...}{...}
        m = re.search(r"\\begin\{tabular(?:\*|x)?\}(?:\[[^\]]*\])?(?:\{[^{}]*\})?\{((?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)\}", t)
        spec = m.group(1) if m else ""
        spec = re.sub(r"\*\{(\d+)\}\{([^{}]*)\}", lambda mm: mm.group(2) * int(mm.group(1)), spec)   # *{8}{c}
        spec = re.sub(r"[>@!<]\{(?:[^{}]|\{[^{}]*\})*\}", "", spec)                             # decorations
        if m and len(re.findall(r"[lcrSX]|[pmb]\{[^}]*\}", spec)) > 6:
            tab_bad.append("table %d: >6 columns" % (i + 1))
        if not m:
            tab_bad.append("table %d: %s" % (i + 1, "unparsed tabular column spec" if "\\begin{tabular" in t
                                              else "no tabular environment found"))
    R["tables"] = {"ok": not tab_bad, "detail": "; ".join(tab_bad[:5]) or "%d table(s) clean" % len(tables)}

    # ---- prose: code-speak residue
    prose = " ".join(_prose_paragraphs(tex))
    prose_nomath = re.sub(r"\$[^$]*\$|\\\(.*?\\\)", "", prose, flags=re.S)   # \(...\) is math too
    speak = []
    for pat, why in ((r"[A-Za-z]+\\?_hat\b", "x_hat"), (r"\bsigma\b", "bare sigma"),
                     (r"\bR-squared\b", "R-squared"), (r"\b\d+(?:\.\d+)?e-?\d+\b", "1e-6 notation"),
                     (r"\b[A-Za-z]\\_[A-Za-z0-9]", "escaped-underscore variable (x\\_j)"),
                     (r"\\textasciicircum", "text-mode caret in math"),
                     (r"\uFFFD", "mojibake")):
        if re.search(pat, prose_nomath):
            speak.append(why)
    R["code_speak"] = {"ok": not speak, "detail": ("residue: " + ", ".join(speak)) if speak else "prose free of code-speak"}

    # ---- abstract: number-stripper wreckage. A comparison operator with its value gone ('q<)', 'd=-,') or a
    #      comparison word with nothing to compare ('( vs,') cannot occur in written prose -- it is the
    #      signature of a scrubber having eaten the number, which is how the plant paper shipped its abstract.
    abs_txt = _abstract_text(tex, stages=stages, abstract=abstract)
    abs_bad = []
    for pat, why in ((r"[=<>]\s*[-−]?\s*(?=[,.;:)\]])", "comparison operator with no value ('q<)' / 'd=-,')"),
                     (r"[\(\[]\s*(?:vs\.?|to)\s*[,.;:)\]]", "comparison word with nothing to compare ('( vs,')"),
                     (r"[\(\[]\s*[,;:.\-−]+\s*[\)\]]", "parenthetical emptied of its contents")):
        if re.search(pat, abs_txt):
            abs_bad.append(why)
    if not abs_txt.strip():
        abs_bad.append("no abstract found in the tex")
    R["abstract_sane"] = {"ok": not abs_bad, "detail": "; ".join(abs_bad) or "abstract free of stripper wreckage"}

    # ---- figures: count, exemplar, referenced
    figs_in_tex = re.findall(r"\\begin\{figure\*?\}", tex)
    has_exemplar = "fdata" in tex
    labels = set(re.findall(r"\\label\{(fig:[^}]+)\}", tex))
    refs = set(re.findall(r"\\ref\{(fig:[^}]+)\}", tex))
    unref = sorted(labels - refs)
    n_figs = len(figs_in_tex)
    R["fig_count"] = {"ok": 3 <= n_figs <= 7, "detail": "%d figure envs (band 3-7 incl. exemplar)" % n_figs}
    R["fig_exemplar"] = {"ok": has_exemplar, "detail": "raw-data exemplar present" if has_exemplar else "no raw-data exemplar figure"}
    R["fig_referenced"] = {"ok": not unref, "detail": ("unreferenced: " + ", ".join(unref)) if unref else "every figure referenced"}

    # ---- typesetting: overfull hboxes (a >20pt overfull = visible overlap/protrusion, e.g. a huge inline
    #      set-enumeration equation crashing into the neighbouring column)
    clog = compile_log or ""
    over, missing_chars = [], set()
    _seen_over = set()
    if os.path.exists(clog):
        _cl = open(clog, errors="ignore").read()
        # tectonic prints each box twice (its own 'warning:' summary plus the raw TeX line): dedupe on (pt, lines)
        for m in re.finditer(r"Overfull \\hbox \((\d+(?:\.\d+)?)pt too wide\)(?:[^\n]*?\blines?\s+(\d+(?:--\d+)?))?", _cl):
            key = (m.group(1), m.group(2))
            if float(m.group(1)) > 20 and key not in _seen_over:
                _seen_over.add(key); over.append(float(m.group(1)))
        for m in re.finditer(r"Missing character: There is no (\S+)", _cl):
            missing_chars.add(m.group(1))
    R["overfull"] = {"ok": not over and os.path.exists(clog),
                     "detail": ("%d overfull hbox(es) >20pt, worst %.0fpt (content protrudes into margin/column)"
                                % (len(over), max(over))) if over else
                     ("no severe overfull boxes" if os.path.exists(clog) else "no compile.log next to the PDF (compile did not run?)")}
    R["missing_glyphs"] = {"ok": not missing_chars,
                           "detail": ("glyphs silently DROPPED from the PDF: " + " ".join(sorted(missing_chars)[:8]))
                           if missing_chars else "no missing-character warnings"}

    # ---- ideation paradigm (research pipeline only: the skill has no ideation record, so the check is skipped)
    if ideation_json is not None:
        par = ""
        if os.path.exists(ideation_json):
            try:
                par = str(json.load(open(ideation_json)).get("paradigm", "")).strip()
            except Exception:
                pass
        R["paradigm"] = {"ok": bool(par), "detail": ("paradigm=" + par) if par else "no paradigm field on the idea"}

    doc.close()
    for k in skip:
        R.pop(k, None)
    R["_ok"] = all(v["ok"] for k, v in R.items() if k != "_ok")
    return R


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--task")
    ap.add_argument("--stages", help="explicit stages dir (overrides --task)")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    if not (a.task or a.stages):
        ap.error("--task or --stages required")
    stages = a.stages or os.path.join(HERE, "..", "examples", a.task, "stages")
    R = lint(stages)
    if a.json:
        print(json.dumps(R, indent=1))
    else:
        for k, v in R.items():
            if k == "_ok":
                continue
            print("%s %-16s %s" % ("PASS" if v["ok"] else "FAIL", k, v["detail"]))
        print("=> " + ("ALL GREEN" if R["_ok"] else "FAILING"))
    sys.exit(0 if R["_ok"] else 1)


if __name__ == "__main__":
    main()
