<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../assets/title-dark.png">
  <img src="../../assets/title.png" width="560" alt="OmniScientist">
</picture>
<br/>

### 自分のマシンで動く、オープンでオムニモーダルなAI科学者

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
<a href="../../README.md">English</a> · <a href="README_zh.md">简体中文</a> · <a href="README_fr.md">Français</a> · <a href="README_es.md">Español</a> · <a href="README_zh-Hant.md">繁體中文</a> · <strong>日本語</strong> · <a href="README_ko.md">한국어</a> · <a href="README_pt.md">Português</a> · <a href="README_de.md">Deutsch</a> · <a href="README_ru.md">Русский</a>
</p>

</div>

---

https://github.com/user-attachments/assets/02477c18-28ff-4aad-a6bd-b54c6f032bc8

## News

- 🚀 **2026-09-02** · **v0.2.1 リリース。** 一新されたデスクトップ版をどうぞ。 *([v0.2.1](https://github.com/Omni-Scientist/OmniScientist/releases/tag/v0.2.1))*
- 📚 **2026-09-02** · **Awesome AI Scientist。** AI scientist 向けのコレクション [Omni-Scientist/Awesome-AI-Scientist](https://github.com/Omni-Scientist/Awesome-AI-Scientist) を公開しました。論文、システム、ワークベンチ、ベンチマーク、データセットを収録しています。
- 🌍 **2026-08-24** · **多言語対応。** ワークスペースのインターフェースとこのページはともに多言語で利用でき、このページの上部に一覧表示され、アプリのツールバーから切り替えられます。 *([v0.1.3](https://github.com/Omni-Scientist/OmniScientist/releases/tag/v0.1.3))*
- 👁️ **2026-08-23** · **DeepSeekマルチモーダル対応。** `deepseek-v4-flash-vision-exp`が知覚サイドカーに加わり、DeepSeekキー1つで推論と視覚の両方をカバーできるようになりました。 *([v0.1.2](https://github.com/Omni-Scientist/OmniScientist/releases/tag/v0.1.2))*
- 🔐 **2026-08-18** · **初のパッチリリース。** リリースアセットには単一の`SHA256SUMS`が同梱され、インストーラはインストール前にそれを検証します。 *([v0.1.1](https://github.com/Omni-Scientist/OmniScientist/releases/tag/v0.1.1))*
- 🎉 **2026-08-16** · **初の公開リリース。** 単一のコードベースに基づくデスクトップアプリ、ターミナルエージェント、Claude Codeスキル。 *([v0.1.0](https://github.com/Omni-Scientist/OmniScientist/releases/tag/v0.1.0))*
- 📄 **2026-08-13** · **技術報告。** [arXiv:2608.13558](https://arxiv.org/abs/2608.13558)、12のモダリティにわたる実行結果を収録。

---

<img src="../../assets/shot-paper.jpg" width="100%" alt="The compiled paper in the research log, each highlighted number linked to the run that produced it">

コンパイル済みの論文が実験トレースの隣にあり、強調表示されたすべての数値は、それを生成したランに対応づけられています。

<img src="../../assets/shot-mol.jpg" width="100%" alt="A ball-and-stick conformer computed from the chemistry case's SMILES, in the research log">

化学のケース自身のSMILESから計算されたボールアンドスティック型コンフォーマーが、実行途中で研究ログに追加されます。

<img src="../../assets/shot-ct.jpg" width="100%" alt="A 64-cubed CT volume read as a point cloud, in the research log">

64³のCTボリュームを点群として読み取ったものと、それを生成したツール呼び出しを並べたものです。

データのフォルダと研究の方向性をOmniScientistに指定します。OmniScientistは生の素材そのものを調べ、仮説を立て、自身で解析コードを書いて実行し、返ってきた図を読み取り、すべての数値が実際の実行記録に遡れる論文を草稿します。実行が完了すると、図・表・参照文献が実在のDOIに解決されるコンパイル済みPDFが生成されます。

画像、波形、音声、動画、点群、軌跡、表、数式は、そのまま入力されます。

## インストール

### エージェントを使う

これを **Claude Code**、**Cursor**、**Codex**、またはシェルを備えたその他のツールに貼り付けてください。

詳細については、[omniscientist.github.io](https://omni-scientist.github.io/) を参照してください。

```text
Read https://omni-scientist.github.io/setup/install.md and install the OmniScientist desktop app on this machine, following the steps.
```

### ダウンロード

| | macOS | Linux | Windows |
|---|---|---|---|
| **Desktop app** | [Apple silicon](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/OmniSci-Desktop-macOS.zip) | [x64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/OmniSci-Desktop-Linux-x64.deb) | [x64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/OmniSci-Desktop-Windows-x64-setup.exe) |
| **Terminal agent** | [Apple silicon](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-CLI-macOS.tar.gz) | [x64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-CLI-Linux-x64.tar.gz) · [ARM64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-CLI-Linux-ARM64.tar.gz) | [x64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-CLI-Windows-x64.zip) |
| **Claude Code skill** | [omnisci-skill.zip](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-skill.zip) | [omnisci-skill.zip](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-skill.zip) | [omnisci-skill.zip](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-skill.zip) |

ターミナルエージェントも一行でインストールできます。macOS と Linux では `curl -fsSL https://raw.githubusercontent.com/Omni-Scientist/OmniScientist/main/install.sh | sh` を、Windows では `irm https://raw.githubusercontent.com/Omni-Scientist/OmniScientist/main/install.ps1 | iex` を使用してください。

## ワークスペース

各ステージはトランスクリプトにストリーミングされ、すべてのアーティファクトは生成された瞬間に研究ログに記録されます。これには、matplotlib の出力、それを描画したスクリプト、その背後にあるデータテーブル、そして最後にコンパイルされた論文が含まれます。

ワークスペースはローカル Web アプリです。上のスクリーンショットのアドレスバーには `127.0.0.1` と表示されていますが、これはデプロイメント全体がこれだけだからです。レイアウトはスマートフォンでは 1 カラムに折りたたまれます。タブを閉じると、30 秒の猶予期間の後に実行が停止します。したがって、ページをリフレッシュすれば実行は継続されます。

インターフェースは初回起動時にブラウザの言語に従い、ツールバーから切り替えられます。対応言語は、英語、簡体字中国語、繁体字中国語、フランス語、スペイン語、日本語、韓国語、ポルトガル語、ドイツ語、ロシア語です。

## 来歴

ドラフト内のすべての数値には、それを生成したランへのリンクが保持されている。ゲートはドラフトではなく実行記録を読み取り、各数値がいずれかのランの`stdout`に出現した時点でドラフトを受理する。null 結果は再発想（re-ideation）に戻される。引用は OpenAlex と Crossref に対してライブで解決されるため、各引用には実際の DOI が付与される。

## 設定

認証情報は`~/.omnisci/env`（1行に1つの`KEY=VALUE`）と、Windowsでは`%USERPROFILE%\.omnisci\env`に格納されます。

```
DEEPSEEK_API_KEY=...
ANTHROPIC_API_KEY=...
```

このファイルは厳密にデータとして解析されます。値は起動時に環境から除去されるため、エージェントが作成する分析コードには含まれません。

2つのモデルが2つの役割を担います。バックボーンは推論と記述を行います。認識サイドカーはピクセルを読み取り、証拠が画像、波形、動画、または点群である場合は常に処理を引き継ぎます。

| Edition | Backbone | Perception sidecar |
|---|---|---|
| desktop, terminal | `deepseek-v4-flash`, or any OpenAI-compatible endpoint via `OMNISCI_BASE_URL` / `OMNISCI_API_KEY` / `OMNISCI_MODEL` | `claude-sonnet-5` by default, `deepseek-v4-flash-vision-exp` on the same DeepSeek key, changed with `OMNISCI_VISION_PROVIDER` / `OMNISCI_VISION_MODEL` |
| engine | any, selected by `OMNIST_MODEL`, covering OpenAI, Anthropic, OpenRouter, a local vLLM or sglang server, or your own gateway | `OMNIST_PERCEIVER` |

デスクトップ版では、両方とも設定ダイアログから設定されます。設定ダイアログは、ライブリクエストに応答すると設定を保存します。トランスポートはモデル名から決まるため、独自のURLとキーを指定します。完全な表は[`docs/USAGE.md`](../USAGE.md)にあります。

アウトバウンドトラフィックは3種類に分類されます。1つ目は、自分自身のモデルエンドポイントです。2つ目は、GitHubに対する1日1回のリリースチェックで、`OMNISCI_UPDATE_CHECK=off`で無効にできます。3つ目は、デスクトップアプリに依存関係のインストールを依頼したときに発生し、PyPIとtectonicのリリースページにアクセスします。

## ソースからビルド

[Bun](https://bun.sh) 1.3以上が必要です。

```bash
cd cli
bun install
bun run tools/gen-skill-assets.ts    # embed the skill, then it is one file
bun run build                        # -> dist/omnisci

cd ../desktop
bun install
bun run build:desktop                # -> dist-desktop/omnisci-desktop
```

デスクトップランチャーは純粋なTypeScriptであり、`--target`でクロスコンパイルされます。CLIは実行されるプラットフォーム上でビルドされます。これは、CLIが数式レンダリング用のネイティブモジュールを取り込むためであり、クロスビルドされたバイナリには誤ったアーキテクチャのコピーが含まれ、最初に数式がレンダリングされたときにその問題が表面化します。CIはすべてのCLIアーティファクトをそれぞれのプラットフォームでビルドします。

## テスト

```bash
python3 scripts/scan_leaks.py        # scan for personal data
python3 scripts/check_parity.py      # engine, both skills and the desktop agree
python3 skill/build.py               # the skill is still self-contained

cd cli      && bun run typecheck && bun test
cd desktop  && bun run build:assets && bun run typecheck && bun test gateway launcher && bun run test:e2e
```

CIは上記すべてに加え、コンパイル済みランチャーのライブスモークテストを、プッシュのたびに実行する。タグ付け`v*`はリリースアーティファクトをビルドし、公開する。

## リポジトリ構成

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

2つのスキルエディション、生成ファイル、プラットフォーム別ビルドに関するメモは[`docs/DEVELOPMENT.md`](../DEVELOPMENT.md)にあります。

## ステータス

初期ソフトウェア、バージョン`0.1.2`。インターフェースはまだ流動的であり、リリースによって変更される可能性があります。

| Platform | Terminal agent | Desktop |
|---|---|---|
| macOS arm64 | released | released |
| Linux x86_64 | released | released |
| Linux arm64 | released | released |
| Windows x64 | released | released |

macOS 15.7.7 / M3 上で、デスクトップアプリはインストール、起動、メニューバー、終了、再起動、シングルインスタンス、ループバックバインド、署名について検証されています。次に、macOSでのエンドツーエンドの論文実行が予定されています。WindowsビルドはCIから生成され、コンパイルされます。それらが必要とするコードパスは、それら向けに記述されています。まだ欠けているのは、実際のWindowsマシンからのレポートです。Intel Macはソースからビルドできます。[ソースからのビルド](#build-from-source)を参照してください。

リリースアセットは単一の`SHA256SUMS`にリストされており、`install.sh`と`install.ps1`はインストール前にそれをチェックします。

## サンプル論文

単一の実行によってエンドツーエンドで書かれた5本の論文が、[`papers/`](../../papers/)に、付与された査読スコアとともに収められている。実例の1つは、「ノイズ」ラベルを担うSTEAD地震トレースである。エージェントは3成分波形を読み取り、ノイズとラベル付けされたセット内でコヒーレントな到着波を発見し、それらを自身で生成したサロゲート帰無分布に対して検定した。

```bash
git clone https://github.com/Omni-Scientist/OmniScientist.git && cd OmniScientist
python -m venv .venv && source .venv/bin/activate && pip install -r engine/requirements.txt
export OMNIST_MODEL=claude-sonnet-5 ANTHROPIC_API_KEY=sk-ant-...
python engine/omniscientist/agentic.py --task stead_seismic --stage run
```

`engine/`はテクニカルレポートが説明する参照実装であり、スクリプト可能で再現性のある実行に使用するものである。`OMNIST_MODEL`はバックボーンを選択し、トランスポートは名前から明らかなので、エンドポイントとキーは各自で用意すること。

その結果として得られた論文、[Coherent polarized signals in a substantial fraction of noise-labeled STEAD traces](../../papers/seismology_stead_noise.pdf)は、サンプリングされたノイズラベル付きトレースの21.7%が、1%の誤警報率で実際の信号を含むと報告している。

## コントリビューション

Issue とプルリクエストは歓迎です。Windows および Intel Mac からの報告は特に有用です。PR を開く前に、[テスト](#tests) にあるチェックを実行してください。これは CI が実行するものと同じです。分野を追加するには、`engine/examples/` の下の `series.json` が 1 つ必要です。詳細は [`docs/USAGE.md`](../USAGE.md) に記載されています。

## 引用

このソフトウェアの基盤となるテクニカルレポートは[arXiv](https://arxiv.org/abs/2608.13558)にあります。

```bibtex
@article{omniscientist2026,
  title   = {OmniScientist: An Omni-Modal Omni-Discipline AI Scientist},
  author  = {Li, Bobo and Fei, Hao and Ju, Tianjie and Lee, Mong-Li and Hsu, Wynne},  % scan-leaks: allow
  journal = {arXiv preprint arXiv:2608.13558},
  year    = {2026}
}
```

著者と所属を含む、このページの論文向けバージョンは[`README_paper.md`](../README_paper.md)です。

## ライセンス

[MIT](../../LICENSE).
