# -*- coding: utf-8 -*-
"""FIELD_SPECS -- per journal-STYLE section templates for the stage-3 writer, distilled from 5 role-agent
designs each verified against real journal author guidelines (Earth&Space AGU/GJI/ApJ; CS/ML ICLR/ACL;
Life&Medical Nature/Radiology; Chemistry&Materials JACS/npj; Physics PRL/PRD).

Journal STYLE is DECOUPLED from the case's research domain: a plant case may be written Nature-style, a
seismology case JGR-style. A case picks a style via series.json 'style' (else inferred). The writer reads the
style's section list + per-section {word_range, n_paragraphs, outline, cite, floats} and does outline->expand.

Each section spec:
  name      : printed heading
  words     : soft [min, max] total for the section
  paras     : [min, max] paragraphs (== len(outline) target)
  outline   : ORDERED list of paragraph jobs (one string per paragraph) -- domain-agnostic
  cite      : True if this section should weave the gathered real references (\\cite)
  floats    : where figures/tables go -- 'lead' (this section carries the result figures) | 'some' | 'none'
"""
import re

# reusable paragraph jobs (kept generic; the writer grounds them in the case's data)
_P = {
    "motiv":   "the broad problem and why it matters in the field (concrete stakes, not generic filler)",
    "prior1":  "prior work part one: what is established and the governing framework, citing the real references",
    "prior2":  "prior work part two: the leading recent methods and the tensions or unresolved issues among them, with citations",
    "gap":     "the specific open gap or question this study targets, in one sharp paragraph",
    "this":    "what THIS study does, the data/approach, and the single strongest supported result stated up front with its numbers",
    "roadmap": "a one-sentence roadmap of the remaining sections",
    "data_prov":  "data provenance: the source, instrument or survey, time span, and scale of the dataset",
    "data_sel":   "sample or event selection criteria and the resulting sample definition",
    "data_qual":  "coverage, volume, quality and any limitations of the data",
    "data_prep":  "preprocessing: how the raw data were prepared (filtering, calibration, quality control, labelling)",
    "meth_over":  "an overview of the approach and its theoretical or algorithmic framework",
    "meth_feat":  "the exact features and the model/classifier used, naming the classifier EXACTLY as in the study facts "
                  "(never substitute a different model); give the DEFINING EQUATION of each key derived quantity as a "
                  "DISPLAYED, numbered LaTeX equation (\\begin{equation}...\\end{equation}) writing out the actual "
                  "expression from the study facts, not a vague verbal description of the formula",
    "meth_proc":  "the procedure step by step, with the EXACT window lengths, thresholds and parameter values used: "
                  "preprocessing and normalization (state that any scaler is fit on the training fold only), how "
                  "features are computed, and how each analysis is run and on WHICH sample subset",
    "meth_eval":  "the evaluation protocol in REPRODUCIBLE detail: total and per-class or per-group sample sizes, the "
                  "train/test split (random vs group-disjoint, number of folds, stratification), the metrics, and the "
                  "statistical tests with any multiple-comparison correction and the bootstrap/resampling unit; state "
                  "the EXACT sample EACH analysis runs on and do not conflate them -- an analysis is run only on the "
                  "samples for which its required variables are defined (not on samples that lack them), which may be a "
                  "different subset from the one a comparison/classification analysis uses",
    "res_lead":   "the headline result (the thesis's core evidence), tied to its main figure, stated with its EXACT "
                  "numbers as numerals: the effect size / coefficient with its standard error or confidence interval, "
                  "the p-value, the model fit (R-squared if a regression), and the sample size n. A Results sentence "
                  "that says 'systematic' or 'clear' WITHOUT reporting these numerals is incomplete -- report them",
    "res_mech":   "the analysis that best illuminates WHY the headline holds, with its numbers and figure; state the "
                  "mechanism at the level the DESIGN supports (as consistent-with for an observational/regression study; "
                  "as established only if a controlled or derivational design actually demonstrates it)",
    "res_supp":   "each remaining analysis in ITS rhetorical role: a baseline/control that LOCATES the finding's role, a "
                  "boundary that DEFINES where the finding applies or does not, or a robustness check, each stated with "
                  "its EXACT numbers (metric values, effect sizes, p-values, sample sizes) and figure and WHICH sample "
                  "subset it used (do not present a control or boundary as a co-equal success, nor as a failure)",
    "res_robust": "robustness and sensitivity checks with their EXACT numbers, showing where the finding is stable and "
                  "where it is bounded; report the fold-to-fold or across-condition VARIABILITY (std or range), and if "
                  "the variability is large relative to the mean do NOT call the result 'stable' -- say it is present "
                  "on average but variable",
    "disc_interp":"the interpretation of the primary result: the reading the evidence supports, stating any mechanism at "
                  "the level the design licenses (consistent-with for observational designs; established for controlled "
                  "or derivational ones)",
    "disc_prior": "how the finding relates to and advances beyond prior work",
    "disc_impl":  "the implications the evidence actually licenses for the question posed in the introduction "
                  "(scope-appropriate; avoid operational, invariance, or generalisation over-reach)",
    "disc_limit": "an honest paragraph of THIS study's own limitations: sample size and statistical power, any "
                  "measurement or proxy assumptions, non-independence among the reported analyses, and the bound on "
                  "generalization; frame every limitation as a bound on SCOPE, never as doubt on the finding's validity",
    "concl":      "a concise restatement of the objective, what was done, and the key finding (no new numbers)",
    "concl_out":  "the significance the evidence supports and concrete future directions (no over-reach)",
    "rw_theme":   "one theme of prior work grouped together with its citations, ending by contrasting with this study",
    "contrib":    "an explicit enumerated list of this paper's contributions, each one sentence",
    "exp_setup":  "the experimental setup: datasets, baselines, metrics, and implementation",
    "exp_main":   "the main quantitative results versus the baselines, stated with the effect and its magnitude and "
                  "figure/table, and what it does and does not establish",
    "exp_abl":    "ablations that isolate what drives the result, with the ablation table",
    "theory":     "the formal setup, notation, and governing equations of the model or system",
    "expt_mat":   "materials, samples, and their preparation or synthesis",
    "expt_char":  "the characterization and measurement instruments and protocols",
}

# Introduction jobs are venue-specific. Keep these separate from the reusable body-section jobs above: collapsing
# every field onto motiv/prior/gap/this is exactly the kind of flattening that loses the venue's rhetorical shape.
_INTRO = {
    "earth_space": [
        "BIG PICTURE: open with one broad present-tense statement of established fact and explain why the phenomenon "
        "matters; do not open with a laundry list of applications",
        "NARROW TO SUBTOPIC: zoom from that framing to the specific regime, mechanism, or measurement addressed here",
        "PRIOR WORK: synthesize the relevant literature densely and build one cited argument toward the unresolved "
        "question rather than piling references",
        "GAP: state precisely what remains unresolved, contradictory, or unmeasured",
        "THIS STUDY: state the aim, approach, and data or sample, then give a qualitative preview of the finding; keep "
        "exact result numbers in the Abstract and Results",
    ],
    "cs_ml": [
        "CONTEXT: establish the task or capability and narrow quickly to this paper's specific problem",
        "GAP: explain what prior approaches do, where they fall short, and end on the precise open question",
        "APPROACH: name the method or idea and give its one-line intuition with minimal technical detail",
        "RESULTS PREVIEW: state the headline outcome in one sentence with only the single flagship number",
        "CONTRIBUTIONS: end with a short lead-in and a LaTeX itemize list of three or four verb-first contributions",
    ],
    "biomed": [
        "CLINICAL IMPORTANCE: establish why the problem matters clinically or biologically in a concrete opening",
        "WHAT IS KNOWN AND THE GAP: synthesize the pertinent evidence or current standard, then name the specific gap",
        "OBJECTIVE: end with an explicit aim or purpose statement and do not preview results or performance numbers",
    ],
    "physics": [
        "CONTEXT: introduce the broad phenomenon in plain language that a physicist outside the subfield can follow",
        "STAKES AND GAP: explain why the specific quantity or problem matters and what has remained unresolved",
        "THIS WORK AND RESULT: state what was done and the headline result together, using at most one key number",
        "IMPLICATION: close with what the result enables or means for the physical question",
    ],
    "chem": [
        "IMPORTANCE: establish why the compound class, property, or measurement matters",
        "PRIOR ART AND GAP: summarize established approaches briefly, then identify the unresolved challenge",
        "THIS WORK AND PREVIEW: announce what was made, computed, or measured together with one key result",
        "SIGNIFICANCE: close with the conceptual advance or capability supported by that result",
    ],
}


def _sec(name, words, paras, outline, cite=False, floats="none"):
    if list(paras) != [len(outline), len(outline)]:
        raise ValueError("%s must define exactly one paragraph per ordered job" % name)
    return {"name": name, "words": words, "paras": paras, "outline": outline, "cite": cite, "floats": floats}


FIELD_SPECS = {

    # ---- Earth & Space (JGR/GJI/ApJ) : Intro -> Data -> Methods -> Results -> Discussion -> Conclusions ----
    "earth_space": {
        "abstract": _sec("Abstract", [150, 250], [1, 1],
                         ["one paragraph: context; the gap; the data and approach; the headline results with numbers; the significance"]),
        "order": ["Introduction", "Data", "Methods", "Results", "Discussion", "Conclusions"],
        "sections": {
            "Introduction": _sec("Introduction", [750, 1100], [5, 5], _INTRO["earth_space"], cite=True),
            "Data":         _sec("Data", [350, 800], [4, 4],
                                 [_P["data_prov"], _P["data_sel"], _P["data_qual"], _P["data_prep"]], floats="some"),
            "Methods":      _sec("Methods", [450, 1000], [4, 4],
                                 [_P["meth_over"], _P["meth_feat"], _P["meth_proc"], _P["meth_eval"]]),
            "Results":      _sec("Results", [700, 1600], [4, 4],
                                 [_P["res_lead"], _P["res_mech"], _P["res_supp"], _P["res_robust"]], floats="lead"),
            "Discussion":   _sec("Discussion", [500, 1200], [4, 4],
                                 [_P["disc_interp"], _P["disc_prior"], _P["disc_impl"], _P["disc_limit"]]),
            "Conclusions":  _sec("Conclusions", [200, 450], [2, 2], [_P["concl"], _P["concl_out"]]),
        },
    },

    # ---- CS / ML (ICLR/NeurIPS) : Intro(+contrib) -> Related Work -> Method -> Experiments -> Conclusion ----
    "cs_ml": {
        "abstract": _sec("Abstract", [150, 220], [1, 1],
                         ["one paragraph: context and why it matters; the gap; what we propose and the key idea; headline results with numbers; the takeaway"]),
        "order": ["Introduction", "Related Work", "Method", "Experiments", "Conclusion", "Limitations"],
        "sections": {
            "Introduction": _sec("Introduction", [500, 900], [5, 5], _INTRO["cs_ml"], cite=True),
            "Related Work": _sec("Related Work", [400, 700], [3, 3],
                                 [_P["rw_theme"], _P["rw_theme"], _P["rw_theme"]], cite=True),
            "Method":       _sec("Method", [500, 1100], [3, 3],
                                 [_P["meth_over"], _P["meth_feat"], _P["meth_proc"]]),
            "Experiments":  _sec("Experiments", [800, 1600], [4, 4],
                                 [_P["exp_setup"], _P["exp_main"], _P["exp_abl"], _P["res_robust"]], floats="lead"),
            "Conclusion":   _sec("Conclusion", [150, 350], [2, 2], [_P["concl"], _P["concl_out"]]),
            "Limitations":  _sec("Limitations", [150, 320], [1, 1], [_P["disc_limit"]]),
        },
    },

    # ---- Life & Medical (Nature style) : Intro -> Results -> Discussion -> Methods (at end) ----
    "biomed": {
        "abstract": _sec("Abstract", [150, 200], [1, 1],
                         ["one paragraph: context and importance; the objective; what was done (cohort/model); key quantitative results; the principal conclusion"]),
        "order": ["Introduction", "Results", "Discussion", "Methods"],
        "sections": {
            "Introduction": _sec("Introduction", [400, 700], [3, 3], _INTRO["biomed"], cite=True),
            "Results":      _sec("Results", [800, 1800], [4, 4],
                                 [_P["res_lead"], _P["res_mech"], _P["res_supp"], _P["res_robust"]], floats="lead"),
            "Discussion":   _sec("Discussion", [500, 1000], [4, 4],
                                 [_P["disc_interp"], _P["disc_prior"], _P["disc_impl"], _P["disc_limit"]]),
            "Methods":      _sec("Methods", [500, 1200], [4, 4],
                                 [_P["meth_over"], _P["meth_feat"], _P["meth_proc"], _P["meth_eval"]]),
        },
    },

    # ---- Physics (Phys Rev D/E Article) : Intro -> Theory/Methods -> Results -> Discussion -> Conclusion ----
    "physics": {
        "abstract": _sec("Abstract", [150, 250], [1, 1],
                         ["one paragraph: physical problem; approach; the principal result stated quantitatively; the significance"]),
        "order": ["Introduction", "Theory and Methods", "Results", "Discussion", "Conclusion"],
        "sections": {
            "Introduction":       _sec("Introduction", [500, 1100], [4, 4], _INTRO["physics"], cite=True),
            "Theory and Methods": _sec("Theory and Methods", [500, 1300], [4, 4],
                                       [_P["theory"], _P["meth_feat"], _P["meth_proc"], _P["meth_eval"]]),
            "Results":            _sec("Results", [800, 1900], [4, 4],
                                       [_P["res_lead"], _P["res_mech"], _P["res_supp"], _P["res_robust"]], floats="lead"),
            "Discussion":         _sec("Discussion", [500, 1200], [4, 4],
                                       [_P["disc_interp"], _P["disc_prior"], _P["disc_impl"], _P["disc_limit"]]),
            "Conclusion":         _sec("Conclusion", [250, 550], [2, 2], [_P["concl"], _P["concl_out"]]),
        },
    },

    # ---- Chemistry & Materials (JACS variant A) : Intro -> Experimental -> Results and Discussion -> Conclusions ----
    "chem": {
        "abstract": _sec("Abstract", [150, 250], [1, 1],
                         ["one paragraph: field context; the challenge; what was made or measured; two to three specific results with numbers; the conceptual advance"]),
        "order": ["Introduction", "Experimental Section", "Results and Discussion", "Conclusions"],
        "sections": {
            "Introduction":           _sec("Introduction", [400, 900], [4, 4], _INTRO["chem"], cite=True),
            "Experimental Section":   _sec("Experimental Section", [400, 1000], [4, 4],
                                           [_P["expt_mat"], _P["expt_char"], _P["meth_proc"], _P["meth_eval"]]),
            "Results and Discussion": _sec("Results and Discussion", [1000, 2200], [6, 6],
                                           [_P["res_lead"], _P["res_mech"], _P["res_supp"], _P["disc_interp"],
                                            _P["disc_prior"], _P["disc_limit"]], cite=True, floats="lead"),
            "Conclusions":            _sec("Conclusions", [150, 350], [2, 2], [_P["concl"], _P["concl_out"]]),
        },
    },
}

# research-domain (or field hint) -> default journal style. A case's series.json 'style' overrides this.
STYLE_BY_FIELD = {
    "earth": "earth_space", "space": "earth_space", "astro": "earth_space", "geo": "earth_space",
    "seismic": "earth_space", "remote": "earth_space",
    "ml": "cs_ml", "cs": "cs_ml", "engineering": "cs_ml", "info": "cs_ml",
    "bio": "biomed", "medical": "biomed", "agri": "biomed", "plant": "biomed", "ecology": "biomed",
    "physics": "physics",
    "chem": "chem", "materials": "chem", "material": "chem",
}


# subject-keyword inference (used ONLY when neither 'style' nor 'field' is set) -- decoupled from domain, best-effort.
# Keywords are matched on WORD BOUNDARIES (not bare substrings), and only UNAMBIGUOUS domain terms are kept (no
# 'strain'/'waveform'/'cell'/'agent'/'remote' that collide with constraint/audio/solar-cell/therapeutic-agent/etc.).
_SUBJECT_HINTS = [
    (("seismogram", "seismic", "earthquake", "gravitational", "galaxy", "telescope", "astronomical",
      "satellite", "sentinel-2", "reflectance spectrum", "hyperspectral"), "earth_space"),
    (("symbolic regression", "feynman", "governing equation", "dynamical system", "physical law",
      "conservation law"), "physics"),
    (("scanning electron", "sem image", "micrograph", "crystal", "molecule", "smiles", "materials",
      "superconductor", "mineral", "reagent"), "chem"),
    (("point cloud", "lidar", "dashcam", "driving", "autonomous vehicle", "steering", "knowledge graph",
      "pde", "simulation trace", "execution trace", "classifier", "neural network", "deep learning",
      "machine learning", "benchmark", "convolutional", "transformer", "reinforcement learning"), "cs_ml"),
    (("phonocardiogram", "heart sound", "chest x-ray", "radiograph", "histopathology", "tissue", "dna",
      "genome", "nucleotide", "plankton", "leaf", "plant", "bird", "clinical", "patient", "cohort", "eeg"), "biomed"),
]


def style_of(C):
    """Resolve the journal style for a case (DECOUPLED from research domain): explicit C['style'] wins; else map
    C['field']; else infer from the subject keywords (word-boundary matched); else neutral fallback (biomed). A case
    should set 'style' or 'field' in series.json when the subject text is ambiguous -- inference is only a fallback."""
    s = str(C.get("style") or "").strip().lower()
    if s in FIELD_SPECS:
        return s
    f = str(C.get("field") or "").strip().lower()
    if f in STYLE_BY_FIELD:
        return STYLE_BY_FIELD[f]
    subj = str(C.get("subject") or "").lower()
    for kws, st in _SUBJECT_HINTS:
        if any(re.search(r"\b" + re.escape(k) + r"\b", subj) for k in kws):
            return st
    return "biomed"
