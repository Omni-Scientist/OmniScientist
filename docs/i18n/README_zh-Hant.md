<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../assets/title-dark.png">
  <img src="../../assets/title.png" width="560" alt="OmniScientist">
</picture>
<br/>

### 一個開源、全模態的 AI 科學家，可在你自己的機器上執行

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
<a href="../../README.md">English</a> · <a href="README_zh.md">简体中文</a> · <a href="README_fr.md">Français</a> · <a href="README_es.md">Español</a> · <strong>繁體中文</strong> · <a href="README_ja.md">日本語</a> · <a href="README_ko.md">한국어</a> · <a href="README_pt.md">Português</a> · <a href="README_de.md">Deutsch</a> · <a href="README_ru.md">Русский</a>
</p>

</div>

---

## 新聞

- **2026-08-24** · **多語言支援。** 工作區介面與本頁皆提供多種語言版本，列於本頁頂端，並可從應用程式中的工具列切換。 *([v0.1.3](https://github.com/Omni-Scientist/OmniScientist/releases/tag/v0.1.3))*
- **2026-08-23** · **DeepSeek 多模態支援。** `deepseek-v4-flash-vision-exp` 加入感知 sidecar，因此一個 DeepSeek 金鑰現在即可涵蓋推理與視覺。 *([v0.1.2](https://github.com/Omni-Scientist/OmniScientist/releases/tag/v0.1.2))*
- **2026-08-18** · **首次修補版本。** 發行資產帶有單一 `SHA256SUMS`，安裝程式會於安裝前加以驗證。 *([v0.1.1](https://github.com/Omni-Scientist/OmniScientist/releases/tag/v0.1.1))*
- **2026-08-16** · **首次公開發行。** 從單一程式碼庫提供桌面應用程式、終端機代理程式，以及 Claude Code 技能。 *([v0.1.0](https://github.com/Omni-Scientist/OmniScientist/releases/tag/v0.1.0))*
- **2026-08-13** · **技術報告。** [arXiv:2608.13558](https://arxiv.org/abs/2608.13558)，涵蓋十二種模態的運行。

---

<img src="../../assets/shot-paper.jpg" width="100%" alt="The compiled paper in the research log, each highlighted number linked to the run that produced it">

編譯完成的論文與實驗執行軌跡並列，每個高亮的數字皆可解析至產生它的執行。

<img src="../../assets/shot-mol.jpg" width="100%" alt="A ball-and-stick conformer computed from the chemistry case's SMILES, in the research log">

由化學案例自身的 SMILES 計算出的球棍模型構象，在執行途中出現在研究日誌中。

<img src="../../assets/shot-ct.jpg" width="100%" alt="A 64-cubed CT volume read as a point cloud, in the research log">

以點雲形式讀取的 64³ CT 容積，旁為產生它的工具呼叫。

將 OmniScientist 指向一個資料夾與一個研究方向。它會直接檢視原始資料本身，形成假說，撰寫並執行自己的分析程式碼，讀取回傳的圖表，然後草擬一篇論文，其每個數字都可追溯至真實的執行紀錄。一次執行會以編譯好的 PDF 作結，內含圖表、表格與可解析到真實 DOI 的參考文獻。

影像、波形、音訊、視訊、點雲、軌跡、表格與公式都可以原樣輸入。

## 安裝

### 使用代理程式

將此內容貼到 **Claude Code**、**Cursor**、**Codex** 或任何具有 shell 的工具中。

更多詳情請參閱 [omniscientist.github.io](https://omni-scientist.github.io/)。

```text
Read https://omni-scientist.github.io/setup/install.md and install the OmniScientist desktop app on this machine, following the steps.
```

### 下載

| | macOS | Linux | Windows |
|---|---|---|---|
| **Desktop app** | [arm64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/OmniScientist-macos-arm64.tar.gz) | [x86_64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/OmniScientist-linux-x86_64.tar.gz) · [arm64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/OmniScientist-linux-arm64.tar.gz) | [x64](https://github.com/Omni-Scientist/OmniScientist/releases/latest) |
| **Terminal agent** | [arm64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-darwin-arm64) | [x86_64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-linux-x86_64) · [arm64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-linux-arm64) | [x64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-windows-x86_64.exe) |
| **Claude Code skill** | [omnisci-skill.zip](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-skill.zip) | [omnisci-skill.zip](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-skill.zip) | [omnisci-skill.zip](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-skill.zip) |

終端機代理程式也可以一行指令安裝。在 macOS 和 Linux 上使用 `curl -fsSL https://raw.githubusercontent.com/Omni-Scientist/OmniScientist/main/install.sh | sh`，在 Windows 上使用 `irm https://raw.githubusercontent.com/Omni-Scientist/OmniScientist/main/install.ps1 | iex`。

## 工作區

每個階段都會串流到歷程記錄中，而每個產物一旦產生就會進入研究日誌。這涵蓋了 matplotlib 的輸出、繪製該輸出的腳本、其背後的資料表，以及最後編譯完成的論文。

工作區是一個本機網頁應用程式。上方截圖中的網址列顯示 `127.0.0.1`，因為那就是整個部署。在手機上，版面會收合為單欄。關閉分頁後，系統會先給 30 秒寬限期，然後才停止執行；因此重新整理頁面就能讓它繼續執行。

介面在首次啟動時會採用瀏覽器的語言，並可從工具列切換；支援英文、簡體中文、繁體中文、法文、西班牙文、日文、韓文、葡萄牙文、德文和俄文。

## 來源

草稿中的每個數字都帶有一個連結，連回產生該數字的執行。閘門讀取的是執行記錄而非草稿，一旦每個數字都曾出現在某次執行的 `stdout` 中，便允許草稿通過。空結果會導回重新發想。引用會即時對 OpenAlex 和 Crossref 解析，因此每一筆引用都帶有真實的 DOI。

## 設定

認證資訊存放在 `~/.omnisci/env`，每行一個 `KEY=VALUE`；在 Windows 上則位於 `%USERPROFILE%\.omnisci\env`。

```
DEEPSEEK_API_KEY=...
ANTHROPIC_API_KEY=...
```

該檔案會嚴格地作為資料來解析。這些值會在啟動時從環境中移除，因此不會進入代理程式撰寫的分析程式碼。

兩個模型各司其職。骨幹模型負責推理與撰寫。感知 sidecar 負責讀取像素，並在證據是影像、波形、影片或點雲時接手處理。

| Edition | Backbone | Perception sidecar |
|---|---|---|
| desktop, terminal | `deepseek-v4-flash`, or any OpenAI-compatible endpoint via `OMNISCI_BASE_URL` / `OMNISCI_API_KEY` / `OMNISCI_MODEL` | `claude-sonnet-5` by default, `deepseek-v4-flash-vision-exp` on the same DeepSeek key, changed with `OMNISCI_VISION_PROVIDER` / `OMNISCI_VISION_MODEL` |
| engine | any, selected by `OMNIST_MODEL`, covering OpenAI, Anthropic, OpenRouter, a local vLLM or sglang server, or your own gateway | `OMNIST_PERCEIVER` |

在桌面版中，兩者皆從設定對話方塊中設定，該對話方塊在回應過一次即時請求後便會儲存設定。傳輸方式由模型名稱決定，因此您需提供自己的 URL 和金鑰。完整表格位於 [`docs/USAGE.md`](../USAGE.md)。

對外流量可分為三類。第一類是您自己的模型端點。第二類是每天一次向 GitHub 進行的版本檢查，`OMNISCI_UPDATE_CHECK=off` 會將其關閉。第三類是當您要求桌面版應用程式安裝其相依套件時發生，此時會連到 PyPI 與 tectonic 的釋出頁面。

## 從原始碼建置

需要 [Bun](https://bun.sh) 1.3 或更新版本。

```bash
cd cli
bun install
bun run tools/gen-skill-assets.ts    # embed the skill, then it is one file
bun run build                        # -> dist/omnisci

cd ../desktop
bun install
bun run build:desktop                # -> dist-desktop/omnisci-desktop
```

桌面啟動器是純 TypeScript，使用 `--target` 進行交叉編譯。CLI 則是在其執行的平台上建置，因為它會引入用於公式渲染的原生模組，而交叉建置的二進位檔會帶有錯誤架構的副本，這會在首次渲染公式時顯現出來。CI 會在各自的平台上建置每個 CLI 產物。

## 測試

```bash
python3 scripts/scan_leaks.py        # scan for personal data
python3 scripts/check_parity.py      # engine, both skills and the desktop agree
python3 skill/build.py               # the skill is still self-contained

cd cli      && bun run typecheck && bun test
cd desktop  && bun run build:assets && bun run typecheck && bun test gateway launcher && bun run test:e2e
```

CI 會在每次推送時執行上述所有測試，以及對編譯後的啟動器進行實際冒煙測試。建立標籤 `v*` 會建置並發布釋出成品。

## 儲存庫結構

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

關於兩種技能版本、產生的檔案與各平台建置的說明，請見 [`docs/DEVELOPMENT.md`](../DEVELOPMENT.md)。

## 狀態

早期階段的軟體，版本 `0.1.2`。介面仍在變動，發行版本可能更改它們。

| Platform | Terminal agent | Desktop |
|---|---|---|
| macOS arm64 | released | released |
| Linux x86_64 | released | released |
| Linux arm64 | released | released |
| Windows x64 | released | released |

在 macOS 15.7.7 / M3 上，桌面應用程式已透過安裝、啟動、選單列、結束、重新啟動、單一實例、loopback 綁定與簽章驗證；清單上的下一項則是在 macOS 上進行端到端的論文執行。Windows 的建置由 CI 產生且能成功編譯，所需的程式碼路徑皆已為其撰寫。目前仍缺少來自真實 Windows 機器的報告。Intel Mac 可從原始碼建置，請參閱 [從原始碼建置](#build-from-source)。

發行資產列於單一的 `SHA256SUMS` 中，`install.sh` 和 `install.ps1` 會在安裝前予以檢查。

## 範例論文

五篇由單次執行端對端撰寫的論文位於 [`papers/`](../../papers/)，並附有它們獲得的同儕審查分數。其中一個實際範例是帶有「noise」標籤的 STEAD 地震波形。該代理程式讀取三分量波形，在標記為 noise 的集合中找出同調波至，並以自行產生的替代虛無分布加以檢定。

```bash
git clone https://github.com/Omni-Scientist/OmniScientist.git && cd OmniScientist
python -m venv .venv && source .venv/bin/activate && pip install -r engine/requirements.txt
export OMNIST_MODEL=claude-sonnet-5 ANTHROPIC_API_KEY=sk-ant-...
python engine/omniscientist/agentic.py --task stead_seismic --stage run
```

`engine/` 是技術報告所述的參考實作，也是適合用於可腳本化、可重現執行的版本。`OMNIST_MODEL` 負責選擇主幹，傳輸方式則顧名思義；因此你需自備端點與金鑰。

最後產出的論文 [Coherent polarized signals in a substantial fraction of noise-labeled STEAD traces](../../papers/seismology_stead_noise.pdf) 報告指出，在取樣且標記為 noise 的波形中，有 21.7% 在 1% 的誤警率下帶有真實訊號。

## 貢獻

歡迎提交 Issue 與 Pull Request。來自 Windows 與 Intel Mac 的回報特別有幫助。在開啟 PR 之前，請執行 [Tests](#tests) 下列出的檢查，也就是 CI 所執行的檢查。新增一個學科需要一個 `series.json` 放在 `engine/examples/` 下，說明見 [`docs/USAGE.md`](../USAGE.md)。

## 引用

本軟體的技術報告位於 [arXiv](https://arxiv.org/abs/2608.13558)。

```bibtex
@article{omniscientist2026,
  title   = {OmniScientist: An Omni-Modal Omni-Discipline AI Scientist},
  author  = {Li, Bobo and Fei, Hao and Ju, Tianjie and Lee, Mong-Li and Hsu, Wynne},  % scan-leaks: allow
  journal = {arXiv preprint arXiv:2608.13558},
  year    = {2026}
}
```

此頁面的論文版本（含作者與所屬機構）位於 [`README_paper.md`](../README_paper.md)。

## 授權

[MIT](../../LICENSE)。
