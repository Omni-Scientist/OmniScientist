"""Single source of truth for all score tables.

Two fixes baked in, so no table can drift or mislabel again:
  1. Consistent judge panel: every run's per-dimension score is recomputed as the mean of
     the two cross-family judges the captions name, deepseek-v4-flash and
     gemini-2.5-flash-lite, from the raw per-judge scores in judges{}. The stored `panel`
     field is ignored (it was a stale, per-row-heterogeneous judge mix).
  2. Correct backbone -> run mapping (verified against run_matrix.py MODEL_ID + cost ledger):
     gpt-5.6 = the `terra` (gpt-5.6-terra) runs; Kimi K2.7 = the `kimi` runs only.
     The `gpt55` tag is gpt-5.5 (a different model, and it has no flash-lite scores) -> dropped.

Run generators from engine/.
"""
import json, glob, statistics as st

DIMS7 = ['novelty', 'soundness', 'clarity', 'significance',
         'reproducibility', 'mm_grounding', 'factual_accuracy']
J1, J2 = 'deepseek-v4-flash', 'gemini-2.5-flash-lite'


def panel2(path):
    """Consistent two-judge panel for one run. dict with 7 dims + overall + composite,
    or None if the run lacks either judge (cannot form the panel)."""
    try:
        j = json.load(open(path)).get('judges', {})
    except Exception:
        return None
    a, b = j.get(J1), j.get(J2)
    if not a or not b:
        return None
    out = {}
    for d in DIMS7 + ['overall']:
        va, vb = a.get(d), b.get(d)
        if va is None or vb is None:
            return None
        out[d] = (float(va) + float(vb)) / 2.0
    out['composite'] = st.mean([out[d] for d in DIMS7])
    return out


# The full demonstration suite. storm_radar_video and cell_video originally failed at
# ideation because the video frame sampler charged the image budget per frame and fed the
# VLM one isolated frame at a time; both complete end to end since that was fixed.
BASE34 = ("nffa_sem rruff_raman supercon chem_series feynman eurosat_demo galaxy galaxy_xsurvey "
          "gwosc_gw stead_seismic whoi_plankton rock_ct storm_track histopath_demo chestxray "
          "med_ct3d heartsound sleepedf dna plantvillage hyperspectral calms21 birdaudio "
          "whale_audio plant_pheno3d fish_sonar_video animal_track mcb_cad semantickitti "
          "comma2k19 machine_sound vehicle_track pdebench kg_biokg "
          "storm_radar_video cell_video").split()


def _base_paths():
    return [f'examples/{c}/stages/06_scores.json' for c in BASE34]


def _suffix_paths(suf):
    return sorted(glob.glob(f'examples/*__{suf}/stages/06_scores.json'))


# (row label, callable -> list of 06_scores.json paths). Order = paper's backbone table.
BACKBONES = [
    ('Sonnet~5',     _base_paths),
    ('GPT-5.6',      lambda: _suffix_paths('terra')),
    ('GLM-5.2',      lambda: _suffix_paths('glm')),
    ('Kimi~K2.7',    lambda: _suffix_paths('kimi')),
    ('Qwen3.5-27B',  lambda: _suffix_paths('qwen27')),
    ('Qwen3.5-9B',   lambda: _suffix_paths('qwen9')),
    ('Qwen3.5-122B', lambda: _suffix_paths('qwen122')),
    ('Gemma-4-31B',  lambda: _suffix_paths('gemma431')),
    ('Gemma-4-26B',  lambda: _suffix_paths('gemma426')),
]


def panels_for(getpaths):
    """The valid (2-judge) panels for a backbone."""
    return [p for p in (panel2(x) for x in getpaths()) if p is not None]
