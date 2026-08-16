# engine: the reference implementation

The technical report's artifact. This is the edition that reproduces the reported
numbers, runs the 36-case battery, and holds the evaluation harness. It calls a model
API itself, so it needs a key, and it is the one to use when you want a run to be
scriptable and reproducible rather than conversational.

```bash
pip install -r requirements.txt
export OMNIST_MODEL=claude-sonnet-5
export ANTHROPIC_API_KEY=sk-ant-...

python omniscientist/agentic.py --task galaxy_xsurvey --stage run
```

Output lands in `examples/<task>/stages/`: the trace, the experiment record, and
`03_paper.tex` with `03_paper.pdf` beside it.

## Cases

A role, a subject, an **open** research direction, and the data. That is the whole
interface for adding a discipline; no engine code changes. `evidence.py` routes files
by type, so images, signals, audio, video, 3-D volumes, tables, and graphs each reach
the right tools.

The direction has to stay open. Writing the method into it ("use a paired McNemar
test on the two surveys") turns the agent into a script executor, and the run stops
being evidence of anything.

## Layout

```
omniscientist/
├── agentic.py       the three-stage loop and its gates. Start here.
├── pipeline.py      transport: model routing, prompt caching, image blocks
├── evidence.py      the perception and computation tool layer, by modality
├── paper.py         LaTeX assembly, figure interleaving, citation filtering
├── writer.py        the writing stage
├── paper_specs.py   per-venue structure and style
├── venue_styles.py  the venue templates
├── score.py         the judge panel
├── pairwise.py      head-to-head comparison between conditions
├── eval_common.py   the one true scoring setup. Do not hand-enter scores.
├── run_matrix.py    batch runs across cases and backbones
├── judge_stats.py   agreement and validity checks on the judges
├── blind_features.py the blind control condition
├── selfcheck_tools.py  per-modality tool self-test
└── trace_viewer.py  read a run back

examples/     case specifications plus seven small real-data demos
datasets/     machine-readable provenance, preparation, and split manifest
scripts/      data.py: list, fetch, verify
```

## The loop

Three stages, each a tool-using ReAct loop that perceives before it acts, each behind
a deterministic gate the agent cannot talk its way past.

The design constraints are deliberate and worth not undoing:

- **No blind perception over every image.** Materials are discovered through cheap
  text metadata first, zero pixels; images are then inspected a few at a time, on
  demand, under a hard budget. The budget is charged per image, not per call.
- **Vision is one optional tool.** A text-only topic never sees it. Nothing in the
  loop is special-cased for a modality.
- **A null result goes back to ideation** rather than being written up as a triumph.

## Evaluation

`eval_common.py` is the single source of truth for the scoring setup. Scores are
recomputed from raw judge output; never transcribe a number from a stored panel into
a table, because stored panels go stale and the mixture of judges behind them is not
always the canonical one.

`selfcheck_tools.py` verifies each modality's tools return something non-degenerate,
which is how a silently broken renderer gets caught before it costs a whole run.
