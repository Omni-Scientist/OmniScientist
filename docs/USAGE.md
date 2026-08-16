# Usage guide

A fuller guide to running and extending OmniScientist. See the top-level `README.md` for the overview.

## Data setup

Seven public examples include small real-data demos. Verify them before a
smoke test:

```bash
python engine/scripts/data.py verify --demos
```

Use `python engine/scripts/data.py list` to see which cases are included and which
require a full-data fetch. For any case, the following command prints its
publisher, license, preprocessing, and split/grouping protocol:

```bash
python engine/scripts/data.py show stead_seismic
```

See [`DATASETS.md`](DATASETS.md) for all download routes and the important
distinction between an included demo and the paper's full evaluation input.

## The engine

The engine is `engine/omniscientist/agentic.py`: a pipeline of agents where each stage is a tool-using ReAct loop with a deterministic exit gate. A task lives in `engine/examples/<name>/series.json` (the data plus an open research direction).

**Run the whole thing with one command.** This is the intended way to use OmniScientist:

```bash
python engine/omniscientist/agentic.py --task stead_seismic --stage run
```

`--stage run` is the orchestrator (`run_pipeline`). It runs ideation, then experiment, then writeup, perceiving the raw evidence at every stage, and it is the **only** mode that backtracks: a deterministic router (`_route`) advances a stage that produced a real result and, when the experiment comes back null or infeasible, sends the pipeline back to re-ideate (up to `MMSCI_MAX_BACKTRACKS`, default 2), remembering the failed idea so the next attempt is different. The run writes to `engine/examples/<task>/stages/`: a `0N_trace.json` per stage (rendered to a click-to-expand HTML page by `trace_viewer.py`) and the finished `03_paper.tex` / `03_paper.pdf`.

> Advanced / debugging only: you can run a single stage in isolation with `--stage 1`, `--stage 2`, or `--stage 3` (each reads the previous stage's artifact from disk). A single stage does **not** backtrack, since backtracking is a decision the orchestrator makes across stages. For real runs, always use `--stage run`.

## Backbones and transports

`pipeline.py` routes each model name to the right transport automatically:

| Model name | Transport | Env var |
|---|---|---|
| `gpt-...`, `o1/o3/o4` | OpenAI official (automatic prompt caching) | `OPENAI_API_KEY` |
| `claude-sonnet-5`, `claude-opus-4-8`, ... | Anthropic native SDK (prompt caching) | `ANTHROPIC_API_KEY` |
| `or/...` | OpenRouter aggregator | `OPENROUTER_API_KEY` |
| `local/...` | Local vLLM / sglang endpoint | `OMNIST_LOCAL_URL`, `OMNIST_LOCAL_KEY` |
| anything else | OpenAI-compatible gateway (bring your own) | `OMNIST_GATEWAY_URL`, `OMNIST_GATEWAY_KEY` |

Select the backbone with `OMNIST_MODEL`. The perceiver (the model that actually reads images) can be set separately with `OMNIST_PERCEIVER` if you want a reliable vision model while a different backbone drives reasoning. Any model named there must accept image input: `gpt-5.6-luna` and `claude-sonnet-5` both do, `deepseek-*` does not. The sample papers used `claude-sonnet-5` for both roles.

## The perception layer

`evidence.py` is the four-family perception and tool layer. It auto-routes each artifact by file extension, so you do not touch engine code to add a modality:

- **Perceptual**: `look_at_image`, `look_at_signal`, `look_at_audio`, `look_at_video`, `look_at_3d` (plus `analyze_*` variants that return quantitative summaries).
- **Structured / statistical**: `read_table`, `run_python` for real computation on the real data.
- **Symbolic**: `read_text`, formula and knowledge-graph handling.
- **Procedural**: `read_trace`, execution traces.

`selfcheck_tools.py` runs a per-modality health check on the perception tools against real sample data, so a silently degenerate renderer is caught before it misleads a run.

## Writeup

The writeup stage is field-aware. `paper_specs.py` holds per-journal styles (NeurIPS, Nature, PRL, ApJ, ACS); `writer.py` drafts each section by outline then per-section expansion with running context, then a global coherence and de-duplication pass. Citations are grounded in the live OpenAlex and Crossref APIs and are never fabricated: queries hit the real API and only returned entries are cited. If the citation service is unreachable, the writer logs it and falls back to citation-free prose; if a citation build fails to compile, it falls back to a guaranteed citation-free PDF.

## Adding a discipline

Write only a `series.json` under `engine/examples/<name>/`:

- `role`, `subject`, `property`, `domain`: who the agent is and what it studies.
- `direction`: an **open** research direction. State the data and the goal; let the agent choose the method. Do not prescribe the analysis.
- `perception`: the per-item perception question and, optionally, `group_by`, `extract`, `truth_fields`.
- `members` (or a `data` block for table-only cases): the rows, each pointing at a file under `data/`.

Then place the dataset under `engine/examples/<name>/data/` (or another path named in
the case's `series.json`) and run the pipeline. Keep data preparation separate
from evaluation splitting: record source, checksum, preprocessing, group key,
split method, and random seed in `datasets/manifest.json`.

## Reproducing the evaluation

The scoring code lives alongside the engine:

- `score.py`, `eval_common.py`: the seven-dimension peer-review rubric (novelty, soundness, clarity, significance, reproducibility, multimodal grounding, factual) plus the holistic overall, and the cross-family two-judge panel.
- `run_matrix.py`: run the discipline x backbone matrix.
- `blind_features.py`, `pairwise.py`: the blind scalar baseline and head-to-head comparison used in the perception ablation.
- `judge_stats.py`: judge-validity statistics (inter-judge agreement, self-preference bias).

The judges are reached through an OpenAI-compatible endpoint; point it at your own provider to reproduce the panel.
