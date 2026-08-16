# Data, preparation, and evaluation splits

The public repository uses two separate data tiers:

1. **Included demos** are small, real-data subsets committed under
   `engine/examples/<case>/`. They are enough to inspect every supported evidence
   family and smoke-test the perception tools. They are not the full inputs
   used for the paper's reported numbers.
2. **Paper data** are downloaded from their original publisher (or an existing
   Hugging Face dataset) and prepared locally. Multi-gigabyte third-party raw
   datasets are not duplicated inside the code repository.

The machine-readable source of truth is
[`datasets/manifest.json`](../engine/datasets/manifest.json).

## See what is included

```bash
python engine/scripts/data.py list
python engine/scripts/data.py verify --demos
python engine/scripts/data.py show galaxy_xsurvey
```

Seven cases include real files and run immediately:

| Case | Included demo | Full paper input |
|---|---:|---:|
| `birdaudio` | 3 no-bird + 3 has-bird WAV clips | 2,000 clips |
| `chem_series` | 1 molecule per chlorine-count group | 30 molecules |
| `feynman` | 6 distinct equation tables | 12 equations |
| `galaxy_xsurvey` | 3 galaxies × DECaLS/SDSS pair | 105 galaxies × 2 surveys |
| `histopath` | 1 tile per tissue class | 1,000 tiles |
| `med_ct3d` | 7 class-diverse 64³ volumes | 1,496 volumes |
| `stead_seismic` | 3 earthquake + 3 noise traces | 1,500 traces |

`dna`, `kg_biokg`, and `supercon` are metadata-only until fetched, because
their official loaders are already reliable and the full tabular/graph data
would unnecessarily inflate every Git clone.

## One-command full-data fetches

Install optional data dependencies only if needed:

```bash
pip install -r engine/requirements-data.txt
```

The following paper inputs have executable fetchers:

```bash
# UCI ZIP -> engine/examples/supercon/data/{train.csv,unique_m.csv}
python engine/scripts/data.py fetch supercon

# Hugging Face H3/train.parquet -> stable first 10,000 rows
python engine/scripts/data.py fetch dna

# Hugging Face Kather Texture 2016 -> 125 RGB tiles per class
python engine/scripts/data.py fetch histopath

# Official OGB loader -> graph, mappings, and official splits
python engine/scripts/data.py fetch kg_biokg
```

For cases whose upstream download is several gigabytes or needs a live
service, `fetch` prints the exact source and preparation recipe instead of
silently starting a huge transfer:

```bash
python engine/scripts/data.py fetch birdaudio
python engine/scripts/data.py fetch galaxy_xsurvey
python engine/scripts/data.py fetch stead_seismic
```

The upstream sources are:

- [Bird Audio Detection / freefield1010](https://machine-listening.eecs.qmul.ac.uk/bird-audio-detection-challenge/)
- [Delaney ESOL mirror](https://deepchemdata.s3-us-west-1.amazonaws.com/datasets/delaney-processed.csv)
- [Nucleotide Transformer H3 task](https://huggingface.co/datasets/InstaDeepAI/nucleotide_transformer_downstream_tasks)
- [AI Feynman / FSReD](https://space.mit.edu/home/tegmark/aifeynman.html)
- [Galaxy10 DECaLS](https://astronn.readthedocs.io/en/stable/galaxy10.html)
- [Kather Texture 2016](https://huggingface.co/datasets/1aurent/Kather-texture-2016)
- [OGB `ogbl-biokg`](https://ogb.stanford.edu/docs/linkprop/#ogbl-biokg)
- [MedMNIST v2](https://medmnist.com/v2)
- [STEAD](https://github.com/smousavi05/STEAD)
- [UCI Superconductivty Data](https://archive.ics.uci.edu/dataset/464/superconductivty+data)

## Exact demo selection

The demos are not arbitrary first rows. The maintainer script
[`scripts/build_demo_bundle.py`](../engine/scripts/build_demo_bundle.py) rebuilds
them deterministically from fully prepared case directories:

```bash
python scripts/build_demo_bundle.py \
  --source /path/to/full/examples \
  --output examples
```

Selection is class- or group-aware: audio and seismic demos are balanced,
histopathology covers every tissue class, CT covers all three subsets with
distinct labels, chemistry spans chlorine-count groups, and the galaxy demo
keeps both survey images for each selected `gid`.

Every generated `series.json` contains an explicit `_demo` block with the demo
size, full size, selection rule, and a warning that it is an interface smoke
test rather than a reproduction of the paper score.

## Splits used in the paper

Dataset preparation and evaluation splitting are separate operations. The
paper protocols are:

| Case | Split / grouping protocol |
|---|---|
| `birdaudio` | Stratified 5-fold CV, seed 42; scaler fit on train folds. No site/session group key is available. |
| `chem_series` | No train/test split; matched comparisons within chlorine-count groups. |
| `dna` | Stratified 5-fold CV over 10,000 unique sequences; bootstrap unit is one sequence. |
| `feynman` | Each equation is an independent recovery case; no cross-equation split. |
| `galaxy_xsurvey` | Paired evaluation by `gid`; DECaLS and SDSS images of the same galaxy always stay together. |
| `histopath` | Stratified 5-fold CV by tissue class. |
| `kg_biokg` | Official `dataset.get_edge_split()` train/valid/test split. |
| `med_ct3d` | Stratified 5-fold CV per subset plus a check on the official MedMNIST split. |
| `stead_seismic` | No supervised split; null-calibrated threshold and station-cluster bootstrap by network+station. |
| `supercon` | Random 5-fold CV compared against leave-one-family-out extrapolation. |

These protocols are also stored per case in `datasets/manifest.json`, so
documentation and tooling do not drift apart.

## Hugging Face

Hugging Face is useful here in two ways:

- use an existing publisher-backed Hub dataset when one already exists
  (`dna`, `histopath`);
- publish a future **OmniScientist prepared-data repository** containing exact
  manifests, selected indices, checksums, and derived artifacts for one-command
  reproduction.

It should not become an unversioned mirror of every third-party raw dataset.
Several sources are multi-gigabyte, already have canonical downloaders, and
carry their own licenses and attribution requirements. The code repository
therefore ships small attributed demos; original publishers remain canonical
for full raw data.

No OmniScientist full-data Hub repository is claimed in this release until its
organization, version, licenses, and checksums are finalized.

## Data licenses

The repository's MIT license covers OmniScientist code, not third-party data.
Included demo files retain their upstream terms. In particular, freefield1010
challenge data, Kather Texture 2016, MedMNIST, STEAD, UCI Superconductivty
Data, and OGB BioKG require the attribution or license handling stated in
`datasets/manifest.json` and on their linked source pages.
