# -*- coding: utf-8 -*-
"""Per-field VENUE visual templates for stage-3 papers, keyed by paper_specs.style_of().

Each FIELD_SPECS style maps to the real venue family it targets, and gets a visually distinct LaTeX skin:
  cs_ml       -> NeurIPS / ICLR / ACL : single-column, 10pt, ~5.5in, centered indented Abstract, serif bold sections
  biomed      -> Nature / Radiology   : single-column, 11pt, wide, ruled bold-lead Abstract, sans-serif sections
  earth_space -> AGU / GJI / ApJ       : two-column, serif, left bold numbered sections
  physics     -> PRL / PRD (REVTeX)    : two-column, small-caps centered section headings
  chem        -> JACS / npj (ACS)      : two-column, sans-serif bold section headings

reskin(tex, style) re-casts an assembled single-column (cs_ml) paper .tex into the target style. Single-column
targets just swap the preamble; two-column targets also span the title+abstract across both columns (\\twocolumn[..])
and widen figures to figure*. It is DEFENSIVE: any parse miss or unknown style returns the input unchanged (cs_ml),
which is known to compile -- a venue skin can never cost us the PDF.
"""
import re

_BASE_PKGS = ("\\usepackage[T1]{fontenc}\n\\usepackage{times}\n"
    "\\usepackage{graphicx}\n\\usepackage{float}\n\\usepackage{booktabs}\n\\usepackage{array}\n"
    "\\usepackage{multirow}\n\\usepackage{amsmath,amssymb}\n\\usepackage{bm}\n\\usepackage{natbib}\n"
    # natbib + 作者-年份样式下，裸 \cite 等价于 \citet，渲染成「Kather et al. [2016]」
    # 没有括号。写作端几乎总是在句末做旁引，于是正文变成「... quantitatively Kather
    # et al. [2016].」这种半截话。把 \cite 定向到 \citep，旁引才带括号；显式写
    # \citet / \citep 的地方不受影响。
    "\\let\\cite\\citep\n"
    "\\usepackage{caption}\n\\captionsetup{font=small,labelfont=bf,labelsep=period}\n"
    "\\usepackage[hidelinks]{hyperref}\n\\usepackage{cleveref}\n\\usepackage{titlesec}\n")

# cs_ml -> NeurIPS single-column
P_CSML = ("\\documentclass[10pt]{article}\n" + _BASE_PKGS +
    "\\usepackage[letterpaper,left=1.5in,right=1.5in,top=1in,bottom=1in]{geometry}\n"
    "\\titleformat{\\section}{\\large\\bfseries}{\\thesection}{0.6em}{}\n"
    "\\titleformat{\\subsection}{\\normalsize\\bfseries}{\\thesubsection}{0.6em}{}\n"
    "\\titleformat{\\subsubsection}{\\normalsize\\bfseries\\itshape}{\\thesubsubsection}{0.6em}{}\n"
    "\\titlespacing*{\\section}{0pt}{2.4ex plus 1ex minus .2ex}{1.3ex plus .2ex}\n"
    "\\renewcommand{\\abstractname}{Abstract}\n"
    "\\renewenvironment{abstract}{\\centerline{\\normalsize\\bfseries\\abstractname}\\vspace{0.3ex}"
    "\\begin{quote}\\small}{\\end{quote}\\vspace{0.4ex}}\n"
    "\\setlength{\\parindent}{1.2em}\\setlength{\\parskip}{3pt}\\graphicspath{{figures/}}\n")

# biomed -> Nature/Radiology single-column: 11pt, sans-serif bold headings, ruled bold-lead abstract
P_BIOMED = ("\\documentclass[11pt]{article}\n" + _BASE_PKGS + "\\usepackage{helvet}\n"
    "\\usepackage[margin=1in]{geometry}\n"
    "\\titleformat{\\section}{\\large\\sffamily\\bfseries}{\\thesection}{0.6em}{}\n"
    "\\titleformat{\\subsection}{\\normalsize\\sffamily\\bfseries}{\\thesubsection}{0.6em}{}\n"
    "\\titlespacing*{\\section}{0pt}{2.4ex plus 1ex}{1.2ex}\n"
    "\\renewenvironment{abstract}{\\vspace{0.4ex}\\hrule\\vspace{1ex}\\noindent\\textbf{Abstract.\\ }\\small}"
    "{\\par\\vspace{1ex}\\hrule\\vspace{0.8ex}\\normalsize}\n"
    "\\setlength{\\parindent}{1.2em}\\setlength{\\parskip}{3pt}\\graphicspath{{figures/}}\n")

# earth_space -> AGU/GJI/ApJ two-column serif
P_EARTH = ("\\documentclass[twocolumn,10pt]{article}\n" + _BASE_PKGS +
    "\\usepackage[margin=0.75in]{geometry}\n"
    "\\titleformat{\\section}{\\normalsize\\bfseries}{\\thesection}{0.5em}{}\n"
    "\\titleformat{\\subsection}{\\small\\bfseries}{\\thesubsection}{0.5em}{}\n"
    "\\titlespacing*{\\section}{0pt}{1.8ex plus .8ex}{0.9ex}\n"
    "\\setlength{\\parindent}{1em}\\setlength{\\parskip}{2pt}\\graphicspath{{figures/}}\n")

# physics -> PRL/PRD two-column, small-caps centered section headings
P_PHYS = ("\\documentclass[twocolumn,10pt]{article}\n" + _BASE_PKGS +
    "\\usepackage[margin=0.7in]{geometry}\n"
    "\\titleformat{\\section}{\\small\\scshape\\bfseries\\centering}{\\thesection}{0.5em}{}\n"
    "\\titleformat{\\subsection}{\\small\\scshape}{\\thesubsection}{0.5em}{}\n"
    "\\titlespacing*{\\section}{0pt}{1.6ex plus .6ex}{0.8ex}\n"
    "\\setlength{\\parindent}{1em}\\setlength{\\parskip}{2pt}\\graphicspath{{figures/}}\n")

# chem -> JACS/npj (ACS) two-column, sans-serif bold section headings
P_CHEM = ("\\documentclass[twocolumn,10pt]{article}\n" + _BASE_PKGS + "\\usepackage{helvet}\n"
    "\\usepackage[margin=0.75in]{geometry}\n"
    "\\titleformat{\\section}{\\normalsize\\sffamily\\bfseries}{\\thesection}{0.5em}{}\n"
    "\\titleformat{\\subsection}{\\small\\sffamily\\bfseries}{\\thesubsection}{0.5em}{}\n"
    "\\titlespacing*{\\section}{0pt}{1.8ex plus .8ex}{0.9ex}\n"
    "\\setlength{\\parindent}{1em}\\setlength{\\parskip}{2pt}\\graphicspath{{figures/}}\n")

STYLE_PREAMBLES = {"cs_ml": P_CSML, "biomed": P_BIOMED, "earth_space": P_EARTH, "physics": P_PHYS, "chem": P_CHEM}
TWOCOL_STYLES = {"earth_space", "physics", "chem"}


def reskin(tex, style):
    """Re-cast an assembled single-column (cs_ml) paper .tex into `style`'s venue template. Defensive: any parse
    miss or unknown style returns `tex` unchanged (cs_ml is already the assembled form and is known to compile)."""
    try:
        pre = STYLE_PREAMBLES.get(style)
        if not pre or style == "cs_ml":
            return tex
        mt = re.search(r"\\title\{\\bfseries\s*(.*?)\}\s*\n", tex, re.S)
        ma = re.search(r"\\author\{(.*?)\}\s*\n", tex, re.S)
        mab = re.search(r"\\begin\{abstract\}(.*?)\\end\{abstract\}", tex, re.S)
        mb = re.search(r"\\end\{abstract\}(.*?)(\\bibliographystyle|\\bibliography\{|\\end\{document\})", tex, re.S)
        if not (mt and mab and mb):
            return tex
        title = mt.group(1).strip()
        author = ma.group(1).strip() if ma else "Anonymous"
        abstract = re.sub(r"^\\noindent\s*", "", mab.group(1).strip())
        body = mb.group(1).strip()
        mbb = re.search(r"(\\bibliographystyle\{[^}]*\}\s*\\bibliography\{[^}]*\})", tex)
        bib = mbb.group(1) if mbb else ""
        if style in TWOCOL_STYLES:
            # span figures AND tables across both columns (a single-column float can overflow a wide results table)
            body = re.sub(r"\\begin\{figure\}(\[[^\]]*\])?", "\\\\begin{figure*}[t]", body).replace("\\end{figure}", "\\end{figure*}")
            body = re.sub(r"\\begin\{table\}(\[[^\]]*\])?", "\\\\begin{table*}[t]", body).replace("\\end{table}", "\\end{table*}")
            head = ("\\begin{document}\n\\twocolumn[{%\n\\begin{center}\n{\\LARGE\\bfseries " + title +
                    "}\\\\[0.6em]\n{\\large " + author + "}\\\\[0.7em]\n\\end{center}\n"
                    "\\begin{center}\\begin{minipage}{0.9\\textwidth}\n"
                    "\\centerline{\\normalsize\\bfseries Abstract}\\vspace{0.4ex}\\small\\noindent " + abstract +
                    "\n\\end{minipage}\\end{center}\\vspace{1.1em}\n}]\n")
            return pre + head + body + "\n\n" + bib + "\n\n\\end{document}\n"
        return (pre + "\\title{\\bfseries " + title + "}\n\\author{" + author + "}\n\\date{}\n"
                "\\begin{document}\n\\maketitle\n\n\\begin{abstract}\n" + abstract +
                "\n\\end{abstract}\n\n" + body + "\n\n" + bib + "\n\n\\end{document}\n")
    except Exception as e:
        print("  [stage3] reskin skipped (%s) -> cs_ml" % e)
        return tex
