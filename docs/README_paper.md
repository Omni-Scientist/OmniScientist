<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/title-dark.png">
  <img src="../assets/title.png" width="560" alt="OmniScientist">
</picture>
<br/>

### An Omni-Modal, Omni-Discipline AI Scientist

<p align="center">
<a href="https://omni-scientist.github.io/"><img src="https://img.shields.io/badge/Project-Page-blue?style=flat-square&logo=googlechrome&logoColor=white" alt="Project Page"/></a>
<a href="#citation"><img src="https://img.shields.io/badge/Paper-Technical%20Report-red?style=flat-square&logo=arxiv&logoColor=white" alt="Paper"/></a>
<a href="https://github.com/Omni-Scientist/OmniScientist/releases"><img src="https://img.shields.io/badge/Download-Releases-black?style=flat-square&logo=github" alt="Releases"/></a>
<a href="../papers/"><img src="https://img.shields.io/badge/Sample-Papers-orange?style=flat-square&logo=readthedocs&logoColor=white" alt="Sample Papers"/></a>
<a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="License"/></a>
</p>

<p align="center">
<a href="https://www.python.org/downloads/"><img src="https://img.shields.io/badge/Python-3.10+-3776AB?style=flat-square&labelColor=333&logo=python&logoColor=FFD43B" alt="Python"/></a>
<a href="https://bun.sh/"><img src="https://img.shields.io/badge/-Bun-000000?style=flat-square&labelColor=333&logo=bun&logoColor=white" alt="Bun"/></a>
<a href="https://platform.openai.com/"><img src="https://img.shields.io/badge/-OpenAI-412991?style=flat-square&labelColor=333&logo=openai&logoColor=white" alt="OpenAI"/></a>
<a href="https://www.anthropic.com/"><img src="https://img.shields.io/badge/-Claude-D97757?style=flat-square&labelColor=333&logo=anthropic&logoColor=white" alt="Anthropic"/></a>
<a href="https://github.com/vllm-project/vllm"><img src="https://img.shields.io/badge/-vLLM-FF6F00?style=flat-square&labelColor=333&logo=lightning&logoColor=FF6F00" alt="vLLM"/></a>
</p>

<p align="center">
<strong><a href="https://libobo.site">Bobo Li</a><sup>1</sup></strong> ·<!-- scan-leaks: allow, author attribution -->
<strong><a href="https://haofei.vip/">Hao Fei</a><sup>2,*</sup></strong> ·
<strong><a href="https://jometeorie.github.io/">Tianjie Ju</a><sup>1</sup></strong> ·
<strong><a href="https://www.comp.nus.edu.sg/~leeml/">Mong-Li Lee</a><sup>1</sup></strong> ·
<strong><a href="https://www.comp.nus.edu.sg/~whsu/">Wynne Hsu</a><sup>1</sup></strong>
<br/>
<sup>1</sup>National University of Singapore &nbsp;&nbsp;
<sup>2</sup>University of Oxford
<br/>
<sup>*</sup>Correspondence
<br/><br/>
<strong>Project website: <a href="https://omni-scientist.github.io/">omni-scientist.github.io</a></strong>
</p>

<br/>

<img src="../assets/teaser.png" width="100%" alt="OmniScientist at a glance">

</div>

OmniScientist is an autonomous AI agent that conducts research by perceiving raw
scientific data directly. Current AI agents reason over text and code, meaning raw
observations like microscopy images, seismograms, galaxy cutouts, and CT volumes only
reach them after humans reduce them to tables or numbers. OmniScientist examines the
primary material itself.

Provided with a research direction and a folder of data, the system runs a loop of
observation, reasoning, and action across the research lifecycle. It forms hypotheses
from what it sees, executes its own analyses, and drafts a paper whose claims trace
directly back to those experimental runs.

## Install

Paste this into Claude Code, Cursor, Codex, or anything else with a shell.

```text
Read https://omni-scientist.github.io/setup/install.md and install and configure the OmniScientist skill for this agent, following the steps.
```

For the desktop app or the terminal agent, get the line for your machine at
**[omni-scientist.github.io](https://omni-scientist.github.io/)**.

## Workbench

The desktop edition. A run streams into the transcript on the left while the research log
on the right collects every figure, script, and the compiled paper as they appear.

<img src="../assets/workbench.png" width="100%" alt="The OmniScientist desktop workbench">

## Framework

<img src="../assets/framework.png" width="100%" alt="The OmniScientist framework">

Evidence enters as perceptual, symbolic, quantitative, or procedural data across twelve
modalities. One command runs three stages, each a tool-using loop that looks before it
acts, and each followed by a gate that must pass before the next begins.

- **Ideation** reads the evidence and forms a falsifiable hypothesis.
- **Experiment** runs code on real data and reads the resulting figures.
- **Writeup** drafts the paper, cites real literature, and compiles a PDF.

The gates are code, and they read an execution record rather than the draft. Every
number in the manuscript traces to real `stdout`, and a null result goes back to
ideation instead of being written up as a finding.

<img src="../assets/interface.png" width="100%" alt="From raw evidence to structural cues to a verified finding">

## Demos

A run ends at a compiled PDF containing figures, tables, and references that resolve to real DOIs. Five sample papers are in the [papers/](../papers/) directory.

As a worked example, the agent was pointed at STEAD seismic traces that carry a "noise" label. It read the three-component waveforms, found coherent arrivals in traces that should have contained none, and tested them against a surrogate null distribution it generated itself. The command that produces it is:

```bash
python engine/omniscientist/agentic.py --task stead_seismic --stage run
```

The resulting paper is titled [Coherent polarized signals in a substantial fraction of noise-labeled STEAD traces](../papers/seismology_stead_noise.pdf). It reports that 21.7% of the sampled noise-labeled traces carry real signal, with the false-alarm rate held at 1%.

<img src="../assets/perception_gallery.png" width="100%" alt="Raw observations and the findings derived from reading them">

## Citation

```bibtex
@article{omniscientist2026,
  title   = {OmniScientist: An Omni-Modal Omni-Discipline AI Scientist},
  author  = {Li, Bobo and Fei, Hao and Ju, Tianjie and Lee, Mong-Li and Hsu, Wynne},  % scan-leaks: allow
  journal = {arXiv preprint arXiv:2608.13558},
  year    = {2026}
}
```

## License

Released under the [MIT License](../LICENSE).
