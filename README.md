<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/title-dark.png">
  <img src="assets/title.png" width="560" alt="OmniScientist">
</picture>
<br/>

### An open, omni-modal AI scientist that runs on your own machine

<p align="center">
<a href="https://github.com/Omni-Scientist/OmniScientist/releases/latest"><img src="https://img.shields.io/github/v/release/Omni-Scientist/OmniScientist?style=flat-square&label=release&color=black&logo=github" alt="Release"/></a>
<a href="https://github.com/Omni-Scientist/OmniScientist/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Omni-Scientist/OmniScientist/ci.yml?branch=main&style=flat-square&label=CI" alt="CI"/></a>
<a href="docs/INSTALL.md"><img src="https://img.shields.io/badge/docs-install%20%26%20usage-blue?style=flat-square&logo=readthedocs&logoColor=white" alt="Docs"/></a>
<a href="https://omni-scientist.github.io/"><img src="https://img.shields.io/badge/website-omni--scientist.github.io-informational?style=flat-square&logo=googlechrome&logoColor=white" alt="Website"/></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License"/></a>
</p>

<p align="center">
<img src="https://img.shields.io/badge/macOS-000000?style=flat-square&labelColor=333&logo=apple&logoColor=white" alt="macOS"/>
<img src="https://img.shields.io/badge/Linux-333333?style=flat-square&labelColor=333&logo=linux&logoColor=FCC624" alt="Linux"/>
<img src="https://img.shields.io/badge/Windows-0078D4?style=flat-square&labelColor=333&logo=windows&logoColor=white" alt="Windows"/>
<a href="https://www.python.org/downloads/"><img src="https://img.shields.io/badge/Python-3.10+-3776AB?style=flat-square&labelColor=333&logo=python&logoColor=FFD43B" alt="Python"/></a>
<a href="https://bun.sh/"><img src="https://img.shields.io/badge/Bun-1.3+-000000?style=flat-square&labelColor=333&logo=bun&logoColor=white" alt="Bun"/></a>
</p>

<p align="center">
<strong>English</strong> · <a href="README_zh.md">简体中文</a>
</p>

</div>

<img src="assets/shot-paper.jpg" width="100%" alt="The compiled paper in the research log, each highlighted number linked to the run that produced it">

The compiled paper beside the experiment trace, every highlighted number resolving to the run that produced it.

<img src="assets/shot-mol.jpg" width="100%" alt="A ball-and-stick conformer computed from the chemistry case's SMILES, in the research log">

A ball-and-stick conformer computed from the chemistry case's own SMILES, arriving in the research log mid-run.

<img src="assets/shot-ct.jpg" width="100%" alt="A 64-cubed CT volume read as a point cloud, in the research log">

A 64³ CT volume read as a point cloud, beside the tool calls that produced it.

Point OmniScientist at a folder of data and a research direction. It looks at the raw material itself, forms a hypothesis, writes and runs its own analysis code, reads the figures that come back, and drafts a paper whose every number traces to a real execution record. A run ends at a compiled PDF with figures, tables and references that resolve to real DOIs.

Images, waveforms, audio, video, point clouds, trajectories, tables and formulas all go in as they are.

## Install

### With an agent

Paste this into **Claude Code**, **Cursor**, **Codex**, or anything else with a shell.

For more details, please refer to [omniscientist.github.io](https://omni-scientist.github.io/).

```text
Read https://omni-scientist.github.io/setup/install.md and install the OmniScientist desktop app on this machine, following the steps.
```

### Download

| | macOS | Linux | Windows |
|---|---|---|---|
| **Desktop app** | [arm64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/OmniScientist-macos-arm64.tar.gz) | [x86_64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/OmniScientist-linux-x86_64.tar.gz) · [arm64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/OmniScientist-linux-arm64.tar.gz) | [x64](https://github.com/Omni-Scientist/OmniScientist/releases/latest) |
| **Terminal agent** | [arm64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-darwin-arm64) | [x86_64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-linux-x86_64) · [arm64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-linux-arm64) | [x64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-windows-x86_64.exe) |
| **Claude Code skill** | [omnisci-skill.zip](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-skill.zip) | [omnisci-skill.zip](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-skill.zip) | [omnisci-skill.zip](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-skill.zip) |

The terminal agent also installs in one line. Use `curl -fsSL https://raw.githubusercontent.com/Omni-Scientist/OmniScientist/main/install.sh | sh` on macOS and Linux, and `irm https://raw.githubusercontent.com/Omni-Scientist/OmniScientist/main/install.ps1 | iex` on Windows.

## The workspace

Each stage streams into the transcript, and every artifact lands in the research log the moment it exists. That covers the matplotlib output, the script that drew it, the data table behind it, and at the end the compiled paper.

The workspace is a local web app. The address bar in the screenshots above reads `127.0.0.1` because that is the entire deployment. The layout collapses to one column on a phone. Closing the tab stops the run after a 30-second grace period, so a page refresh keeps it alive.

## Provenance

Every number in the draft carries a link back to the run that produced it. A gate reads the execution record rather than the draft, and admits the draft once each of those numbers has appeared in some run's `stdout`. A null result routes back to re-ideation. Citations are resolved live against OpenAlex and Crossref, so each one carries a real DOI.

## Configuration

Credentials live in `~/.omnisci/env`, one `KEY=VALUE` per line, and in `%USERPROFILE%\.omnisci\env` on Windows.

```
DEEPSEEK_API_KEY=...
ANTHROPIC_API_KEY=...
```

The file is parsed strictly as data. The values are removed from the environment at startup, so they stay out of the analysis code the agent writes.

Two models do two jobs. The backbone reasons and writes. A perception sidecar reads the pixels, and takes over whenever the evidence is an image, a waveform, a video or a point cloud.

| Edition | Backbone | Perception sidecar |
|---|---|---|
| desktop, terminal | `deepseek-v4-flash`, or any OpenAI-compatible endpoint via `OMNISCI_BASE_URL` / `OMNISCI_API_KEY` / `OMNISCI_MODEL` | `claude-sonnet-5` by default, `deepseek-v4-flash-vision-exp` on the same DeepSeek key, changed with `OMNISCI_VISION_PROVIDER` / `OMNISCI_VISION_MODEL` |
| engine | any, selected by `OMNIST_MODEL`, covering OpenAI, Anthropic, OpenRouter, a local vLLM or sglang server, or your own gateway | `OMNIST_PERCEIVER` |

In the desktop edition both are set from the settings dialog, which saves a configuration once it has answered a live request. The transport follows from the model name, so you supply your own URL and key. The full table is in [`docs/USAGE.md`](docs/USAGE.md).

Outbound traffic falls into three kinds. The first is your own model endpoint. The second is a once-a-day release check against GitHub, which `OMNISCI_UPDATE_CHECK=off` turns off. The third happens when you ask the desktop app to install its dependencies, and reaches PyPI and the tectonic release page.

## Build from source

Needs [Bun](https://bun.sh) 1.3 or newer.

```bash
cd cli
bun install
bun run tools/gen-skill-assets.ts    # embed the skill, then it is one file
bun run build                        # -> dist/omnisci

cd ../desktop
bun install
bun run build:desktop                # -> dist-desktop/omnisci-desktop
```

The desktop launcher is pure TypeScript and cross-compiles with `--target`. The CLI is built on the platform it runs on, because it pulls a native module for formula rendering and a cross-built binary carries the wrong architecture's copy, which surfaces the first time a formula is rendered. CI builds every CLI artifact on its own platform.

## Tests

```bash
python3 scripts/scan_leaks.py        # scan for personal data
python3 scripts/check_parity.py      # engine, both skills and the desktop agree
python3 skill/build.py               # the skill is still self-contained

cd cli      && bun run typecheck && bun test
cd desktop  && bun run build:assets && bun run typecheck && bun test gateway && bun run test:e2e
```

CI runs all of the above plus a live smoke test of the compiled launcher on every push. Tagging `v*` builds and publishes the release artifacts.

## Repository layout

```
OmniScientist/
├── engine/            the reference engine and evaluation harness
│   ├── omniscientist/     flat, self-contained modules
│   ├── examples/          case specifications and seven small real-data demos
│   ├── datasets/          provenance and split manifest
│   └── scripts/data.py    list, fetch and verify public research data
├── skill/             the Claude Code edition, self-contained
├── cli/               the terminal agent (TypeScript, compiled with Bun)
│   └── skills/omnisci/    its own edition of the skill
├── desktop/           the browser workspace, its gateway and the launcher
│   ├── launcher/          the single executable: static assets, gateway, browser
│   └── packaging/         macos, linux and windows
├── papers/            sample papers the engine wrote, with their scores
├── docs/              installation, usage, datasets, development
├── scripts/           repository hygiene
├── install.sh         one-command CLI install for macOS and Linux
└── install.ps1        the same for Windows
```

Notes on the two skill editions, the generated files and the per-platform build are in [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

## Status

Early software, version `0.1.1`. Interfaces are still moving and releases can change them.

| Platform | Terminal agent | Desktop |
|---|---|---|
| macOS arm64 | released | released |
| Linux x86_64 | released | released |
| Linux arm64 | released | released |
| Windows x64 | released | released |

On macOS the desktop app is verified through install, launch, menu bar, quit, relaunch, single instance, loopback binding and signature, on 15.7.7 / M3, and an end-to-end paper run on macOS is next on that list. The Windows builds come from CI and compile, and the code paths they need are written for them. What is still missing is a report from a real Windows machine. Intel Macs build from source, see [Build from source](#build-from-source).

Release assets are listed in a single `SHA256SUMS`, which `install.sh` and `install.ps1` check before installing.

## Sample papers

Five papers written end to end by a single run are in [`papers/`](papers/), with the peer-review scores they were given. One worked example is the STEAD seismic traces carrying a "noise" label. The agent read the three-component waveforms, found coherent arrivals inside the noise-labeled set, and tested them against a surrogate null distribution it generated itself.

```bash
git clone https://github.com/Omni-Scientist/OmniScientist.git && cd OmniScientist
python -m venv .venv && source .venv/bin/activate && pip install -r engine/requirements.txt
export OMNIST_MODEL=claude-sonnet-5 ANTHROPIC_API_KEY=sk-ant-...
python engine/omniscientist/agentic.py --task stead_seismic --stage run
```

`engine/` is the reference implementation the technical report describes, and the one to use for scriptable, reproducible runs. `OMNIST_MODEL` picks the backbone and the transport follows from the name, so you bring your own endpoint and key.

The resulting paper, [Coherent polarized signals in a substantial fraction of noise-labeled STEAD traces](papers/seismology_stead_noise.pdf), reports that 21.7% of the sampled noise-labeled traces carry real signal at a 1% false-alarm rate.

## Contributing

Issues and pull requests are welcome. Reports from Windows and Intel Macs are especially useful. Before opening a PR, run the checks under [Tests](#tests), which are the same ones CI runs. Adding a discipline takes one `series.json` under `engine/examples/`, described in [`docs/USAGE.md`](docs/USAGE.md).

## Citation

The technical report behind this software is on [arXiv](https://arxiv.org/abs/2608.13558).

```bibtex
@article{omniscientist2026,
  title   = {OmniScientist: An Omni-Modal Omni-Discipline AI Scientist},
  author  = {Li, Bobo and Fei, Hao and Ju, Tianjie and Lee, Mong-Li and Hsu, Wynne},  % scan-leaks: allow
  journal = {arXiv preprint arXiv:2608.13558},
  year    = {2026}
}
```

The paper-facing version of this page, with authors and affiliations, is [`README_paper.md`](README_paper.md).

## License

[MIT](LICENSE).
