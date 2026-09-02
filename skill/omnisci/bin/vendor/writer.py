# -*- coding: utf-8 -*-
"""Stage-3 paper writer: field-aware, OUTLINE-then-EXPAND per section. Replaces the fragile multi-pass drafter
(gen_paper_staged + dedicated generators + qa/confident/scrub/expander post-passes) that whack-a-mole'd sections
empty or into single-paragraph walls.

For a chosen journal STYLE (paper_specs.FIELD_SPECS[style]) it walks the section list in order and, for each
section, expands its ORDERED paragraph jobs (one job -> one paragraph, grounded in the case's real data, cited
where the spec says) and joins them with blank lines -> guaranteed multi-paragraph, on-length, structured prose.
scrub/trim are injected (from agentic) so the failed/demoted path is removed deterministically, ONCE, and empty
returns are retried. Figures are interleaved by the caller into the section whose spec has floats == 'lead'."""
import os
import re
import paper_specs


_GUNK_VERBS = ("indicated|showed|revealed|suggested|confirmed|demonstrated|yielded|returned|gave|"
               "was|were|remained|reached|exceeded|dropped|rose|held")


def _degunk(before, after):
    """Repair the GRAMMAR WRECKAGE the stat-strippers leave behind (audit item 3): deleting 'z=-6.83' from
    'A z=-6.83 indicated ...' left the dangling 'A indicated ...'. Only wreckage the stripping CREATED is
    touched -- a phrase like 'the indicated region' that already existed in the input is never rewritten."""
    def _subj(m):
        if m.group(0) in before:                             # author's own phrasing (e.g. participle) -> keep
            return m.group(0)
        head = "The analysis" if m.group(1)[0].isupper() else "the analysis"
        return head + " " + m.group(2)
    after = re.sub(r"\b([Aa]n?|[Tt]he)\s+(%s)\b" % _GUNK_VERBS, _subj, after)
    if "of n " not in before:
        after = re.sub(r"\bof n\s+(?=[a-z]+s\b)", "of the ", after)   # 'of n events' after the count was stripped
    return re.sub(r"\s{2,}", " ", after).strip()


def _strip_stats(s):
    """Remove TEST STATISTICS from material fed to the abstract -- z/t/F/r = ... stats and p-values -- while keeping the
    effect numbers (AUC 0.73, drop 0.15) and prose. This is INPUT trimming (the abstract should never be handed a
    p-value), not an output guard. e.g. '(AUC 0.73 to 0.58, DeLong z=4.333, p=1.47e-5)' -> '(AUC 0.73 to 0.58)'."""
    s = _s0 = str(s or "")
    # (?<![A-Za-z]): without it the single-letter stat name matches the LAST LETTER OF A WORD, so 'weight=2'
    # became 'weigh' and 'power=0.8' became 'powe'.
    s = re.sub(r",?\s*(?:[A-Z][A-Za-z-]+\s+){0,2}(?:test\s+)?(?<![A-Za-z])[zZtTFrR]\s*=\s*-?\d[\d.eE+-]*", "", s)   # ', DeLong z=4.333'
    s = re.sub(r",?\s*\bp\s*[=<>]{1,2}\s*\d[\d.eE+-]*", "", s)                                          # ', p=1.47e-5' 'p<0.001'
    s = re.sub(r"\(\s*[,;]?\s*\)", "", s)                                                                # empty () left behind
    s = re.sub(r"\s+([,.;)])", r"\1", s)
    s = re.sub(r",\s*\)", ")", s)
    return _degunk(str(_s0), re.sub(r"\s{2,}", " ", s).strip())


def _scrub_abstract(s):
    """OUTPUT guard for the abstract. The soft 'at most 2 numbers' prompt + one retry FAIL on models that ignore the
    instruction (sonnet writes 0, but glm/minimax dump 31/72 numbers). Deterministically delete statistical FILLER --
    p-values / test stats (via _strip_stats), confidence intervals, n=, x/y counts, FDR, percentages -- while leaving
    effect-size numbers and prose. This is the output guard _strip_stats explicitly is NOT."""
    _s0 = str(s or "")
    s = _strip_stats(s)                                                                       # p / z=t=F=r=
    # \b around the name and a REQUIRED leading digit. Without them, case-insensitive 'CI' matched the 'ci'
    # INSIDE a word and the old trailing class (which contained e/t/o/space) then ate the letters after it:
    # 'species'->'spes', 'efficiency'->'effincy', 'coefficient'->'coeffint', 'ancient society'->'annt soy'.
    s = re.sub(r",?\s*(?:95\s*%?\s*)?\b(?:CI|confidence interval)\b\s*[:=]?\s*[-−]?\d[\d.eE+-]*"
               r"(?:\s*(?:,|to|-|–|−)\s*[-−]?\d[\d.eE+-]*)*", "", s, flags=re.I)   # 95% CI 2.25-4.77 / CI: 0.1 to 0.9
    s = re.sub(r"\s*[\(（]\s*\d+\s*/\s*\d+[^)）]*[\)）]", "", s)                   # (26/750, ...)
    s = re.sub(r",?\s*\b[nN]\s*=\s*\d[\d,]*", "", s)                                           # n=302
    s = re.sub(r",?\s*\bFDR\s+p[^,.;]*", "", s, flags=re.I)                                    # FDR p=0.34
    s = re.sub(r"\s*[\(（]\s*[,;]?\s*[\)）]", "", s)                                   # empty () left behind
    s = re.sub(r"\s+([,.;)）])", r"\1", s)
    s = re.sub(r",\s*\)", ")", s)
    return _degunk(str(_s0), re.sub(r"\s{2,}", " ", s).strip())


def _prose_only(s):
    """Reduce a THESIS to its claim IN WORDS before it becomes the abstract's MAIN-FINDING beat. _strip_stats removes
    p=/z= but leaves rho=/alpha=/x-of-y counts/bare percentages, and a numbers-dump-style backbone (glm: 'partial
    rho=-0.500, rho=0.732...'; minimax) then copies that 25-number list verbatim into the abstract. The MAIN-FINDING
    beat is a positive CLAIM in words -- the numbers live in Results -- so strip effect-DETAIL numbers here (the
    headline number, if any, comes from STUDY FACTS and rule-2 keeps at most two)."""
    _s0 = str(s or "")
    s = _strip_stats(_s0)
    # Spelled-out names keep the bare-space form; the single letter r/R does NOT. Without the boundaries a bare
    # 'r' matched inside a word and the bare-space value ate the next number: 'for 3 species'->'fo species',
    # 'sector 5 was excluded'->'secto was excluded'.
    s = re.sub(r",?\s*(?:partial\s+)?(?<![A-Za-z])(?:ρ|rho|σ|sigma|α|alpha)(?![A-Za-z])\s*[-=]?\s*[-−]?\d[\d.eE+/·-]*", "", s)   # rho=-0.500, sigma -0.812, alpha=0.05/36
    s = re.sub(r",?\s*(?:partial\s+)?(?<![A-Za-z])[rR]\s*=\s*[-−]?\d[\d.eE+/·-]*", "", s)                   # r=0.732 (explicit '=' only)
    s = re.sub(r"\b\d+\s*/\s*\d+\b", "", s)                                                    # 25/36
    s = re.sub(r"(?<![A-Za-z\d/])[-−]?\d+(?:\.\d+)?\s*%", "", s)                               # bare percentages 3.47%
    s = re.sub(r"(?<![A-Za-z\d/=.])[-−]?\d+(?:\.\d+)?(?![A-Za-z\d/%])", "", s)                 # remaining standalone numbers INCL negatives (-0.61) -- lookbehind no longer excludes '-'
    s = re.sub(r"[=＝]\s*-?[\d.eE/+·-]*\d", "", s)                                              # leftover '=0.00139' / '=0.05/36' tails
    s = re.sub(r"\bCI\b\s*[-–—]*", "", s, flags=re.I)                                          # 'CI -' left after numbers gone
    s = re.sub(r"\.{2,}\d+", "", s)                                                    # '..950' residue when a decimal like 0.950 was stripped mid-token
    s = re.sub(r"\s*[\(（]\s*[-–—:,;.…]*\s*[\)）]", "", s)                      # empty () / (.) / (CI -) / (..) left behind
    s = re.sub(r"\s+([,.;)）])", r"\1", s)
    s = re.sub(r"[（(]\s*[,;]\s*", "(", s)
    return _degunk(_s0, re.sub(r"\s{2,}", " ", s).strip())


def grounding(C, exp, idea, scrub, demoted, thesis=None, section="", lead=False):
    """Facts a paragraph is grounded in, ASSEMBLED PER SECTION (not one 7k string then truncated to 1700, which silently
    dropped METHOD and the FAITHFULNESS rules out of every prompt -- the root cause of fabricated preprocessing). Every
    section gets the subject, the thesis frame, and the FAITHFULNESS rules. A METHOD/DATA section ALSO gets the FULL
    method summary + key numbers (so it describes the REAL method and cannot invent preprocessing). A RESULTS section
    ALSO gets the per-analysis numbers. A narrative section (intro/discussion/conclusion) gets the research question +
    lead finding + result summary. `section` = the section name; `lead` marks the figure-bearing Results section."""
    import json
    kn = exp.get("key_numbers", {}) or {}
    demset = set(demoted or [])
    analyses = [a for a in (exp.get("analyses") or []) if a.get("name") not in demset]
    findings = "; ".join("%s: %s [%s]" % (a.get("name", ""), a.get("finding", ""), a.get("numbers", ""))
                         for a in analyses)
    lead_name = str(exp.get("lead", "")).strip()   # 'lead' is an ANALYSIS NAME -> resolve to its finding PROSE
    lead_find = next((str(a.get("finding", "")).strip() for a in analyses
                      if str(a.get("name", "")).strip() == lead_name and str(a.get("finding", "")).strip()),
                     str(exp.get("result_statement", "")).strip())
    rq = (str(idea.get("research_question", "")).strip() + " " + str(idea.get("hypothesis", "")).strip()).strip()

    b_thesis_frame, b_donotclaim = "", ""
    if thesis:
        roles = thesis.get("roles") or {}
        rolelines = "; ".join("%s = %s" % (n, r) for n, r in roles.items())
        b_thesis_frame = ("PAPER THESIS (the single positive claim the paper argues): "
                          + str(thesis.get("paper_thesis", "")).strip()
                          + "\nEACH ANALYSIS'S ROLE (core = evidence FOR; control = baseline that locates it; boundary = "
                          "where it applies / not; robustness = stress test): " + rolelines)
        b_donotclaim = ("OUT OF SCOPE -- these belong in the LIMITATIONS paragraph as bounds; do not claim them anywhere: "
                        + "; ".join(str(x) for x in (thesis.get("not_the_paper") or [])))
    b_subject = "SUBJECT: " + str(C.get("subject", "")).strip()
    b_rq = "RESEARCH QUESTION: " + rq[:400]
    b_lead = "LEAD (headline) FINDING: " + scrub(lead_find, demoted)[:400]
    b_result = "RESULT SUMMARY: " + scrub(str(exp.get("result_statement", "")), demoted)[:1200]
    b_method = ("METHOD -- describe ONLY what is stated here, with its defining equations + exact window/parameter "
                "values (if a step is NOT here, it was NOT done): " + str(exp.get("method_summary", "")).strip())
    b_quant = ("QUANTITIES AVAILABLE (exact numerals; report AT MOST the 3 most decisive per paragraph, "
               "verbatim -- the full set belongs in the results table and figures, never in one prose wall): "
               + json.dumps(kn)[:900])
    b_peranalysis = ("PER-ANALYSIS NUMBERS + SAMPLE (state each analysis's decisive numbers AND which sample subset it "
                     "used, lead first): " + findings[:2400])
    # the old monolithic FAITHFULNESS block was appended to EVERY section and itself LICENSED hedging everywhere ("this
    # holds in EVERY section", "note in the limitations ...", "target-'like' ..."), which drowned the 90-char "no
    # hedging outside Limitations" tone rule. Split it: method-faithfulness only where methods/tests are reported; a
    # ONE-LINE honesty note where flagged items are named; the sub-sample/scope caveats ONLY in the Limitations section.
    b_faith_method = ("FAITHFULNESS (method/results): describe ONLY steps stated in METHOD; invent no preprocessing, "
                      "filtering, split, fold, cross-validation, or scaler it does not state (a step not in METHOD was "
                      "NOT done). State the sample by its EXACT size, never 'all'/'the entire'/'the full'. Name an "
                      "ablation literally: 'no_X' = X REMOVED (all else kept) -> 'removing X', NEVER 'X-only'. Report "
                      "each statistical test's INCLUDED and EXCLUDED categories so the degrees of freedom match. State a "
                      "robustness/sensitivity checklist IN FULL exactly ONCE. The DRIVER of an effect is the component "
                      "whose REMOVAL COLLAPSES it; a component whose removal barely moves the result is NOT a driver -- "
                      "never credit it as jointly driving.")
    b_honesty1 = ("HONESTY (use ONCE where you first name the flagged/detected/classified items): call them target-"
                  "'like', 'consistent with', or 'in the feature region of' the target UNDER THIS DETECTOR -- never "
                  "genuine, true, or real. Do NOT re-hedge this in every sentence.")
    b_scope = ("LIMITATIONS material (this section only): if the facts do NOT state HOW a sub-sample was drawn (random "
               "vs stratified, seed, balance rule), describe it as the sample analyzed and note that its exact "
               "construction and its stability across alternative draws are not established here -- invent no sampling "
               "procedure, seed, or stratification. Frame each out-of-scope item as a bound on scope, not doubt about "
               "the finding.")
    b_density = ("NUMBER DENSITY (hard rule): at most THREE result numbers per paragraph of prose -- lead with the "
                 "decisive one; the full set lives in the results table and the figures (point to them via \\ref). "
                 "Never write a paragraph that is a wall of statistics.")
    b_mathnot = ("NOTATION: write mathematics as mathematics -- $\\hat{a}$ never a_hat, $\\sigma$ never 'sigma', "
                 "$R^2$ never R-squared, $7.4\\times10^{-6}$ never 7.41e-06; code-style variable names never appear "
                 "verbatim in prose. A display equation must FIT ONE COLUMN: never enumerate more than 3 formulas "
                 "inside one set/line -- list many forms in prose or a gathered environment with line breaks.")

    nm = (section or "").lower()
    if "abstract" in nm:                                # the ABSTRACT gets a TINY context: subject + the stat-stripped main
        th = _prose_only(str((thesis or {}).get("paper_thesis", "")).strip()) if thesis else ""    # finding as a CLAIM in
        main = th or _prose_only(lead_find)             # words, NOT a numbers row (glm/minimax copy a thesis number-dump).
        return b_subject + ("\nMAIN FINDING (the paper's single positive claim, in plain words, NO test statistics -- "  # VERBATIM
                            "state it and stop): " + main[:420] if main else "")   # JSON) that buried '6-8 sentences, no p'.
    is_method = any(k in nm for k in ("method", "experiment", "data", "theory"))
    is_results = lead or ("result" in nm) or ("finding" in nm)
    is_disc = "discussion" in nm
    is_concl = "conclu" in nm
    is_limit = "limitation" in nm
    parts = [b_subject]
    if is_method:                                       # describe the REAL method + report numbers, faithfully
        parts += [b_method, b_quant, b_faith_method, b_mathnot, b_density]
    elif is_results:                                    # report the exact numbers ONCE, with method-faithfulness + one honesty line
        parts += ([b_thesis_frame] if b_thesis_frame else []) + [b_lead, b_quant, b_peranalysis, b_faith_method,
                                                                 b_honesty1, b_mathnot, b_density]
    elif is_disc:                                       # INTERPRET only: NO number re-report (kills Results/Disc repetition), NO caveat wall
        parts += ([b_thesis_frame] if b_thesis_frame else []) + [b_rq, b_lead, b_honesty1,
                  "DISCUSSION -- interpret the finding, offer alternative explanations, state boundary conditions, and "
                  "connect it to the cited literature. Refer to the result QUALITATIVELY ('the observed drop', 'the "
                  "effect'); do NOT re-report the AUC/CI/p/effect-size numbers already given in Results, and add no new "
                  "numbers."]
    elif is_concl:                                      # brief qualitative outlook, no number re-report
        parts += [b_lead, "CONCLUSION -- restate the contribution and outlook briefly; refer to the finding "
                  "qualitatively, do NOT re-report the statistics."]
    elif is_limit:                                      # the ONE place scope caveats + out-of-scope items belong
        parts += [b_scope] + ([b_donotclaim] if b_donotclaim else [])
    else:                                               # any other narrative section
        parts += [b_rq, b_lead, b_honesty1]
    seen, uniq = set(), []
    for p in parts:
        if p and p not in seen:
            uniq.append(p); seen.add(p)
    return "\n\n".join(uniq)


def _cite_lines(catalog):
    return "\n".join("\\cite{%s} = %s (%s)" % (k, (p.get("title") or "")[:85], p.get("year") or "n.d.")
                     for k, p in (catalog or []))


def _nums(s):
    """Decisive numeric tokens (>=2 significant digits) in a numbers string -- used to verify the Results section
    actually reports the lead analysis's numbers rather than paraphrasing them into 'systematic'/'clear' prose."""
    return [t for t in re.findall(r"-?\d+\.?\d*", s or "") if len(t.replace("-", "").replace(".", "")) >= 2]


# named ML models/classifiers -- for the faithfulness check (the paper must not name a model the experiment never ran)
_MODELS = ["random forest", "random-forest", "gradient boosting", "gradient-boosted", "xgboost", "lightgbm",
           "logistic regression", "linear regression", "ridge regression", "lasso", "elastic net", "svm",
           "support vector", "naive bayes", "decision tree", "extra trees", "adaboost", "boosted tree",
           "gaussian process", "k-nearest", "knn", "neural network", "convolutional", "cnn", "lstm", "gru",
           "transformer", "multilayer perceptron", "mlp", "perceptron"]


def _models_in(s):
    low = (s or "").lower()
    return set(m for m in _MODELS if m in low)


# high-signal preprocessing / evaluation-protocol steps -- for the method-faithfulness check. If the paper claims one
# of these but the study's method_summary never mentions it, it is almost certainly a fabricated (and often self-
# contradictory) step, across any domain (e.g. a null-calibrated detector has no 'train/test split' or 'scaler').
_METHOD_TERMS = ["bandpass", "band-pass", "highpass", "high-pass", "lowpass", "low-pass",
                 "instrument response", "instrument-correct", "instrument correction", "deconvolv",
                 "train-test", "train/test", "training fold", "validation fold", "test fold", "held-out", "hold-out",
                 "cross-validation", "cross validation", "k-fold", "training set", "test set", "validation set",
                 "scaler", "standardscaler"]


def _method_terms_in(s):
    low = (s or "").lower()
    return set(t for t in _METHOD_TERMS if t in low)


def _results_table(chat, model, C, exp, demoted):
    """Half-deterministic RESULTS TABLE (P8): the model lays out the real analyses' numbers as ONE LaTeX table, then we
    VERIFY every number in it is grounded in the analyses' numbers (reject if it invented > ~20%). This gives the paper
    the structured comparison table Sakana's free-form writer gets 'for free', WITHOUT letting a free writer fabricate:
    the layout is the model's, but no number survives that is not a real result. Returns raw LaTeX or '' (no table)."""
    dem = set(str(d).strip() for d in (demoted or []))
    rows = [(str(a.get("name", "")).strip(), str(a.get("numbers", "")).strip())
            for a in (exp.get("analyses") or []) if str(a.get("name", "")).strip() not in dem and a.get("numbers")]
    if len(rows) < 2:
        return ""                                          # nothing to compare -> no table
    gset = set()
    for _n, nu in rows:
        gset.update(_nums(nu))
    facts = "\n".join("%s | %s" % (n, nu[:180]) for n, nu in rows)
    prompt = ("You are " + str(C.get("role", "a researcher")) + ". Lay out the key quantitative results below as ONE "
              "clean, publication-quality LaTeX table: a single \\begin{table}[t] ... \\end{table} with a \\small "
              "booktabs tabular (\\toprule/\\midrule/\\bottomrule, NO vertical rules). Use ONLY numbers that appear "
              "below, verbatim; invent NO numbers and add no column you cannot fill from below.\n"
              "TABLE RULES (violations are rejected):\n"
              "- one TYPE per column: a column is either short text labels or one metric in one unit, never a mix;\n"
              "- numeric columns right-aligned with a UNIFORM number of decimals down the column;\n"
              "- NO plus-minus values, NO parenthetical annotations (std/CI/notes) inside cells, NO slash-composites "
              "like 1.2/3.4, NO empty cells (drop the column instead);\n"
              "- at most 6 columns and 4-8 rows: keep the decisive metrics only, uncertainty stays in the prose;\n"
              "- short Title-case headers; short row labels (no code-ish names).\n"
              "Give a one-line \\caption and \\label{tab:results}. Output ONLY the LaTeX table.\n\nRESULTS:\n"
              + facts[:1900])
    why = ""
    for _ in range(5):                                     # 5 tries: flash intermittently returns EMPTY output
        p = (prompt if not why else                        # (server-side nondeterminism, seen live) and each blank
             prompt + "\n\nYour previous table was REJECTED because: " + why + ". Produce it again fixing exactly that.")
        t = (chat(p, model, 1100) or "").strip()
        t = re.sub(r"^```[a-zA-Z]*\n?|\n?```$", "", t).strip()
        if not t:
            why = "you returned EMPTY output -- return the complete LaTeX table this time"
            continue
        if "\\begin{tabular}" not in t or "\\end{table}" not in t:
            why = "it was not a single complete \\begin{table}...\\end{table}"
            continue
        if re.search(r"[^\x00-\x7f]", t):
            why = "it contained non-ASCII characters (write every symbol in math, e.g. $\\eta^2$)"
            continue
        # every CELL number must be a real result: strip the caption, label and colspec first (incidental digits), then
        # demand 100% -- the old 80% slack let one altered cell through in any table with five or more numbers.
        _cells = re.sub(r"\\caption\{(?:[^{}]|\{[^{}]*\})*\}|\\label\{[^}]*\}|\\begin\{tabular\}\{(?:[^{}]|\{[^{}]*\})*\}"
                        r"|\\(?:multicolumn|multirow)\{\d+\}|\\cmidrule(?:\([^)]*\))?\{[^}]*\}", " ", t)
        _cells = re.sub(r"(?:\\times\s*)?10\s*\^\s*\{?[-+]?\d+\}?", " ", _cells)   # powers of ten are notation
        # the FIRST column holds row labels ('Top-10', 'Layer 12', '2019 season'): digits there are names, not results
        _cells = " ".join(" ".join(r.split("&")[1:]) for r in re.split(r"\\\\", _cells))
        bad = [n for n in _nums(_cells) if n not in gset]
        if bad:
            why = "it contained numbers that are not in the RESULTS given to you: " + ", ".join(bad[:5])
            continue
        cells = re.sub(r"\\caption\{(?:[^{}]|\{[^{}]*\})*\}", "", t)          # nesting-aware caption strip
        m = re.search(r"\\begin\{tabular\}\{([^}]*)\}", t)
        spec = re.sub(r"[>@!]\{[^{}]*\}", "", m.group(1)) if m else ""        # drop colspec decorations before counting
        ncols = len(re.findall(r"[lcrS]|p\{[^}]*\}", spec))
        why = ("it used \\pm" if "\\pm" in t else "it used \\resizebox" if "\\resizebox" in t
               else "it had more than 6 columns" if ncols > 6
               else "it had slash-composite values like 1.2/3.4" if re.search(r"\d\s*/\s*\d", cells)
               else "it had parenthetical annotations in cells" if re.search(r"\(\s*\d[^)]*\)", cells)
               else "it had empty cells" if re.search(r"&\s*(?:,|-|--|)\s*(?:&|\\\\)", cells) else "")
        if why:
            continue                                       # the table rules, deterministically enforced
        t = re.sub(r"\\begin\{table\}(\[[^\]]*\])?", "\\\\begin{table}[t]%WIDE\n", t, count=1)   # spans both columns (newline: the marker must not comment out same-line content)
        return t
    return ""


def write_section(chat, model, C, spec, ground, catalog, running, scrub, trim, demoted, extra=""):
    """Expand each paragraph job in spec['outline'] into ONE paragraph; join with blank lines. Retry-on-empty per
    paragraph; single scrub per paragraph; no-repeat via the running context. `extra` = a per-section instruction
    (e.g. the figures this section must reference)."""
    outline = spec["outline"]
    n = len(outline)
    per = max(60, (spec["words"][0] + spec["words"][1]) // 2 // max(1, n))
    cl = _cite_lines(catalog)
    paras, run = [], running
    for i, job in enumerate(outline):
        cb = (("\nCite prior work with \\cite{key} using EXACT keys from this list. These are REAL, relevant references "
               "gathered FOR THIS paper -- situate the work in them rather than leaving them unused: an introduction, "
               "related-work or discussion paragraph SHOULD cite SEVERAL (about two to four) where they genuinely "
               "support the point; a methods/results paragraph cites where a method or claim rests on prior work. Only "
               "cite where the reference truly supports the statement, but do not under-cite a paragraph that reviews "
               "prior work:\n" + cl)
              if (spec.get("cite") and cl) else
              (("\nCite prior work with \\cite{key} (EXACT keys from this list) WHERE a method, dataset or claim "
                "genuinely rests on it -- one or two citations per paragraph where warranted, none where not:\n" + cl)
               if cl else ""))
        # ^ the old else-branch ORDERED 'Use no \cite' -- so in venue styles where only the Introduction had
        #   cite=True, the shipped References list collapsed to 4-8 entries while 40 sat unused in the .bib.
        # the limitations/data-quality paragraph is the ONE place scope caveats belong -- do not gag it with the
        # global "no hedging" rule (that would produce a toothless Limitations); everywhere else stays confident.
        is_lim = "limitation" in job.lower()
        tone = (" State this study's real scope bounds and limitations plainly and specifically (this IS the "
                "limitations paragraph); frame each as a bound on scope, never as doubt on the finding; no false modesty;"
                if is_lim else
                " Confident and precise, no hedging or caveats (those live only in a Limitations paragraph);")
        prompt = ("You are " + C["role"] + ". Write ONE well-developed paragraph, about " + str(per) + " words, that is "
                  "paragraph " + str(i + 1) + " of " + str(n) + " in the " + spec["name"] + " section of a research paper "
                  "about " + str(C.get("subject", "the studied system")) + ". This paragraph's job: " + job
                  + ". Ground every claim ONLY in the study facts below; invent no numbers or references beyond them."
                  + cb + ("\nDo NOT repeat what earlier paragraphs already said:\n" + run[-600:] if run else "")
                  + tone + " clean "
                  "LaTeX prose, ONLY \\textbf and \\emph, statistic names in plain words (no underscores), no dashes as "
                  "sentence punctuation." + (("\n" + extra) if extra else "")
                  + "\n\nSTUDY FACTS:\n" + ground + "\n\nOutput ONLY the paragraph text.")
        raw = ""
        for _ in range(3):
            raw = (chat(prompt, model, per * 5 + 500, label="sec:%s:p%d" % (spec["name"][:12], i + 1)) or "").strip()
            #      (surrogate null + thresholding + bootstrap + tests) must not truncate mid-sentence at the token cap
            if len(raw.split()) >= per * 0.45:
                break
        p = trim(scrub(raw, demoted))
        if p.strip():
            paras.append(p.strip()); run += " " + p
    return "\n\n".join(paras)


def _dedup(out):
    """Remove near-duplicate sentences in LATER body sections that restate an earlier one (word-Jaccard >= 0.7), so
    the paper does not report the same result twice (e.g. the positive control in both Results and Discussion). The
    Abstract is not in '_order', so it is untouched (it is meant to summarize).

    Two SAFEGUARDS (mirroring _scrub_rs) so this never guts a section -- the failure the old drafter kept hitting:
      (1) a section's FIRST sentence is always kept (it is the topic/lead sentence, e.g. the Results headline or the
          Conclusion's by-design restatement of the key finding);
      (2) if de-dup would remove more than 35% of a section's sentences, the section is left UNCHANGED (an over-match
          means the whole section legitimately restates -- like a Conclusion -- not that it is redundant)."""
    seen = []
    for name in out.get("_order", []):
        body = out.get(name, "")
        if not isinstance(body, str) or not body.strip():
            continue
        para_list = body.split("\n\n")
        kept_paras, sec_seen, total, dropped = [], [], 0, 0
        for pi, para in enumerate(para_list):
            keep = []
            for si, s in enumerate(re.split(r"(?<=[.;])\s+", para)):
                # numbers ride along as '#'-tokens and must match EXACTLY: 'accuracy from 0.81 to 0.79' after
                # 'from 0.81 to 0.64' is a second result, not a restatement (the word-only set deleted it).
                w = set(re.findall(r"[a-z]{4,}", s.lower())) | set("#" + n for n in _nums(s))
                total += 1
                is_first = (pi == 0 and si == 0)               # never drop the section's own lead sentence
                if (not is_first) and len(w) >= 6 and any(p and len(w & p) >= 0.7 * len(w | p)
                                                          and {x for x in w if x[0] == "#"} == {x for x in p if x[0] == "#"}
                                                          for p in (seen + sec_seen)):
                    dropped += 1
                    continue                                   # near-duplicate of an earlier sentence -> drop
                keep.append(s)
                if len(w) >= 6:
                    sec_seen.append(w)
            if " ".join(keep).strip():
                kept_paras.append(" ".join(keep).strip())
        if total and dropped > 0.35 * total:                   # over-match safeguard: keep the section as written
            for para in para_list:                             # still register its sentences so later sections dedup vs it
                for s in re.split(r"(?<=[.;])\s+", para):
                    w = set(re.findall(r"[a-z]{4,}", s.lower())) | set("#" + n for n in _nums(s))
                    if len(w) >= 6:
                        seen.append(w)
            continue
        seen.extend(sec_seen)
        out[name] = "\n\n".join(kept_paras) or body            # never let a section collapse to empty
    return out


# The abstract ARC is field-appropriate (the beat ORDER differs by paper type): discovery/observation fields lead with
# THE FINDING, a method field leads with the METHOD, a synthesis field with what was made. The UNIVERSAL principles
# (one idea per sentence, only headline numbers, end on meaning) are enforced the same for all. Keyed by the style layer
# so it stays domain-agnostic; the thesis supplies the main-finding beat.
_ABSTRACT_ARC = {
    "earth_space": "the standing assumption or gap and why it matters; what data you examined and how (briefly); THE "
                   "MAIN FINDING, stated first among the results; the mechanism or the strongest control; what it means "
                   "for the field or for the catalogue / observations",
    "cs_ml":       "the problem and why it is hard; the method you propose (name it); how it works / the key idea; what "
                   "you evaluated it on; the main result as ONE headline number against a baseline; the takeaway (what "
                   "it enables, at what cost)",
    "biomed":      "the clinical or biological problem; the cohort or data and the approach; THE MAIN FINDING with its "
                   "effect size; the key control or subgroup signal; the clinical or biological significance",
    "physics":     "the phenomenon or open question; the measurement or model; THE MAIN RESULT; its agreement with "
                   "theory or its mechanism; the physical implication",
    "chem":        "the target and the motivation; what you synthesized or characterized and how; the key property or "
                   "performance; the comparison to prior work; what it enables",
}
_ABSTRACT_ARC_DEFAULT = ("the problem and why it matters; the gap; what you did and how (briefly); THE MAIN FINDING; the "
                         "mechanism or strongest support; what it means for the field")


def write_abstract(chat, model, C, exp, thesis, style, ground, scrub, trim, demoted):
    """Write the ABSTRACT by an ARC + UNIVERSAL principles -- NOT via the body paragraph-writer (which is told to report
    every number verbatim and so produces a numbers dump in monster sentences). The field arc (from _ABSTRACT_ARC) sets
    the beat ORDER; the universal rules (6-8 sentences, ONE idea each, only 2-4 HEADLINE numbers, no long inline term
    definition, END on the meaning) are the same for every field; the thesis is the main-finding beat."""
    arc = _ABSTRACT_ARC.get(style, _ABSTRACT_ARC_DEFAULT)
    th = _prose_only(str((thesis or {}).get("paper_thesis", "")).strip())    # MAIN-FINDING beat = a CLAIM in words, not a numbers row (else glm/minimax copy the thesis's number dump verbatim)
    rules = ("\nUNIVERSAL RULES (obey ALL):\n"
             "1. ONE idea per sentence, about 15-25 words. NEVER weld the sample size, the recording format, the method "
             "name, and a term definition into a single sentence.\n"
             "2. Use AT MOST 2 numbers in the ENTIRE abstract -- ONLY the single main result and its one comparison (e.g. "
             "the two effect/AUC values). State NO sample size, count, fraction, sampling rate, recording duration, "
             "p-value, confidence interval, or any other number anywhere; omit them (they live in the Results).\n"
             "3. Do NOT define a load-bearing term with a long mid-sentence clause; use it bare, or give the definition "
             "its own short sentence.\n"
             "4. END on the MEANING / implication for the field, not on a number.\n"
             "5. Do NOT equate the detector's output with ground truth: never call the flagged/detected items genuine, "
             "true, real, or 'statistically indistinguishable from' the target -- the honest phrasing is that they are "
             "target-'like', 'consistent with', or 'fall in the feature region of' the target UNDER THIS DETECTOR.\n"
             "Ground every claim in the facts; invent no number or claim. Output ONLY the abstract paragraph.")
    def _gen(extra=""):
        p = ("Write the ABSTRACT of this research paper: ONE paragraph, 6 to 8 sentences.\nFollow THIS arc (beat order) "
             "for the field: " + arc + "." + (("\nMAIN-FINDING sentence (the single positive claim the paper argues): "
             + th[:260]) if th else "") + rules + extra + "\n\nSTUDY FACTS:\n" + ground)
        return re.sub(r"^```[a-zA-Z]*\n?|\n?```$", "", (chat(p, model, 1400, label="abstract") or "").strip()).strip()
    _cnt = lambda s: len(re.findall(r"(?<![A-Za-z\d])\d+(?:\.\d+)?", s))   # standalone numbers (a digit inside a name like freefield1010 does not count)
    ab = _gen()
    if not ab.strip():                                     # reasoning backbone (glm/kimi via OpenRouter, thinking not disable-able) burned the budget on thinking -> empty; retry once before dropping to fallback
        ab = _gen()
    if _cnt(ab) > 2:                                        # more than 2 numbers -> retry once, keep only the 2 headline
        ab2 = _gen("\nYou used more than 2 numbers. KEEP ONLY the single main result and its one comparison (2 numbers "
                   "total); DELETE every other number -- sample sizes, counts, fractions, rates, durations, p-values.")
        if ab2 and 60 < len(ab2.split()) and _cnt(ab2) <= _cnt(ab):
            ab = ab2
    return trim(scrub(_scrub_abstract(ab), demoted))      # OUTPUT guard: hard-strip filler numbers models that ignore rule 2 dump


# The Introduction is a FIELD-SPECIFIC storyline, not one universal template. Each style's beats, paragraph count,
# length, whether results are previewed, and whether a contributions list is emitted follow the TARGET VENUE's real
# convention (researched against author guidelines: NeurIPS/ICLR, NEJM/Radiology, PRL, JGR/GJI/ApJ, JACS/ACS). Each
# beat is still fed ONLY its own small slice (subject / question / method+finding), never the 6.5k grounding blob, so
# the "write THIS beat" instruction dominates and the beats stop repeating each other and dumping every number.
# plan = (target_words, [(BEAT_NAME, material_tag, cite_level c0..c3, job)])
_INTRO_PLANS = {
    "cs_ml": (780, [
        ("CONTEXT", "subject", "c1",
         "Open on the task/capability the audience cares about, then narrow FAST to this paper's specific problem in "
         "2-3 sentences. Cite minimally; do NOT survey the field (Related Work is a separate section)."),
        ("GAP", "rq", "c2",
         "State what prior approaches do and where they fall short -- the pivot ('However, existing methods ...'). Cite "
         "only the few works needed to frame the gap and build them into the argument; do NOT pile citations. End on "
         "the precise open question."),
        ("APPROACH", "method", "c0",
         "Name the method/idea and give the ONE-LINE intuition of how it works. Minimum technical detail."),
        ("RESULTS PREVIEW", "preview", "c0",
         "State the headline outcome in ONE sentence, INCLUDING the single flagship number (a CS/ML intro is expected to "
         "preview a number). No p-values or secondary numbers."),
        ("CONTRIBUTIONS", "contributions", "c0",
         "A lead-in sentence ('Our contributions are as follows:') then a LaTeX \\begin{itemize} with 3-4 \\item "
         "entries, each verb-first ('We propose ...', 'We show ...', 'We release ...'). This is the final paragraph."),
    ]),
    "biomed": (420, [
        ("CLINICAL IMPORTANCE", "subject", "c1",
         "Open broad on why the problem matters clinically -- burden, prevalence, or importance -- in 2-3 sentences."),
        ("WHAT IS KNOWN AND THE GAP", "rq", "c2",
         "Summarize the pertinent prior evidence or current standard (woven, not a survey), then name the specific gap "
         "('however', 'remains unclear', 'has not been established'). Cite inline."),
        ("OBJECTIVE", "aim", "c0",
         "Close on an explicit first-person AIM ('We aimed to ...' / 'The purpose of this study was to ...'). State NO "
         "result, effect size, or performance number -- a biomedical intro ends on the objective, not the finding."),
    ]),
    "physics": (520, [
        ("CONTEXT", "subject", "c1",
         "Open on the broad phenomenon/field in PLAIN language a physicist outside the subfield can follow; minimal "
         "jargon and acronyms. Establish the area is active/important."),
        ("STAKES AND GAP", "rq", "c2",
         "Why this specific quantity/problem matters, then the open question or what has 'remained elusive'. Cite prior "
         "work inline here."),
        ("THIS WORK AND RESULT", "preview", "c0",
         "'Here we ...' / 'In this work we report ...': state what was done AND the headline result in the SAME "
         "sentence(s). Qualitative, or a single key number -- no secondary statistics."),
        ("IMPLICATION", "finding", "c0",
         "One sentence on what the result enables or means."),
    ]),
    "earth_space": (950, [
        ("BIG PICTURE", "subject", "c1",
         "Open with ONE broad, present-tense declarative statement of established fact and why the phenomenon matters. "
         "Do NOT open with a laundry list of many applications -- one framing sentence, then narrow."),
        ("NARROW TO SUBTOPIC", "rq", "c1",
         "Zoom to the specific regime/mechanism/method this paper addresses."),
        ("PRIOR WORK", "rq", "c3",
         "A substantial, densely-cited synthesis of what is known and how -- this IS the related work, woven in. Build "
         "it toward the gap as an argument; do NOT merely pile citations."),
        ("GAP", "rq", "c1",
         "State what is unresolved, contradictory, or unmeasured ('However, ... is unclear / disagree / has not been "
         "quantified')."),
        ("THIS STUDY", "preview", "c0",
         "'In this paper we ...': state the aim, the approach, and the data/sample, then a QUALITATIVE preview of what "
         "you find/show (no exact numbers -- those live in the abstract and Results)."),
    ]),
    "chem": (540, [
        ("IMPORTANCE", "subject", "c1",
         "Open on why this compound class / property / measurement matters -- an application pull or a fundamental "
         "question."),
        ("PRIOR ART AND GAP", "rq", "c2",
         "What is already known / the established approaches (cited inline, kept short), then the unresolved problem "
         "('remains challenging / unexplored'). The pivot."),
        ("THIS WORK AND PREVIEW", "preview", "c0",
         "A single announcing sentence -- 'Here we report ...' / 'Herein we ...' -- of what was made/computed/measured, "
         "fused with the concrete headline outcome INCLUDING one key number."),
        ("SIGNIFICANCE", "finding", "c0",
         "One clause on why the result matters / what it enables."),
    ]),
}
_INTRO_DEFAULT = "cs_ml"


def _intro_slice(tag, C, exp, idea, thesis, demoted, scrub):
    """The SMALL, per-beat material (contrast with grounding()'s 6.5k blob that every paragraph used to get)."""
    subj = "SUBJECT: " + str(C.get("subject", "")).strip()
    rq = (str(idea.get("research_question", "")).strip() + " " + str(idea.get("hypothesis", "")).strip()).strip()

    def _finding():
        ln = str(exp.get("lead", "")).strip()
        lead = next((str(a.get("finding", "")).strip() for a in (exp.get("analyses") or [])
                     if str(a.get("name", "")).strip() == ln and str(a.get("finding", "")).strip()),
                    str(exp.get("result_statement", "")).strip())
        return _strip_stats(scrub(lead, demoted))[:320]

    if tag == "subject":
        return subj
    if tag in ("rq", "aim"):
        return subj + "\nTHE QUESTION / TENSION (what the paper asks): " + rq[:520]
    if tag == "method":
        return subj + "\nAPPROACH (what was done): " + str(exp.get("method_summary", "")).strip()[:460]
    if tag in ("preview", "contributions"):
        notp = "; ".join(str(x) for x in ((thesis or {}).get("not_the_paper") or []))[:360]
        return (subj + "\nAPPROACH (what was done): " + str(exp.get("method_summary", "")).strip()[:460]
                + "\nFINDING (report exactly as the beat's number rule says): " + _finding()
                + ("\nOUT OF SCOPE / DO NOT CLAIM: " + notp if notp else ""))
    if tag == "finding":
        return subj + "\nFINDING: " + _finding()
    return subj


def write_intro(chat, model, C, exp, idea, thesis, style, catalog, scrub, trim, demoted, running=""):
    """Write the Introduction as the TARGET VENUE's storyline (per _INTRO_PLANS): the beats, paragraph count, length,
    result preview, and contributions list all follow that field's real convention, each beat fed only its slice."""
    words, beats = _INTRO_PLANS.get(style, _INTRO_PLANS[_INTRO_DEFAULT])
    cl = _cite_lines(catalog)
    per = max(60, words // max(1, len(beats)))
    run, paras = running, []
    for i, (beat, tag, cite, job) in enumerate(beats):
        mat = _intro_slice(tag, C, exp, idea, thesis, demoted, scrub)
        if cl and cite == "c3":
            cb = ("\nThis is the REVIEW beat: cite 3-6 REAL references from this list, woven into one argument (EXACT "
                  "\\cite{key}); do NOT pile them:\n" + cl)
        elif cl and cite == "c2":
            cb = ("\nCite 2-4 REAL references from this list where they support the point, built into the argument "
                  "(EXACT \\cite{key}); do NOT pile:\n" + cl)
        elif cl and cite == "c1":
            cb = "\nCite 1-2 real references where they genuinely support the point (EXACT \\cite{key}):\n" + cl
        else:
            cb = "\nUse no \\cite in this beat."
        listy = (tag == "contributions")
        prompt = ("You are " + C["role"] + ". Write the " + beat + " beat (beat " + str(i + 1) + " of "
                  + str(len(beats)) + ") of the Introduction of a " + style.replace("_", "/") + "-style research paper "
                  "about " + str(C.get("subject", "the studied system")) + "; follow that field's Introduction "
                  "convention. Target about " + str(per) + " words"
                  + (" (a short lead-in sentence + a LaTeX itemize list)" if listy else " as ONE paragraph")
                  + ".\nBEAT JOB: " + job + " Ground ONLY in the facts below; invent no numbers or references." + cb
                  + ("\nDo NOT repeat wording/phrasing already used in earlier beats:\n" + run[-500:] if run else "")
                  + " Define each key qualifier ONCE, then use a SHORT form afterward; never restate a long keyword "
                    "string more than once. Confident and precise, no hedging (scope caveats only where the beat asks). "
                    "Clean LaTeX prose, only \\textbf and \\emph" + ("" if listy else ", no lists") + ", no dashes as "
                    "sentence punctuation.\n\nSTUDY FACTS:\n" + mat + "\n\nOutput ONLY the beat text.")
        raw = ""
        for _ in range(3):
            raw = (chat(prompt, model, per * 5 + 400, label="intro:%s" % beat) or "").strip()
            if len(raw.split()) >= per * 0.4:
                break
        p = trim(scrub(raw, demoted))
        if p:
            paras.append(p)
            run += "\n" + p[:400]
    return "\n\n".join(paras)


def write_paper(chat, model, C, exp, idea, catalog, scrub, trim, demoted, style, figmap=None, thesis=None):
    """Produce every section for `style` via outline->expand, in canonical order. Returns dict:
    {'_order': [section names], '_style': style, '<Section>': prose, ..., 'ABSTRACT': prose, '_lead_section': name}.
    The lead (Results-type) section is told to reference each figure; the ABSTRACT is written LAST (so it can
    summarize) with a deterministic fallback; a cross-section de-duplication pass runs at the end.

    When a `thesis` PLAN is supplied, the whole paper is written around its single positive thesis with each analysis in
    its rhetorical role (positive-narrative mode); the over-claim brake is DETERMINISTIC and at the SOURCE (the stage-2
    lead-significance gate + thesis validation), not a post-hoc word lexicon (that mangled legitimate cross-domain
    prose). With no thesis it falls back to the plain outline->expand behaviour (unchanged)."""
    spec = paper_specs.FIELD_SPECS[style]
    def gfor(name, lead=False):                        # PER-SECTION grounding: METHOD reaches only method/data sections,
        return grounding(C, exp, idea, scrub, demoted, thesis, section=name, lead=lead)   # numbers reach results, etc.
    lead_name = str(exp.get("lead", "")).strip()
    narr = ""
    if thesis:
        narr = ("Write this paragraph as part of a paper that argues ONE positive thesis: \""
                + str(thesis.get("paper_thesis", ""))[:200] + "\". Put each analysis in its assigned rhetorical role "
                "(never present a control or a boundary result as a co-equal success, nor as a failure). Use the "
                "STRONGEST wording that stays true after the controls and boundaries are considered; do NOT use causal, "
                "mechanistic, invariance, generalisation, or operational language unless this analysis's role licenses "
                "it. Never call the overall result 'mixed'.")   # target-'like'/under-this-detector honesty is now ONE grounding line (b_honesty1), not repeated here
    fignote = ""
    if figmap:                                                     # make the lead section reference + explain each figure
        fignote = ("This section MUST reference each of these figures by its EXACT label and briefly say what it "
                   "shows (do not merely list them): "
                   + "; ".join("Figure~\\ref{%s} = %s" % (lab, str(cap or "").replace("\n", " ")[:90])
                               for _f, lab, cap in figmap))
    out = {"_order": list(spec["order"]), "_style": style}
    lead_section, lead_extra = None, ""
    # SECTION DUTY TABLE: with parallel writing there is no running context to stop two sections restating the
    # same result, so the anti-repetition contract moves to DESIGN TIME -- one static line per section built
    # from its outline's first job. Generic (comes from the style spec), zero extra LLM calls; the _dedup pass
    # stays as the runtime backstop.
    duty = ("SECTION DUTIES (each section owns its lane; do NOT restate another section's content): " + "; ".join(
        "%s = %s" % (n, str(spec["sections"][n]["outline"][0])[:70]) for n in spec["order"]))
    jobs = []                                          # (name, s, extra, is_intro, is_lead) resolved up front
    for name in spec["order"]:
        s = spec["sections"][name]
        is_lead = s.get("floats") == "lead"
        if is_lead:
            lead_section = name
        # P3: the narr (positive-thesis framing + the anti-equation "target-like, not confirmed" guard) is only needed
        # where the paper makes CLAIMS about the flagged items -- the lead (Results) and Discussion. Injecting it into
        # every paragraph made the model echo the same scope/defensive phrases everywhere ("reads like AI self-
        # protection"). Other sections stay on-thesis via the thesis block already in their grounding.
        want_narr = is_lead or ("discussion" in name.lower())
        extra = "\n".join(x for x in (narr if want_narr else "", fignote if is_lead else "", duty) if x)
        if is_lead:
            lead_extra = extra
            if figmap and len(figmap) + 1 > len(s["outline"]):
                # the RESULTS-type section must carry one substantive paragraph PER FIGURE (plus the lead) --
                # a 5-figure study with a 4-job outline yields orphan figures and a one-paragraph Results.
                need = len(figmap) + 1 - len(s["outline"])
                grow = (len(s["outline"]) + need) / max(1, len(s["outline"]))
                s = dict(s, outline=list(s["outline"]) + [
                    "present the next supporting analysis and its figure in depth: what the figure shows, its "
                    "decisive numbers, and what it rules in or out"] * need,
                    words=[int(s["words"][0] * grow), int(s["words"][1] * grow)],
                    paras=[s["paras"][0] + need, s["paras"][1] + need])
        jobs.append((name, s, extra, "introduc" in name.lower(), is_lead))

    def _write_one(job):
        name, s, extra, is_intro, is_lead = job
        if is_intro:                                   # the Introduction is a STORYLINE (background->problem->gap->
            return write_intro(chat, model, C, exp, idea, thesis, style, catalog, scrub, trim, demoted, running="")
        return write_section(chat, model, C, s, gfor(name, is_lead), catalog, "", scrub, trim, demoted, extra=extra)

    # PARALLEL section writing (2026-08-30): sections only weakly coupled via the old running context, so
    # write them concurrently -- wall time = slowest section instead of the sum. OMNIST_SERIAL_WRITE=1 restores
    # the serial path; ANY parallel failure falls back to serial automatically (never a crash, never a downgrade
    # in content -- the serial path is the proven one).
    if os.environ.get("OMNIST_SERIAL_WRITE"):
        for job in jobs:
            out[job[0]] = _write_one(job)
    else:
        try:
            from concurrent.futures import ThreadPoolExecutor
            with ThreadPoolExecutor(max_workers=min(6, len(jobs))) as ex:
                futs = {ex.submit(_write_one, job): job[0] for job in jobs}
                for fut, name in futs.items():
                    try:
                        out[name] = fut.result()           # per-section isolation: a finished section is never
                    except Exception as e:                 # discarded or re-billed because a sibling failed
                        print("  [writer] section %r failed in parallel (%s) -> serial retry" % (name, type(e).__name__))
        except Exception as e:
            print("  [writer] parallel write unavailable (%s) -> serial" % type(e).__name__)
        for job in jobs:                                   # serial retry ONLY for the sections still missing
            if not str(out.get(job[0], "")).strip():
                out[job[0]] = _write_one(job)
    out["_lead_section"] = lead_section or spec["order"][-2]

    # deterministic NUMBERS backstop: the Results-type lead section MUST report the lead analysis's decisive numbers.
    # A positive-narrative draft tends to summarize them into 'systematic'/'clear' prose (the reviewer's "reads like a
    # conclusion, not results"). If the written section is missing most of them, re-write it ONCE with the exact numbers
    # spelled out (numbers come only from the real result -- nothing is invented); keep the rewrite only if it reports
    # strictly more of them.
    la = next((a for a in (exp.get("analyses") or []) if str(a.get("name", "")).strip() == lead_name), {})
    lead_nums = _nums(str(la.get("numbers", "")))
    if lead_section and lead_nums:
        have = sum(1 for n in lead_nums if n in out.get(lead_section, ""))
        if have < min(3, len(lead_nums)):
            demand = ("You omitted the decisive numbers. REWRITE this section reporting these EXACT numbers as numerals, "
                      "verbatim (they are real results -- invent nothing beyond them): " + str(la.get("numbers", ""))[:400])
            rew = write_section(chat, model, C, spec["sections"][lead_section], gfor(lead_section, lead=True), catalog, "", scrub, trim, demoted,
                                extra="\n".join(x for x in (lead_extra, demand) if x))
            if rew.strip() and sum(1 for n in lead_nums if n in rew) > have:
                out[lead_section] = rew

    # deterministic CITATION backstop: real references were gathered for THIS paper, but a conservative model (seen with
    # gpt-5.5) can under-cite (1 of 10), which reads as "related work too thin". If the paper cites too few of the real
    # keys, re-write the earliest citation-bearing section (the prior-work home) ONCE, demanding it cite several of the
    # actual gathered keys where they support the discussion. Keys are from the real bib, so nothing is invented.
    def _cites(s):
        return set(k.strip() for grp in re.findall(r"\\cite[a-zA-Z]*\{([^}]*)\}", s or "") for k in grp.split(",") if k.strip())
    if catalog and len(catalog) >= 3:
        used = set().union(*[_cites(v) for v in out.values() if isinstance(v, str)]) if out else set()
        want = min(4, len(catalog))
        tgt = next((n for n in spec["order"] if spec["sections"][n].get("cite") and out.get(n, "").strip()), None)
        if len(used) < want and tgt:
            keys = [k for k, _ in catalog][:6]
            dem = ("This section UNDER-CITES the prior work. REWRITE it, citing at least %d of these REAL references with "
                   "\\cite{key} (exact keys) WHERE they genuinely support the discussion (do not invent keys): %s"
                   % (want, ", ".join(keys)))
            rew = write_section(chat, model, C, spec["sections"][tgt], gfor(tgt), catalog, "", scrub, trim, demoted, extra=dem)
            if rew.strip() and len(_cites(rew)) > len(_cites(out.get(tgt, ""))):
                out[tgt] = rew

    # deterministic FAITHFULNESS backstop (P1): the paper must NOT name a model the experiment never ran (e.g. write
    # 'random forest' while method_summary actually used logistic regression -- an unfaithful method is a hard reviewer
    # kill). Check the method-bearing section; if it names a model absent from method_summary, re-write it ONCE, pinning
    # the ONLY real model(s). Skipped when the study reports no named model (e.g. a threshold/prevalence detector).
    real_models = _models_in(str(exp.get("method_summary", "")))
    if real_models:
        meth_sec = next((n for n in spec["order"] if ("method" in n.lower() or "experimental" in n.lower())
                         and out.get(n, "").strip()), None)
        if meth_sec:
            bogus = _models_in(out.get(meth_sec, "")) - real_models
            if bogus:
                dem = ("FAITHFULNESS: the study's ONLY model(s) were: %s. You named %s, which was NEVER run -- REWRITE "
                       "this section using only the real model(s) above and the exact method in the study facts; name no "
                       "other classifier." % (", ".join(sorted(real_models)), ", ".join(sorted(bogus))))
                rew = write_section(chat, model, C, spec["sections"][meth_sec], gfor(meth_sec), catalog, "", scrub, trim,
                                    demoted, extra=dem)
                if rew.strip() and not (_models_in(rew) - real_models):   # keep only if the bogus model is gone
                    out[meth_sec] = rew

    # deterministic METHOD-FAITHFULNESS backstop: the paper must not claim a preprocessing / evaluation-protocol step the
    # study never did (the reviewer's "Data says instrument-corrected + bandpass, Methods says uncorrected + a scaler on
    # train/val/test folds" -- both fabricated, since the real method has none). Check the method/data/experiment sections;
    # if one names a step absent from method_summary, rewrite it ONCE grounded strictly in METHOD, forbidding those steps.
    ms_terms = _method_terms_in(str(exp.get("method_summary", "")))
    for sec in [n for n in spec["order"] if any(k in n.lower() for k in ("method", "data", "experiment"))]:
        if not out.get(sec, "").strip():
            continue
        invented = _method_terms_in(out[sec]) - ms_terms
        if invented:
            dem = ("FAITHFULNESS: the study's method (METHOD in the facts) does NOT include: %s. REWRITE this section "
                   "describing ONLY the actual pipeline in METHOD; remove those invented steps and add no preprocessing, "
                   "filtering, split, fold, or scaler not stated in METHOD." % ", ".join(sorted(invented)))
            rew = write_section(chat, model, C, spec["sections"][sec], gfor(sec), catalog, "", scrub, trim, demoted, extra=dem)
            if rew.strip() and not (_method_terms_in(rew) - ms_terms):     # keep only if the invented steps are gone
                out[sec] = rew

    # METHODS COMPLETENESS backstop: the method section must actually CONTAIN the reproducibility elements method_summary
    # describes (null / surrogate construction, thresholding, bootstrap, CI, the statistical tests) -- the writer some-
    # times returns a THIN or truncated Methods that omits them (a reviewer's "the technical closure is thinned out").
    # If method_summary names key procedure elements the written section omits, rewrite it demanding them (grounded).
    _MDET = ["surrogate", "iaaft", "phase-random", "phase random", "white noise", "white-noise", "threshold",
             "percentile", "bootstrap", "confidence interval", "chi-square", "chi-squared", "resampl", "eigenvalue",
             "covariance", "false-alarm", "false alarm", "null distribution", "null model"]
    _mslow2 = str(exp.get("method_summary", "")).lower()
    want = sorted(set(t for t in _MDET if t in _mslow2))
    msec2 = next((n for n in spec["order"] if ("method" in n.lower() or "experimental" in n.lower())
                  and out.get(n, "").strip()), None)
    if msec2 and want:
        seclow = out[msec2].lower()
        missing = [t for t in want if t not in seclow]
        if len(missing) > 0.4 * len(want):                             # omits >40% of the method's key elements -> too thin
            dem = ("COMPLETENESS: rewrite this Methods section in fuller, REPRODUCIBLE detail. It currently omits these "
                   "actual procedure elements from the study facts -- cover each (how it is constructed/computed and its "
                   "exact parameters), inventing nothing: " + ", ".join(missing[:12]) + ".")
            rew = write_section(chat, model, C, spec["sections"][msec2], gfor(msec2), catalog, "", scrub, trim, demoted, extra=dem)
            if rew.strip() and sum(1 for t in want if t in rew.lower()) > sum(1 for t in want if t in seclow):
                out[msec2] = rew

    # RESULTS FIGURE COMPLETENESS backstop (#B): every figure must be REFERENCED and briefly INTERPRETED in the lead
    # (Results) section, not left as a caption-only float (the reviewer's "Figures 3-6 have no body text"). If the lead
    # section references fewer than most of the figures, rewrite it demanding a \ref + a one-clause reading for EACH.
    if figmap and lead_section and out.get(lead_section, "").strip():
        labs = [lab for _f, lab, _c in figmap]
        reffed = sum(1 for lab in labs if ("\\ref{" + lab + "}") in out[lead_section])
        if reffed < 0.7 * len(labs):
            dem = ("Reference EACH figure by its EXACT label and give it a one-clause interpretation in this section "
                   "(do not leave any figure as a caption only). Cover ALL of: "
                   + "; ".join("Figure~\\ref{%s} = %s" % (lab, str(cap or "").replace(chr(10), " ")[:70])
                               for _f, lab, cap in figmap))
            rew = write_section(chat, model, C, spec["sections"][lead_section], gfor(lead_section, lead=True), catalog,
                                "", scrub, trim, demoted, extra="\n".join(x for x in (lead_extra, dem) if x))
            if rew.strip() and sum(1 for lab in labs if ("\\ref{" + lab + "}") in rew) > reffed:
                out[lead_section] = rew

    # deterministic METHOD-REPRODUCIBILITY (#2): a soft "rewrite it with an equation" demand is unreliable (the model
    # keeps writing prose). Instead, when the method carries a defining FORMULA (method_summary '=' lines with math
    # operators) but the method section shows no display equation, GENERATE the equation with a FOCUSED call (plain-text
    # formula -> one LaTeX block) and DETERMINISTICALLY INSERT it after the section's first paragraph. Additive (no
    # rewrite of existing prose); kept only if it is a single balanced \begin{equation} whose numbers are all grounded.
    _ms = str(exp.get("method_summary", ""))
    _formula_src = " ".join(re.findall(r"[^.]*=[^.]*", _ms))[:600]
    if re.search(r"[*/^]|\bexp\b|\blog\b|sqrt|lambda|λ", _formula_src):
        msec = next((n for n in spec["order"] if ("method" in n.lower() or "experimental" in n.lower())
                     and out.get(n, "").strip()), None)
        if msec and "\\begin{equation}" not in out.get(msec, ""):
            for _ in range(3):                                         # retry: the focused generation sometimes returns a
                eq = chat("Convert this method's defining formula(s) into ONE LaTeX display block. Plain-text formula:\n\""
                          + _formula_src + "\"\nOutput ONLY \\begin{equation} ... \\end{equation} (use \\quad to place 2-3 "
                          "related definitions inside the single block), with \\lambda, \\frac, \\cdot, \\exp, \\log and "
                          "subscripts; use \\mathrm{...} (NOT \\text{...}) for any multi-letter subscript and put no "
                          "underscore inside it. Use ONLY the symbols and numbers already in the formula above; invent "
                          "nothing. No prose, no code fences.", model, 500)
                eq = re.sub(r"^```[a-zA-Z]*\n?|\n?```$", "", (eq or "").strip()).strip()
                bad = [n for n in _nums(eq) if n not in set(_nums(_formula_src)) | set(_nums(_ms))]
                if (eq.startswith("\\begin{equation}") and eq.rstrip().endswith("\\end{equation}")
                        and eq.count("{") == eq.count("}") and eq.count("$") % 2 == 0 and not bad
                        and not re.search(r"\\(?:text|mathrm)\{[^}]*_[^}]*\}", eq)):   # no raw underscore in a text label
                    paras = [p for p in out[msec].split("\n\n") if p.strip()]
                    paras.insert(min(1, len(paras)), eq)               # after the first paragraph
                    out[msec] = "\n\n".join(paras)
                    break                                              # a valid equation was inserted

    # deterministic STATISTICAL-CONSISTENCY (#1): when a test's numbers record an EXCLUSION (a 'dof=k, ... used' note or
    # an 'excluded' mention), a soft grounding hint does not reliably surface it. Generate ONE clarifying sentence with a
    # focused call and APPEND it to the paragraph that reports the test (or the lead section), so the stated degrees of
    # freedom match the categories shown. Additive; kept only if the sentence actually names an exclusion.
    for a in (exp.get("analyses") or []):
        note = str(a.get("numbers", ""))
        if not re.search(r"dof\s*=\s*\d+[^)]*\bused\b|exclud", note, re.I):
            continue
        tsec = next((n for n in spec["order"] if out.get(n) and re.search(r"\\chi|chi-squar", out[n], re.I)), None) \
            or out.get("_lead_section")
        if not tsec or not out.get(tsec) or re.search(r"exclud|too few", out[tsec], re.I):
            break
        sent = chat("A statistical test's numbers note: \"" + note[:220] + "\". In ONE plain sentence (<=32 words) state "
                    "which categories were INCLUDED in the test and which single category was EXCLUDED and why (too few "
                    "samples), so the degrees of freedom match. Use only the info in the note. Output ONLY the sentence.",
                    model, 130)
        sent = (sent or "").strip().strip('"').strip()
        if sent and 15 < len(sent) < 320 and re.search(r"exclud|too few", sent, re.I):
            paras = out[tsec].split("\n\n")
            j = next((i for i, p in enumerate(paras) if re.search(r"\\chi|chi-squar", p, re.I)), len(paras) - 1)
            paras[j] = paras[j].rstrip() + " " + sent
            out[tsec] = "\n\n".join(paras)
        break

    # RESULTS TABLE (P8): the structured comparison table our prose-only writer never produced. The assembler places it
    # raw into the lead (Results) section. Empty string when there is nothing tabular to compare or the table failed the
    # grounded-numbers check.
    out["_results_table"] = _results_table(chat, model, C, exp, demoted)

    # Abstract last; 1 paragraph. A CONCISE BUT REAL abstract is kept. The old <90-word trip wire fired on a
    # legitimate 6-sentence abstract and replaced it with a number-stripped concatenation of the raw findings --
    # that is what shipped on the plant paper ('(vh -)', '( vs,', 'd=-', shouting ALL-CAPS, no numbers left).
    # A findings dump is never an acceptable abstract, so a writer that really returns a stub is a HARD failure:
    # stage 3 is checkpointed and replayable, and a crash is visible where a wrecked abstract is not.
    ab_body = write_abstract(chat, model, C, exp, thesis, style, gfor("abstract"), scrub, trim, demoted)
    if len(ab_body.split()) < 55:
        ab_body = write_abstract(chat, model, C, exp, thesis, style, gfor("abstract"), scrub, trim, demoted)
    if len(ab_body.split()) < 55:
        raise RuntimeError("abstract writer returned a %d-word stub twice; refusing to ship a findings dump as "
                           "the paper's abstract" % len(ab_body.split()))
    out["ABSTRACT"] = ab_body
    return _dedup(out)
