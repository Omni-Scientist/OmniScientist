# skill: OmniScientist inside Claude Code

Runs the research loop inside your own agent session, so it needs no API key: the
session you already pay for does the seeing and the writing.

```bash
cp -r omnisci ~/.claude/skills/
pip install -r ~/.claude/skills/omnisci/requirements.txt
```

Then say what you want: *"I have a folder of microscope images in `~/slides`, make me
a paper."* The skill is picked by its description, or invoke it as `/omnisci`.
Installation notes, including tectonic per architecture, are in
[`omnisci/INSTALL.md`](omnisci/INSTALL.md).

## How it works

Every perception tool has two halves. The first renders raw data into something
viewable: an `.npy` waveform, a `.wav` spectrogram, a video contact sheet, a
point-cloud projection all become a PNG. The second is a single function that asks one
question about that PNG.

This edition replaces that function with a collector. Tools run to completion leaving
`<<VISION:n>>` placeholders, the host opens the PNGs with its own multimodal read, and
`ingest` substitutes the answers back in. The `analyze_*` tools are pure computation and
involve no model at all. `hostbridge` installs a stub model client that raises, so no
call can leave this process.

## Layout

```
omnisci/
├── SKILL.md            what the agent reads
├── INSTALL.md
├── requirements.txt
└── bin/
    ├── case_cli.py     scan a folder of data, write a series.json
    ├── evidence_cli.py perception: render, hand back, ingest
    ├── gate_cli.py     record a run, then refuse ungrounded numbers
    ├── lit_cli.py      real references from OpenAlex and Crossref, with DOIs
    ├── paper_cli.py    assemble the LaTeX and compile
    ├── hostbridge.py   the swap described above
    └── vendor/         the engine modules the CLIs import
```

`vendor/` is a snapshot of `engine/omniscientist` rather than a symlink, so the
directory you copy into `~/.claude/skills/` does not reach back into this repository.
`python3 ../skill/build.py` checks that by importing it with the repo off `sys.path`,
and reports how far the snapshot has drifted.

## Gates

`gate_cli.py check` refuses a draft whose numbers do not trace to a recorded run. On
this project's first end-to-end run it caught a draft reporting "17 discordant pairs",
a figure derived mentally from 10 + 7 and present in no ledger; it passed only after
the analysis script printed `n_discordant` and was rerun.

It also refuses a perception loop where images were rendered and requested but never
ingested. What it checks is that numbers came from a run, not that a number was
attached to the right quantity: writing "accuracy 0.947" when 0.947 is a cosine
similarity still passes.

The CLI edition in `cli/skills/omnisci` is a different build. See
[`docs/DEVELOPMENT.md`](../docs/DEVELOPMENT.md).
