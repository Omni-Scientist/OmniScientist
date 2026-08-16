"""Turn an mmsci discovery into a real ICLR-format paper compiled to PDF (via tectonic).

The writeup stage produces LaTeX section content (NOT markdown); we substitute it into the official ICLR
template (mmsci/template/, the iclr2025 style files) and compile with tectonic. The system's per-demo paper
is the DISCOVERY report about the subject itself (e.g. the galaxy); the cross-demo evaluation (ON vs OFF
referee scores) is reported separately, not inside the paper.
"""
import os, re, shutil, subprocess, json, urllib.request, urllib.parse

# Prefer a tectonic on PATH; fall back to a common user-local install; else the bare name so PATH resolves at call time.
_TECTONIC_LOCAL = os.path.expanduser("~/.local/bin/tectonic")
TECTONIC = shutil.which("tectonic") or (_TECTONIC_LOCAL if os.path.exists(_TECTONIC_LOCAL) else "tectonic")
_HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE_DIR = os.path.join(_HERE, "..", "template")
# venue-appropriate templates, picked by the target journal (config `template:` / the skill maps the journal name).
# iclr/neurips -> ML conference; rnaas -> AAS Research Note (short single-result brief); aastex -> full ApJ/AJ article.
TEMPLATES = {"iclr": TEMPLATE_DIR,
             "rnaas": os.path.join(_HERE, "..", "template_rnaas"),
             "aastex": os.path.join(_HERE, "..", "template_aastex")}
SECTIONS = ["TITLE", "ABSTRACT", "INTRODUCTION", "RELATED WORK", "BACKGROUND", "METHOD",
            "EXPERIMENTAL SETUP", "EXPERIMENTS", "CONCLUSION", "FIGURE CAPTION"]
_PLACEHOLDER = {"TITLE": "TITLE HERE", "ABSTRACT": "ABSTRACT HERE", "INTRODUCTION": "INTRO HERE",
                "RELATED WORK": "RELATED WORK HERE", "BACKGROUND": "BACKGROUND HERE", "METHOD": "METHOD HERE",
                "EXPERIMENTAL SETUP": "EXPERIMENTAL SETUP HERE", "EXPERIMENTS": "RESULTS HERE",
                "CONCLUSION": "CONCLUSIONS HERE"}


OPENALEX_MAIL = os.environ.get("OPENALEX_MAIL_ADDRESS", "mmsci-engine@example.org")

STAGED_TIPS = {
    "TITLE": "A real published-journal paper title: ONE line, under ~15 words, NO trailing dash/colon, NO stacked "
             "clauses, NO question mark. Name the CONTRIBUTION and the object in the journal style "
             "'<the measurement or finding> of <the object>' or '<object>: <one specific finding>' (e.g. 'A "
             "<quantity> estimate for <the object>'). Do not list every result.",
    "ABSTRACT": "A standard journal abstract for this field (no storytelling): one-sentence context, the data and "
                "analysis, the main quantitative result (clearly separating measured-from-image vs assumed inputs), "
                "and the conclusion. The way a real published abstract reads.",
    "INTRODUCTION": "A standard Introduction for this field: background and why the object/problem matters, what is "
                    "known and what is open, and the specific aim of this work; end with the main result or a brief "
                    "road-map. Conventional and professional, NOT a narrative.",
    "RELATED WORK": "Situate the object against known classes and prior observations of similar systems. Compare and "
                    "contrast, do not merely list. Cite ONLY the supplied real references.",
    "BACKGROUND": "Define the concepts a reader needs: what the measured statistics mean and the object class being "
                  "considered. Introduce no new numbers.",
    "METHOD": "How the object was characterized: direct visual examination of the image plus the listed measured "
              "statistics; which visible features support or weaken each competing hypothesis. Do NOT restate the "
              "data description that belongs in Experimental Setup.",
    "EXPERIMENTAL SETUP": "ONLY the data + analysis setup (a single optical cutout; direct examination plus the listed "
                          "measured statistics; no instrument/hardware). Do NOT repeat the Method's reasoning.",
    "EXPERIMENTS": "Report what was actually seen and the measured statistics; contrast the interpretation with the "
                   "numbers-only reading; say which hypothesis the evidence favours and which it cannot exclude. "
                   "Reference the figure where relevant.",
    "CONCLUSION": "State the result in one or two sentences, what remains unresolved, and the single observation "
                  "that would resolve it. End on a complete sentence.",
    "FIGURE CAPTION": "One sentence describing ONLY the plain image of the subject (no overlays/markers/panels -- "
                      "those belong to the analysis figure).",
}

# ---- field writing conventions = PRIOR KNOWLEDGE (not a binding): each field's standard structure / section
# emphasis / default venue. The skill selects by `field:` (or infers from the template); demos just save an input. ----
ASTRO_TIPS = {   # astronomy (ApJ/MNRAS/RNAAS): Intro -> Observations/Data -> Analysis -> Results -> Discussion
    "INTRODUCTION": "A standard astronomy Introduction: the astrophysical context and why this object/question "
                    "matters, what is known and open (cite the supplied references), and the aim of this work. "
                    "Related work is woven in here, NOT a separate section.",
    "EXPERIMENTAL SETUP": "The 'Observations and Data' content: the imaging data used, its origin and pixel scale, "
                          "and exactly what is measured directly from it. Invent no instrument.",
    "METHOD": "The 'Analysis' content: the morphometric statistics and any quantitative analysis applied to the "
              "data, and which visible features bear on each competing hypothesis.",
    "EXPERIMENTS": "The 'Results' content: the measured and derived quantities (separate measured-from-image vs "
                   "assumed inputs), referencing the figure; state which interpretation the evidence favours.",
    "CONCLUSION": "The 'Discussion / Conclusions' content: interpret the results against the competing hypotheses, "
                  "the limitations, and the single follow-up observation that would resolve them.",
}
BIO_TIPS = {     # biology (Nature/Cell): Intro -> Results (FIRST) -> Discussion -> Methods (last, lightweight)
    "EXPERIMENTS": "The 'Results' content -- the heart of a biology paper, presented before Methods: what was found, "
                   "with the measured quantities and the figure.",
    "CONCLUSION": "The 'Discussion' content: the significance of the results and their limitations.",
    "METHOD": "The 'Methods' content (placed last and kept concise in biology): how the data were obtained and analysed.",
}
CHEM_TIPS = {    # chemistry (JACS/Angew): Intro -> Results and Discussion (combined, central) -> Conclusion -> Experimental
    "INTRODUCTION": "A standard chemistry Introduction: the context and significance of this compound/class, what is "
                    "known, and the aim. Related work is woven in here.",
    "EXPERIMENTS": "The 'Results and Discussion' content (the core of a chemistry paper): the structural assignment "
                   "made from the image -- skeleton, rings, functional groups, heteroatoms -- and the chemistry that "
                   "follows (likely properties / reactivity), reasoned from the structure. Reference the figure.",
    "CONCLUSION": "A brief Conclusion: the identification/assignment and its significance, and what would confirm it.",
    "METHOD": "The 'Experimental' / methods content (placed last in chemistry): the basis of the analysis -- here, "
              "direct structural reading of the depicted formula; state that no spectra or computation were performed.",
}
FIELDS = {
    "ml":    {"template": "iclr",  "tips": {},
              "use": ["TITLE", "ABSTRACT", "INTRODUCTION", "RELATED WORK", "METHOD", "EXPERIMENTS", "CONCLUSION", "FIGURE CAPTION"]},
    "astro": {"template": "rnaas", "tips": ASTRO_TIPS,
              "use": ["TITLE", "ABSTRACT", "INTRODUCTION", "EXPERIMENTAL SETUP", "METHOD", "EXPERIMENTS", "CONCLUSION", "FIGURE CAPTION"]},
    "bio":   {"template": "iclr",  "tips": BIO_TIPS,     # TODO: a dedicated bio template (IMRaD with Methods last)
              "use": ["TITLE", "ABSTRACT", "INTRODUCTION", "EXPERIMENTS", "CONCLUSION", "METHOD", "FIGURE CAPTION"]},
    "chem":  {"template": "iclr",  "tips": CHEM_TIPS,    # TODO: a dedicated chem (JACS-style) template
              "use": ["TITLE", "ABSTRACT", "INTRODUCTION", "EXPERIMENTS", "CONCLUSION", "METHOD", "FIGURE CAPTION"]},
}


def field_of(C):
    """Resolve the field as PRIOR KNOWLEDGE, never a hard binding: explicit C['field'], else inferred from the
    template, else 'ml'. Used to pick the field's standard writing conventions."""
    if C.get("field") in FIELDS:
        return C["field"]
    return "astro" if C.get("template") in ("rnaas", "aastex") else "ml"


def _parse_json_list(txt):
    m = re.search(r"\[(?:[^\[\]]|\[[^\]]*\])*\]", txt or "", re.S)
    if not m:
        return []
    try:
        v = json.loads(m.group(0))
        return [str(x).strip() for x in v if str(x).strip()] if isinstance(v, list) else []
    except Exception:
        return []


_BIB_GREEK = {"α": "alpha", "β": "beta", "γ": "gamma", "δ": "delta", "ε": "epsilon", "θ": "theta", "κ": "kappa",
              "λ": "lambda", "μ": "mu", "π": "pi", "ρ": "rho", "σ": "sigma", "τ": "tau", "φ": "phi", "ω": "omega",
              "Δ": "Delta", "Ω": "Omega", "→": "to", "−": "-", "–": "-", "—": "-", "‐": "-", "‑": "-", "‒": "-"}


def _bib_escape(s):
    s = re.sub(r"<[^>]+>", "", s)        # strip HTML tags OpenAlex leaves in titles (e.g. <i>Ilex paraguariensis</i>)
    for u, name in _BIB_GREEK.items():   # bib titles are plain text -> transliterate unicode greek/arrows to ASCII names
        s = s.replace(u, name)
    for a, b in (("\\", ""), ("&", "\\&"), ("%", "\\%"), ("_", "\\_"), ("#", "\\#"), ("$", "\\$"), ("~", "-"), ("^", "")):
        s = s.replace(a, b)
    return s


def _bib_entry(key, p):
    authors = " and ".join(p["authors"]) if p["authors"] else "Anonymous"
    title = _bib_escape(re.sub(r"[{}]", "", (p["title"] or "Untitled"))).strip()
    fields = ["  title={" + title + "}", "  author={" + _bib_escape(authors) + "}"]
    if p.get("year"):
        fields.append("  year={" + str(p["year"]) + "}")
    if p.get("venue"):
        fields.append("  journal={" + _bib_escape(p["venue"]) + "}")
    if p.get("volume"):
        fields.append("  volume={" + _bib_escape(str(p["volume"])) + "}")
    if p.get("pages"):
        fields.append("  pages={" + _bib_escape(str(p["pages"])) + "}")
    return "@article{" + key + ",\n" + ",\n".join(fields) + "\n}"


def _filter_cites(s, known):
    """Drop any \\cite{...}/\\citep/\\citet key not in `known` (keeps the PDF from breaking on a hallucinated key)."""
    def rep(m):
        good = [k.strip() for k in m.group(2).split(",") if k.strip() in known]
        return "\\" + m.group(1) + "{" + ",".join(good) + "}" if good else ""
    return re.sub(r"\\(cite[a-zA-Z]*)\{([^}]*)\}", rep, s or "")


def _openalex(query, n, log):
    try:
        qs = urllib.parse.urlencode({"search": query, "per_page": n, "mailto": OPENALEX_MAIL,
                                     "select": "title,publication_year,authorships,primary_location,biblio"})
        req = urllib.request.Request("https://api.openalex.org/works?" + qs,
                                     headers={"User-Agent": "mmsci/1.0 mailto:" + OPENALEX_MAIL})
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read().decode())
    except Exception as e:
        log("  [cite] OpenAlex query failed (" + repr(query) + "): " + type(e).__name__)
        return []
    res = []
    for w in data.get("results", []):
        if not w.get("title"):
            continue
        auth = [a.get("author", {}).get("display_name", "") for a in (w.get("authorships") or [])[:10]]
        venue = ((w.get("primary_location") or {}).get("source") or {}).get("display_name") or ""
        b = w.get("biblio") or {}
        pages = (b.get("first_page") or "") + (("-" + b["last_page"]) if b.get("last_page") else "")
        res.append({"title": w["title"], "year": w.get("publication_year"), "authors": [a for a in auth if a],
                    "venue": venue, "volume": b.get("volume") or "", "pages": pages})
    return res


def _crossref(query, n, log):
    """Fallback citation source (Crossref) for when OpenAlex is unreachable/rate-limited, so a transient outage of
    one provider does not strip a paper of its References. Same dict shape as _openalex; never fabricates on failure."""
    try:
        qs = urllib.parse.urlencode({"query": query, "rows": n,
                                     "select": "title,author,issued,container-title,volume,page"})
        req = urllib.request.Request("https://api.crossref.org/works?" + qs,
                                     headers={"User-Agent": "mmsci/1.0 (mailto:" + OPENALEX_MAIL + ")"})
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read().decode())
    except Exception as e:
        log("  [cite] Crossref query failed (" + repr(query) + "): " + type(e).__name__)
        return []
    res = []
    for w in ((data.get("message") or {}).get("items") or []):
        title = (w.get("title") or [""])[0]
        if not title:
            continue
        auth = [((a.get("given", "") + " " + a.get("family", "")).strip()) for a in (w.get("author") or [])[:10]]
        dp = ((w.get("issued") or {}).get("date-parts") or [[None]])[0] or [None]
        res.append({"title": title, "year": dp[0], "authors": [a for a in auth if a],
                    "venue": (w.get("container-title") or [""])[0] or "", "volume": w.get("volume") or "",
                    "pages": w.get("page") or ""})
    return res


def _keygen(p, used):
    base = "anon"
    if p["authors"]:
        base = re.sub(r"[^a-z]", "", p["authors"][0].split()[-1].lower()) or "anon"
    base += str(p.get("year") or "")
    k, i = base, 0
    while (not k) or (k in used):
        k = base + "abcdefghijklmnop"[i % 16]
        i += 1
    used.add(k)
    return k


_CITE_STOP = set(("the a an of and or to in on for with from this that these those study data using based between across "
                  "within results result method methods analysis approach paper work model models dataset datasets "
                  "benchmark benchmarks deep learning machine neural network networks detection classification feature "
                  "features novel using toward towards efficient training test").split())


def _anchor_words(s):
    """Domain-specific content words of the subject/idea (generic ML/paper words removed) -- used to reject off-topic
    references. Stripping words like 'benchmark'/'deep'/'learning' is what stops a broad query from pulling a
    'grapevine pest benchmark' or 'bionic leg' paper into a seismology bibliography."""
    return set(w for w in re.findall(r"[a-z]{4,}", (s or "").lower()) if w not in _CITE_STOP)


def _relevant(p, anchor):
    """Keep a candidate reference only if its title/abstract shares >=2 domain-anchor words with the study (drops the
    off-topic noise the citation APIs return for a broad query). No anchor -> keep (do not over-filter)."""
    if not anchor:
        return True
    text = (str(p.get("title", "")) + " " + str(p.get("abstract", ""))).lower()
    return sum(1 for w in anchor if w in text) >= 2


def gather_citations(chat, model, C, idea, obs, log=print, use=True, n_queries=6, per_query=6, max_refs=16):
    """Real references from OpenAlex (keyless, the default engine). Returns (catalog[(key,paper)], bibtex_str).
    Never fabricates: on any failure it logs and returns ([], '') so the writer falls back to citation-free prose.
    Off-topic API noise is dropped by a domain-anchored relevance filter (so no grapevine-pest / bionic-leg refs)."""
    if not use:
        log("  [cite] citations disabled -> citation-free build")
        return [], ""
    try:
        raw = chat("You are " + C["role"] + ". To write the Related Work of a short report about a " + C["subject"]
                   + ", propose " + str(n_queries) + " concise literature-search queries (3-7 words each) to find REAL "
                   "prior work on THIS specific object/class -- each query MUST name the domain/object (not a generic "
                   "phrase like 'benchmark dataset' or 'deep learning' that would match unrelated fields). Observation: "
                   + (obs or "")[:500] + ". Hypothesis: " + (idea or "")[:300] + ". Return ONLY a JSON array of strings.",
                   model, 200)
    except Exception as e:
        log("  [cite] query generation failed: " + type(e).__name__)
        return [], ""
    queries = _parse_json_list(raw)[:n_queries] or [C["subject"]]
    anchor = _anchor_words(str(C.get("subject", "")) + " " + (idea or "") + " " + (obs or ""))
    def _overlap(p):                                       # count of domain-anchor words in the candidate's title/abstract
        if not anchor:
            return 2
        text = (str(p.get("title", "")) + " " + str(p.get("abstract", ""))).lower()
        return sum(1 for w in anchor if w in text)
    used, catalog, spare, dropped = set(), [], [], 0
    for q in queries:
        for p in (_openalex(q, per_query, log) or _crossref(q, per_query, log)):   # OpenAlex first, Crossref fallback
            if len(catalog) >= max_refs:
                break
            t = p.get("title", "")
            if any(t == c[1]["title"] for c in catalog) or any(t == s[1].get("title") for s in spare):
                continue
            ov = _overlap(p)
            if ov >= 2:                                    # clearly on-topic
                catalog.append((_keygen(p, used), p))
            elif ov >= 1:                                  # shares one anchor -> hold as backfill (not garbage, not certain)
                spare.append((ov, p))
            else:
                dropped += 1                               # 0 anchors = off-topic API noise (grapevine / bionic) -> drop
    if len(catalog) < 6 and spare:                         # the strict >=2 filter left too few -> backfill the best 1-anchor refs
        added = 0
        for ov, p in sorted(spare, key=lambda x: -x[0]):
            if len(catalog) >= 8:
                break
            catalog.append((_keygen(p, used), p)); added += 1
        log("  [cite] backfilled %d single-anchor reference(s) so the bibliography is not too thin" % added)
    if dropped:
        log("  [cite] dropped %d off-topic reference(s) by relevance filter" % dropped)
    bib = "\n\n".join(_bib_entry(k, p) for k, p in catalog)
    log(("  [cite] " + str(len(catalog)) + " real references gathered (OpenAlex/Crossref)") if catalog
        else "  [cite] no references found -> citation-free build (honest fallback)")
    return catalog, bib


def _trim_incomplete(s):
    """Drop a truncated trailing sentence (cut off mid-clause by a token limit). Conservative: only trims when the
    text does NOT already end on terminal punctuation; uses 'punctuation + space' boundaries so decimals are safe."""
    s = (s or "").rstrip()
    if not s or re.search(r"[.!?][)\]}'\"$]*$", s):        # already ends cleanly
        return s
    cuts = list(re.finditer(r"[.!?][)\]}'\"]*\s", s + " "))   # sentence ends = terminal punct + space (skips '2.269')
    return s[:cuts[-1].end()].rstrip() if cuts else s


_UNI = {"θ": r"\theta", "σ": r"\sigma", "Θ": r"\Theta", "Σ": r"\Sigma", "α": r"\alpha", "β": r"\beta",
        "γ": r"\gamma", "δ": r"\delta", "Δ": r"\Delta", "Ω": r"\Omega", "λ": r"\lambda", "μ": r"\mu",
        "ν": r"\nu", "π": r"\pi", "ρ": r"\rho", "τ": r"\tau", "φ": r"\phi", "χ": r"\chi", "ψ": r"\psi"}
_UNI2 = {"×": r"$\times$", "≈": r"$\approx$", "≤": r"$\leq$", "≥": r"$\geq$", "±": r"$\pm$",
         "−": "-", "·": r"$\cdot$", "→": r"$\rightarrow$", "⊙": r"$_\odot$",
         "Å": r"\AA{}", "²": r"\textsuperscript{2}", "³": r"\textsuperscript{3}", "°": r"\textdegree{}",
         "–": "--", "—": "---", "‐": "-", "∼": r"$\sim$", "≃": r"$\simeq$", "≠": r"$\neq$", "Φ": r"$\Phi$"}


def _fix_unicode_math(s):
    """Wrap stray unicode greek (+ an adjacent _subscript) into inline math, OUTSIDE existing $...$ -- fixes e.g.
    'θ_E' (which renders as 'fi_E' / a bare-underscore error in text mode) -> '$\\theta_E$'. Deterministic, general."""
    if not s:
        return s
    spans = []
    s = re.sub(r"\$[^$]*\$", lambda m: spans.append(m.group(0)) or "\x00M%d\x00" % (len(spans) - 1), s)
    for u, tex in _UNI.items():
        s = re.sub(re.escape(u) + r"(?:_\{?([A-Za-z0-9]+)\}?)?",
                   lambda m, t=tex: "$" + t + ("_{" + m.group(1) + "}" if m.group(1) else "") + "$", s)
    for u, tex in _UNI2.items():
        s = s.replace(u, tex)
    s = re.sub(r"[^\x00-\x7F]", "", s)                         # drop any remaining non-ASCII outside math (compile safety)
    s = re.sub(r"\$([^$]+)\$ ?\$([^$]+)\$", r"$\1 \2$", s)     # merge adjacent inline-math runs
    for i, sp in enumerate(spans):
        s = s.replace("\x00M%d\x00" % i, sp)
    return s


def _wset(s):
    return set(re.sub(r"[^a-z0-9 ]", " ", s.lower()).split())


def _clean_title(t):
    """Title hygiene: unwrap commands, single line, drop a trailing dash/colon (truncated tail), cap the length to
    one clause -- so a model's over-long, multi-clause, dangling-dash title becomes a real paper title."""
    t = re.sub(r"^\s*\\title\*?\{(.*)\}\s*$", r"\1", (t or "").strip(), flags=re.S)
    t = re.sub(r"\\[a-zA-Z]+\*?\{([^{}]*)\}", r"\1", t)       # unwrap \cmd{X} -> X
    t = re.sub(r"\\(?:textbf|textit|texttt|textsc|textrm|textnormal|emph|mathbf|mathrm|mathit|underline|"
               r"boldsymbol|text|bf|it|em)\s*", "", t)        # strip glued formatting prefixes (\textbfComplete -> Complete)
    t = re.sub(r"\\[a-zA-Z]+\*?(?![a-zA-Z])", "", t)          # drop any remaining standalone control sequence (\LaTeX, ...)
    t = re.sub(r"\s+", " ", re.sub(r"[{}]", "", t)).strip().strip('"')
    t = re.sub(r"\s*[-–—:;,]+\s*$", "", t)                    # drop a dangling dash/colon/comma (truncated tail)
    if len(t) > 140:                                          # too long / multi-clause -> keep the first clause
        head = re.split(r"\s*[:;]\s*", t)[0]
        t = head if 25 < len(head) <= 140 else t[:140].rsplit(" ", 1)[0]
        t = re.sub(r"\s*[-–—:;,]+\s*$", "", t)
    return t


def _esc(s):
    """Escape raw LaTeX specials, but NOT inside math ($...$) and not in the figure ref/label. Also unicode-safe:
    a grounded caption can re-introduce raw unicode (Å, superscript-2, en-dash) that breaks compilation."""
    s = _fix_unicode_math(s or "")                      # convert / strip raw unicode (Å, ^2, en-dash, greek, ...)
    spans = []
    # protect DISPLAY math (\begin{equation|align}, \[..\]) as well as inline $..$: an '_' or '^' there is a sub/
    # superscript, NOT a literal, so it must NOT be escaped (else \lambda_2 -> \lambda\_2 renders as a literal underscore).
    s = re.sub(r"\\begin\{(equation|align|displaymath)\*?\}.*?\\end\{\1\*?\}",
               lambda m: spans.append(m.group(0)) or f"\x00M{len(spans)-1}\x00", s, flags=re.S)
    s = re.sub(r"\\\[.*?\\\]", lambda m: spans.append(m.group(0)) or f"\x00M{len(spans)-1}\x00", s, flags=re.S)
    s = re.sub(r"\$[^$]*\$", lambda m: spans.append(m.group(0)) or f"\x00M{len(spans)-1}\x00", s)
    s = s.replace("$", "\\$")                           # any UNPAIRED $ left (e.g. a truncated equation) -> literal dollar, never opens math
    s = s.replace("fig:first_figure", "\x00FIG\x00")
    for ch in ("_", "%", "&", "#"):
        s = re.sub(r"(?<!\\)" + re.escape(ch), lambda m, c=ch: "\\" + c, s)
    # '^' is a text-mode ACTIVE char: a bare caret in prose/captions (e.g. writer text '(f/fc)^2', 'eta^2') triggers
    # 'Missing $ inserted' and kills the build. Its backslash form \^ is an ACCENT command (\^o -> o-circumflex), NOT a
    # literal, so map to the control word instead. Real sub/superscripts sit in the math spans protected above; the
    # (?<!\\) guard preserves an intentional accent. ('~' is deliberately left alone: a bare tilde is a valid
    # non-breaking space, does NOT crash, and may be an intentional 'Figure~\ref' tie.)
    s = re.sub(r"(?<!\\)\^", lambda m: "\\textasciicircum{}", s)
    s = s.replace("\x00FIG\x00", "fig:first_figure")
    for i, sp in enumerate(spans):
        s = s.replace(f"\x00M{i}\x00", sp)
    return s


def _sanitize_body(s):
    """Compile-safe: strip stray \\section/\\title headers and \\begin{abstract}/document wrappers; escape specials."""
    s = (s or "").strip()
    s = re.sub(r"^\s*\\(?:section|subsection|paragraph|title)\*?\{[^{}]*\}\s*", "", s)
    s = re.sub(r"\\(?:begin|end)\{(?:abstract|document)\}", "", s)
    s = re.sub(r"\b(The|A|An|We|This|That|It|In|Of|To|And|Is|Are)\s+\1\b", r"\1", s)   # collapse accidental doubled words
    if s.count("$") % 2:                                # a truncated/dangling open-$ fragment -> drop from the last $ onward
        s = s[:s.rfind("$")].rstrip()
    return _esc(s)


def _latex_escape_title(t):
    t = re.sub(r"^\s*\\title\*?\{(.*)\}\s*$", r"\1", (t or "").strip(), flags=re.S)   # the LLM often wraps in \title{}
    t = re.sub(r"\\[a-zA-Z]+\*?\{([^{}]*)\}", r"\1", t)                                # unwrap \textbf{...} etc.
    t = re.sub(r"[{}]", "", re.sub(r"\s+", " ", t)).strip()
    return _esc(t)[:300] or "An Autonomous Discovery Report"


def _prune_empty_sections(tex):
    r"""Drop hard-coded \section{...} headings whose body ended up empty -- a field omits that section (chemistry
    has no 'Related Work'/'Experimental Setup'), or the template's Background/Appendix was never filled. Keeps the
    shared template generic across fields without leaving bare headings. Only removes provably empty spans, so it is
    a no-op on a fully-written paper (e.g. the astro/rnaas demo)."""
    bnd = re.compile(r"\\section\*?\{[^}]*\}|\\bibliography\b|\\end\{document\}")
    heads = list(re.finditer(r"\\section\*?\{[^}]*\}[ \t]*\n?", tex))
    cut = []
    for m in heads:
        nxt = bnd.search(tex, m.end())
        end = nxt.start() if nxt else len(tex)
        body = re.sub(r"\\label\{[^}]*\}", "", tex[m.end():end])   # labels are not content
        body = re.sub(r"(?m)^\s*%.*$", "", body)                   # comment lines are not content
        if not body.strip():
            cut.append((m.start(), end))
    for a, b in reversed(cut):
        tex = tex[:a] + tex[b:]
    return tex


