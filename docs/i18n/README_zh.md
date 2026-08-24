<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../assets/title-dark.png">
  <img src="../../assets/title.png" width="560" alt="OmniScientist">
</picture>
<br/>

### 开源的全模态 AI 科学家，在本地运行

<p align="center">
<a href="https://github.com/Omni-Scientist/OmniScientist/releases/latest"><img src="https://img.shields.io/github/v/release/Omni-Scientist/OmniScientist?style=flat-square&label=release&color=black&logo=github" alt="Release"/></a>
<a href="https://github.com/Omni-Scientist/OmniScientist/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Omni-Scientist/OmniScientist/ci.yml?branch=main&style=flat-square&label=CI" alt="CI"/></a>
<a href="../INSTALL.md"><img src="https://img.shields.io/badge/docs-install%20%26%20usage-blue?style=flat-square&logo=readthedocs&logoColor=white" alt="Docs"/></a>
<a href="https://omni-scientist.github.io/"><img src="https://img.shields.io/badge/website-omni--scientist.github.io-informational?style=flat-square&logo=googlechrome&logoColor=white" alt="Website"/></a>
<a href="../../LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License"/></a>
</p>

<p align="center">
<img src="https://img.shields.io/badge/macOS-000000?style=flat-square&labelColor=333&logo=apple&logoColor=white" alt="macOS"/>
<img src="https://img.shields.io/badge/Linux-333333?style=flat-square&labelColor=333&logo=linux&logoColor=FCC624" alt="Linux"/>
<img src="https://img.shields.io/badge/Windows-0078D4?style=flat-square&labelColor=333&logo=windows&logoColor=white" alt="Windows"/>
<a href="https://www.python.org/downloads/"><img src="https://img.shields.io/badge/Python-3.10+-3776AB?style=flat-square&labelColor=333&logo=python&logoColor=FFD43B" alt="Python"/></a>
<a href="https://bun.sh/"><img src="https://img.shields.io/badge/Bun-1.3+-000000?style=flat-square&labelColor=333&logo=bun&logoColor=white" alt="Bun"/></a>
</p>

<p align="center">
<a href="../../README.md">English</a> · <strong>简体中文</strong> · <a href="README_fr.md">Français</a> · <a href="README_es.md">Español</a> · <a href="README_zh-Hant.md">繁體中文</a> · <a href="README_ja.md">日本語</a> · <a href="README_ko.md">한국어</a> · <a href="README_pt.md">Português</a> · <a href="README_de.md">Deutsch</a> · <a href="README_ru.md">Русский</a>
</p>

</div>

---

https://github.com/user-attachments/assets/02477c18-28ff-4aad-a6bd-b54c6f032bc8

## 动态

- **2026-08-24** · **多语言支持。** 工作台界面和本页面都有多种语言，页面顶部可切换，软件里在工具栏切换。*([v0.1.3](https://github.com/Omni-Scientist/OmniScientist/releases/tag/v0.1.3))*
- **2026-08-23** · **接入 DeepSeek 多模态。** `deepseek-v4-flash-vision-exp` 加入感知侧车，一个 DeepSeek key 同时管推理和看图。*([v0.1.2](https://github.com/Omni-Scientist/OmniScientist/releases/tag/v0.1.2))*
- **2026-08-18** · **首个补丁版本。** release 产物统一到一个 `SHA256SUMS`，安装脚本装之前会核对。*([v0.1.1](https://github.com/Omni-Scientist/OmniScientist/releases/tag/v0.1.1))*
- **2026-08-16** · **首次公开发布。** 桌面版、终端版和 Claude Code skill，同一套代码。*([v0.1.0](https://github.com/Omni-Scientist/OmniScientist/releases/tag/v0.1.0))*
- **2026-08-13** · **技术报告。** [arXiv:2608.13558](https://arxiv.org/abs/2608.13558)，覆盖十二种模态的真实运行。

---

<img src="../../assets/shot-paper.jpg" width="100%" alt="研究记录里编译好的论文，高亮的数字各自连着产生它的那次运行">

编译好的论文和实验轨迹并排，高亮的数字各自指回产生它的那次运行。

<img src="../../assets/shot-mol.jpg" width="100%" alt="由化学案例 SMILES 算出的球棍模型三维构象，落在研究记录里">

由化学案例自带 SMILES 算出的三维构象，运行中途落进研究记录。

<img src="../../assets/shot-ct.jpg" width="100%" alt="以点云读出的 64³ CT 体数据，落在研究记录里">

影像案例的 64³ CT 体数据，以点云读出，旁边是产生它的工具调用。

OmniScientist 接受一个数据目录和一句研究方向，直接读取原始数据，提出假设，编写并运行分析代码，读回生成的图，最后写成一篇论文。稿件里的每个数字都能追溯到产生它的那次运行。

一轮运行的终点是一份编译好的 PDF，含图、表和参考文献，引用可解析到真实 DOI。

图像、波形、音频、视频、点云、轨迹、表格和公式都按原样读取。

## 安装

### 用 agent 安装

把下面这段贴进 **Claude Code**、**Cursor**、**Codex** 或任何带 shell 的工具，它会读取安装文档并完成安装。

更多说明见 [omniscientist.github.io](https://omni-scientist.github.io/)。

```text
Read https://omni-scientist.github.io/setup/install.md and install the OmniScientist desktop app on this machine, following the steps.
```

### 下载

| | macOS | Linux | Windows |
|---|---|---|---|
| **桌面版** | [arm64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/OmniScientist-macos-arm64.tar.gz) | [x86_64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/OmniScientist-linux-x86_64.tar.gz) · [arm64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/OmniScientist-linux-arm64.tar.gz) | [x64](https://github.com/Omni-Scientist/OmniScientist/releases/latest) |
| **终端版** | [arm64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-darwin-arm64) | [x86_64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-linux-x86_64) · [arm64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-linux-arm64) | [x64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-windows-x86_64.exe) |
| **Claude Code skill** | [omnisci-skill.zip](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-skill.zip) | [omnisci-skill.zip](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-skill.zip) | [omnisci-skill.zip](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-skill.zip) |

终端版也可以用一条命令安装。macOS 和 Linux 用 `curl -fsSL https://raw.githubusercontent.com/Omni-Scientist/OmniScientist/main/install.sh | sh`，Windows 用 `irm https://raw.githubusercontent.com/Omni-Scientist/OmniScientist/main/install.ps1 | iex`。

## 工作台

每个阶段边运行边输出。产出的东西按顺序落进右侧的研究记录，包括 matplotlib 生成的图、生成它的那段脚本、图背后的数据表，以及最后编译好的论文。

工作台是一个本地网页。上面截图里地址栏的 `127.0.0.1` 就是全部部署。窄屏下自动收成单栏。关闭标签页 30 秒后才停止本轮运行，刷新页面不受影响。

界面语言首次启动时跟随浏览器，之后在工具栏切换，有简体中文、繁體中文、English、Français、Español、日本語、한국어、Português、Deutsch、Русский 十种。

## 溯源

稿件中的每个数字都带有回链，指向产生它的那次运行。

放行由一道闸完成，它读取的是执行记录而非稿件。稿件里出现的数字必须在某次运行的 `stdout` 中出现过才能通过。实验结果为空时退回选题阶段重做。参考文献实时查询 OpenAlex 和 Crossref，每条都带真实 DOI。

## 配置

凭据写在 `~/.omnisci/env`，一行一个 `KEY=VALUE`，Windows 上是 `%USERPROFILE%\.omnisci\env`。

```
DEEPSEEK_API_KEY=...
ANTHROPIC_API_KEY=...
```

该文件只按数据解析。启动时这些值会从环境变量中移除，agent 后续编写的分析代码读到的环境是干净的。

两个模型分担两件事。主干负责推理和写作，感知模型负责读取像素，证据为图像、波形、视频或点云时由它处理。

| 版本 | 主干 | 感知模型 |
|---|---|---|
| 桌面版、终端版 | `deepseek-v4-flash`，也可用 `OMNISCI_BASE_URL` / `OMNISCI_API_KEY` / `OMNISCI_MODEL` 指向任意 OpenAI 兼容接口 | 默认 `claude-sonnet-5`，`deepseek-v4-flash-vision-exp` 用同一个 DeepSeek key，`OMNISCI_VISION_PROVIDER` / `OMNISCI_VISION_MODEL` 更换 |
| engine | 任意，由 `OMNIST_MODEL` 决定，支持 OpenAI、Anthropic、OpenRouter、本地 vLLM 或 sglang，以及自建网关 | `OMNIST_PERCEIVER` |

桌面版在设置面板中配置这两个模型。一套配置需要真实发出一次请求并得到回应才能保存。传输方式由模型名决定，地址和 key 由使用者提供。完整对照表见 [`docs/USAGE.md`](../USAGE.md)。

对外请求共三类。第一类是你自己的模型接口。第二类是每天一次的版本检查，目标是 GitHub，`OMNISCI_UPDATE_CHECK=off` 可以关闭。第三类发生在桌面版安装依赖时，目标是 PyPI 和 tectonic 的发布页。

## 从源码构建

需要 [Bun](https://bun.sh) 1.3 或更新版本。

```bash
cd cli
bun install
bun run tools/gen-skill-assets.ts    # 把 skill 打进去，之后是单文件
bun run build                        # -> dist/omnisci

cd ../desktop
bun install
bun run build:desktop                # -> dist-desktop/omnisci-desktop
```

桌面启动器是纯 TypeScript，可以用 `--target` 交叉编译。CLI 需要在目标平台上构建，它依赖一个渲染公式的原生模块，交叉编译产物里带的是其他架构的副本，直到第一次渲染公式才会暴露。CI 中每个 CLI 产物都在各自平台上构建。

## 测试

```bash
python3 scripts/scan_leaks.py        # 扫个人信息
python3 scripts/check_parity.py      # engine、两份 skill 和桌面版是否对齐
python3 skill/build.py               # skill 是否仍然自包含

cd cli      && bun run typecheck && bun test
cd desktop  && bun run build:assets && bun run typecheck && bun test gateway launcher && bun run test:e2e
```

每次 push，CI 跑完上述全部检查，并对编译出的启动器做一次真实冒烟测试。打 `v*` 标签会构建并发布 release 产物。

## 仓库结构

```
OmniScientist/
├── engine/            参考引擎和评测框架
│   ├── omniscientist/     扁平的自包含模块
│   ├── examples/          案例定义，以及七个带真实数据的小样例
│   ├── datasets/          数据来源和划分清单
│   └── scripts/data.py    公开数据的列出、下载和校验
├── skill/             Claude Code 版，自包含
├── cli/               终端版，TypeScript 编写，用 Bun 编译
│   └── skills/omnisci/    它自己那一份 skill
├── desktop/           浏览器工作台、网关和启动器
│   ├── launcher/          单可执行文件，含静态资源、网关和浏览器拉起
│   └── packaging/         macos、linux、windows 的打包
├── papers/            引擎写出的样例论文，附评分
├── docs/              安装、用法、数据集、开发
├── scripts/           仓库卫生检查
├── install.sh         macOS 和 Linux 上一条命令安装终端版
└── install.ps1        Windows 上的同一件事
```

两份 skill 的差异、生成文件的处理方式，以及分平台构建的原因，见 [`docs/DEVELOPMENT.md`](../DEVELOPMENT.md)。

## 状态

早期版本，当前 `0.1.2`。接口仍在调整，版本之间可能变化。

| 平台 | 终端版 | 桌面版 |
|---|---|---|
| macOS arm64 | 已发布 | 已发布 |
| Linux x86_64 | 已发布 | 已发布 |
| Linux arm64 | 已发布 | 已发布 |
| Windows x64 | 已发布 | 已发布 |

桌面版在 macOS 15.7.7 / M3 上验证过安装、启动、菜单栏、退出、重启、单实例、回环绑定和签名，端到端跑出一篇论文是下一项。Windows 的两个包由 CI 构建并通过编译，相关代码路径也是为它写的，还缺一份来自真实 Windows 机器的运行反馈。Intel Mac 从源码构建，见[从源码构建](#从源码构建)。

release 中所有产物的校验和集中在一个 `SHA256SUMS` 里，`install.sh` 和 `install.ps1` 安装前会核对。

## 样例论文

[`papers/`](../../papers/) 收录五篇论文，均由单次运行写成，并附评审打分。

一个实际例子是 STEAD 中标记为 noise 的地震记录。系统读取三分量波形，在这批记录里找出相干到时，再用自行生成的替代零分布做检验。

```bash
git clone https://github.com/Omni-Scientist/OmniScientist.git && cd OmniScientist
python -m venv .venv && source .venv/bin/activate && pip install -r engine/requirements.txt
export OMNIST_MODEL=claude-sonnet-5 ANTHROPIC_API_KEY=sk-ant-...
python engine/omniscientist/agentic.py --task stead_seismic --stage run
```

`engine/` 是技术报告描述的参考实现，用于脚本化和可复现的运行。`OMNIST_MODEL` 决定主干模型，传输方式随模型名自动确定，地址和 key 由使用者提供。

产出的论文是 [Coherent polarized signals in a substantial fraction of noise-labeled STEAD traces](../../papers/seismology_stead_noise.pdf)，结论是在 1% 虚警率下，抽样的 noise 记录中有 21.7% 携带真实信号。

## 参与

欢迎提交 issue 和 PR。来自 Windows 和 Intel Mac 的运行反馈尤其有用。提交 PR 前请跑一遍[测试](#测试)一节列出的检查，CI 使用同一套。新增一个学科只需在 `engine/examples/` 下写一个 `series.json`，写法见 [`docs/USAGE.md`](../USAGE.md)。

## 引用

本软件对应的技术报告发表在 [arXiv](https://arxiv.org/abs/2608.13558)。

```bibtex
@article{omniscientist2026,
  title   = {OmniScientist: An Omni-Modal Omni-Discipline AI Scientist},
  author  = {Li, Bobo and Fei, Hao and Ju, Tianjie and Lee, Mong-Li and Hsu, Wynne},  % scan-leaks: allow
  journal = {arXiv preprint arXiv:2608.13558},
  year    = {2026}
}
```

带作者和单位的版本见 [`README_paper.md`](../README_paper.md)。

## 许可

[MIT](../../LICENSE)。
