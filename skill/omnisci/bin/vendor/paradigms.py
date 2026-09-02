"""paradigms -- a library of research-idea PARADIGMS, sampled into stage-1 ideation.

Why this exists (2026-08-28): with no framing at all, a perception-first
ideation loop drifts into one groove -- 'inspect the data, report an anomaly' --
and every paper becomes a negative/audit study. The fix is not to hard-code a
paradigm, but to show the agent a RANDOM SAMPLE of framings spanning how real
scientists actually frame contributions, with the audit groove capped at one
slot. The agent still picks freely; the sample only widens what it considers.

Discipline-agnostic by construction: every example is phrased over abstract
objects ('the measured property', 'the system') -- no domain literals.

Use:
    sample = paradigms.sample(k=10, seed=...)      # >=4 families, <=1 audit
    txt    = paradigms.render(sample)              # block for the system prompt
    fam    = paradigms.family_of(name)             # for the exit-gate check
"""
import random

# (family, name, one-line definition + generic example)
LIBRARY = [
    # -- method: propose a new way to do the task
    ("method", "new_method",
     "Propose a new method/algorithm for an existing task and show it beats sensible baselines. e.g. a new estimator for the property that is more accurate at the same budget."),
    ("method", "cross_domain_transfer",
     "Import a technique that is standard in another field and show it solves a problem here. e.g. an alignment trick from signal processing applied to these curves."),
    ("method", "hybridize",
     "Combine two existing techniques whose strengths are complementary. e.g. a symbolic front-end feeding a statistical back-end."),
    ("method", "radical_simplification",
     "Show a far simpler/cheaper method matches the standard one, and delimit when. e.g. three summary statistics match the deep pipeline on this task."),
    ("method", "new_objective",
     "Propose a new objective/score/loss that better captures what practitioners actually want. e.g. a ranking objective replacing thresholded accuracy."),
    # -- improvement: make an existing approach measurably better
    ("improvement", "fix_failure_mode",
     "Identify a known failure mode of the standard approach and contribute a fix that removes it without hurting the rest."),
    ("improvement", "robustness",
     "Make a method robust to a realistic perturbation (noise, shift, missing data) and quantify the robustness gain."),
    ("improvement", "efficiency",
     "Match the standard result at a fraction of the data/compute/annotation cost, and characterize the trade-off curve."),
    ("improvement", "calibration",
     "Give an existing predictor honest uncertainty: calibrated intervals/probabilities, validated empirically."),
    # -- empirical law: find quantitative structure in data
    ("empirical_law", "scaling_law",
     "Establish how a key quantity scales with size/range/noise, as a quantitative law with fitted exponents."),
    ("empirical_law", "universality",
     "Show one relationship holds across many systems/subgroups where per-system behaviour was assumed. e.g. a pooled fit explains all groups with one slope."),
    ("empirical_law", "regime_map",
     "Map where behaviour qualitatively changes: locate the boundary/phase transition in a control parameter and characterize both sides."),
    ("empirical_law", "variance_decomposition",
     "Quantify which factors explain the variation of the property, and how much each contributes."),
    ("empirical_law", "invariance",
     "Show a quantity is invariant under a transformation it was expected to depend on, and bound the deviation."),
    # -- mechanism: explain WHY an effect happens
    ("mechanism", "decompose_effect",
     "Decompose a known effect into components and identify which one drives it, with targeted interventions."),
    ("mechanism", "mediation",
     "Test whether the association between two variables is mediated by a third measurable variable."),
    ("mechanism", "counterfactual_probe",
     "Intervene on the hypothesized cause inside a computational system and show the effect follows."),
    # -- prediction: build something that forecasts
    ("prediction", "cheap_predictor",
     "Predict an expensive/slow/destructive measurement from cheap available features, with honest out-of-sample error."),
    ("prediction", "early_warning",
     "Predict an outcome EARLIER than current practice, and quantify the lead time vs accuracy trade-off."),
    ("prediction", "transportability",
     "Test whether a predictor trained in one site/domain/period survives transfer to another, and explain what breaks."),
    # -- measurement: create a better ruler
    ("measurement", "new_metric",
     "Define a metric for a property everyone discusses but nobody measures, validate it, and show it separates known cases."),
    ("measurement", "benchmark",
     "Construct a controlled evaluation suite for a capability and run the standard methods through it, revealing a ranking that was not known."),
    ("measurement", "reliability_study",
     "Quantify the measurement error/repeatability of a standard quantity and its downstream consequences."),
    # -- resource: contribute a reusable artifact
    ("resource", "derived_dataset",
     "Build a cleaned/derived/linked dataset that unlocks analyses the raw data cannot support, and demonstrate one."),
    ("resource", "label_efficiency",
     "Show a labelling/annotation scheme that reaches the same quality with far less effort."),
    # -- theory: formal structure, checked empirically
    ("theory", "bound_check",
     "Derive (or import) a theoretical bound/limit and test empirically how tightly real systems approach it."),
    ("theory", "unifying_frame",
     "Show several known special-case results are instances of one framework, and derive one new prediction from it."),
    ("theory", "impossibility",
     "Establish that a goal is unattainable under stated conditions, and locate the weakest condition to relax."),
    # -- comparative: settle a live question by fair comparison
    ("comparative", "head_to_head",
     "Run a matched-budget, matched-data comparison of the competing method families and settle which wins where."),
    ("comparative", "boundary_of_claim",
     "Reproduce a published claim and chart its boundary conditions: where it holds, where it quietly stops holding."),
    # -- synthesis: value from combining sources
    ("synthesis", "multi_source_fusion",
     "Show that combining heterogeneous sources yields signal none has alone, and quantify the synergy."),
    ("synthesis", "cross_modal_link",
     "Discover a correspondence between two representations/modalities of the same objects and exploit it."),
    # -- design: optimize how experiments/decisions are made
    ("design", "optimal_design",
     "Turn an empirical trial-and-error practice into a calculable design rule (how much data/range/replication achieves target precision)."),
    ("design", "decision_policy",
     "Derive the operating point/decision policy that optimizes a real downstream cost, not a proxy metric."),
    # -- audit: negative/error-finding studies (CAPPED at one slot per sample)
    ("audit", "artifact_hunt",
     "Show a dataset/method artifact (leakage, shortcut, bias) distorts accepted results, and quantify the distortion."),
    ("audit", "stress_test",
     "Break a standard method under realistic stress and characterize the failure envelope."),
]

FAMILIES = sorted({f for f, _, _ in LIBRARY})
_BY_NAME = {n: (f, d) for f, n, d in LIBRARY}


def family_of(name):
    return _BY_NAME.get(str(name).strip(), ("", ""))[0]


def sample(k=10, seed=None):
    """k paradigms spanning >=4 families with at most ONE from the audit family."""
    rng = random.Random(seed)
    audit = [p for p in LIBRARY if p[0] == "audit"]
    rest = [p for p in LIBRARY if p[0] != "audit"]
    rng.shuffle(rest)
    picked = rest[:k]
    if audit and rng.random() < 0.7:              # audit appears in ~70% of samples, always a single slot
        picked[-1] = rng.choice(audit)
    spare = rest[k:]
    slot = len(picked) - (2 if picked and picked[-1][0] == "audit" else 1)
    for cand in spare:                            # guarantee family spread, swapping tail slots one by one
        if len({p[0] for p in picked}) >= 4 or slot < 0:
            break
        if cand[0] not in {p[0] for p in picked}:
            picked[slot] = cand
            slot -= 1
    rng.shuffle(picked)
    return picked


def render(picked):
    """Prompt block: candidate framings the agent may draw on (never a straitjacket)."""
    lines = ["CANDIDATE RESEARCH FRAMINGS (a random sample of paradigms; use them to widen your brainstorm, "
             "then pick whatever the data genuinely supports -- you may also go outside this list):"]
    for fam, name, desc in picked:
        lines.append("- [%s/%s] %s" % (fam, name, desc))
    lines.append("Your >=5 candidates must span at least 3 different families, and AT MOST ONE candidate may "
                 "be an audit/error-finding study (family 'audit'). Set 'paradigm' on your finalized idea to "
                 "the [family/name] that best matches it (or 'other/<word>' if none fits).")
    return "\n".join(lines)
