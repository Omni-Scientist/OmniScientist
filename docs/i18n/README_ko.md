<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../assets/title-dark.png">
  <img src="../../assets/title.png" width="560" alt="OmniScientist">
</picture>
<br/>

### 여러분의 컴퓨터에서 실행되는 오픈 옴니모달 AI 과학자

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
<a href="../../README.md">English</a> · <a href="README_zh.md">简体中文</a> · <a href="README_fr.md">Français</a> · <a href="README_es.md">Español</a> · <a href="README_zh-Hant.md">繁體中文</a> · <a href="README_ja.md">日本語</a> · <strong>한국어</strong> · <a href="README_pt.md">Português</a> · <a href="README_de.md">Deutsch</a> · <a href="README_ru.md">Русский</a>
</p>

</div>

---

https://github.com/user-attachments/assets/02477c18-28ff-4aad-a6bd-b54c6f032bc8

## 소식

- **2026-08-24** · **다국어 지원.** 작업 영역 인터페이스와 이 페이지 모두 여러 언어로 제공됩니다. 언어는 이 페이지 상단에 나열되어 있으며, 앱의 도구 모음에서 전환할 수 있습니다. *([v0.1.3](https://github.com/Omni-Scientist/OmniScientist/releases/tag/v0.1.3))*
- **2026-08-23** · **DeepSeek 멀티모달 지원.** `deepseek-v4-flash-vision-exp`가 지각 사이드카에 합류하여, 이제 DeepSeek 키 하나로 추론과 비전을 모두 처리할 수 있습니다. *([v0.1.2](https://github.com/Omni-Scientist/OmniScientist/releases/tag/v0.1.2))*
- **2026-08-18** · **첫 패치 릴리스.** 릴리스 자산에 `SHA256SUMS` 하나가 포함되며, 설치 프로그램은 설치 전에 이를 검증합니다. *([v0.1.1](https://github.com/Omni-Scientist/OmniScientist/releases/tag/v0.1.1))*
- **2026-08-16** · **첫 공개 릴리스.** 데스크톱 앱, 터미널 에이전트, Claude Code 스킬을 하나의 코드베이스에서 제공합니다. *([v0.1.0](https://github.com/Omni-Scientist/OmniScientist/releases/tag/v0.1.0))*
- **2026-08-13** · **기술 보고서.** [arXiv:2608.13558](https://arxiv.org/abs/2608.13558), 12개 모달리티에 걸친 실행 결과를 포함합니다.

---

<img src="../../assets/shot-paper.jpg" width="100%" alt="The compiled paper in the research log, each highlighted number linked to the run that produced it">

실험 추적 기록 옆에 놓인 컴파일된 논문. 강조된 모든 숫자는 그 숫자를 생성한 실행으로 연결된다.

<img src="../../assets/shot-mol.jpg" width="100%" alt="A ball-and-stick conformer computed from the chemistry case's SMILES, in the research log">

화학 사례 자체의 SMILES로 계산된 구-막대 컨포머가 실행 중간에 연구 로그로 들어온다.

<img src="../../assets/shot-ct.jpg" width="100%" alt="A 64-cubed CT volume read as a point cloud, in the research log">

64³ CT 볼륨을 포인트 클라우드로 읽은 모습과, 그것을 생성한 도구 호출들.

OmniScientist를 데이터 폴더와 연구 방향에 지정하세요. OmniScientist는 원자료 자체를 살펴보고, 가설을 세우고, 자체 분석 코드를 작성하고 실행하며, 돌아온 그림을 읽고, 모든 숫자가 실제 실행 기록으로 추적 가능한 논문을 작성합니다. 실행이 끝나면 그림, 표, 실제 DOI로 연결되는 참고문헌이 포함된 컴파일된 PDF가 생성됩니다.

이미지, 파형, 오디오, 비디오, 포인트 클라우드, 궤적, 표, 수식은 모두 원래 형태 그대로 입력됩니다.

## 설치

### 에이전트 사용

이 내용을 **Claude Code**, **Cursor**, **Codex** 또는 셸이 있는 다른 도구에 붙여넣으세요.

자세한 내용은 [omniscientist.github.io](https://omni-scientist.github.io/)를 참조하세요.

```text
Read https://omni-scientist.github.io/setup/install.md and install the OmniScientist desktop app on this machine, following the steps.
```

### 다운로드

| | macOS | Linux | Windows |
|---|---|---|---|
| **Desktop app** | [Apple silicon](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/OmniSci-Desktop-macOS.zip) | [x64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/OmniSci-Desktop-Linux-x64.deb) | [x64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/OmniSci-Desktop-Windows-x64-setup.exe) |
| **Terminal agent** | [Apple silicon](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-CLI-macOS.tar.gz) | [x64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-CLI-Linux-x64.tar.gz) · [ARM64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-CLI-Linux-ARM64.tar.gz) | [x64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-CLI-Windows-x64.zip) |
| **Claude Code skill** | [omnisci-skill.zip](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-skill.zip) | [omnisci-skill.zip](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-skill.zip) | [omnisci-skill.zip](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-skill.zip) |

터미널 에이전트도 한 줄로 설치할 수 있습니다. macOS와 Linux에서는 `curl -fsSL https://raw.githubusercontent.com/Omni-Scientist/OmniScientist/main/install.sh | sh`을(를), Windows에서는 `irm https://raw.githubusercontent.com/Omni-Scientist/OmniScientist/main/install.ps1 | iex`을(를) 사용하세요.

## 작업 공간

각 단계는 트랜스크립트로 스트리밍되며, 모든 산출물은 생성되는 즉시 연구 로그에 기록됩니다. 여기에는 matplotlib 출력, 이를 그린 스크립트, 그 뒤에 있는 데이터 테이블, 그리고 마지막으로 컴파일된 논문이 포함됩니다.

작업 공간은 로컬 웹 앱입니다. 위 스크린샷의 주소 표시줄에 `127.0.0.1`이 표시되는 이유는 그것이 전체 배포이기 때문입니다. 레이아웃은 휴대폰에서 한 열로 축소됩니다. 탭을 닫으면 30초의 유예 기간 후 실행이 중지되므로, 페이지를 새로고침하면 실행이 계속 유지됩니다.

인터페이스는 첫 실행 시 브라우저의 언어를 따르며, 툴바에서 전환할 수 있습니다. 지원 언어는 영어, 중국어 간체 및 번체, 프랑스어, 스페인어, 일본어, 한국어, 포르투갈어, 독일어, 러시아어입니다.

## 출처

초안의 모든 숫자는 그 숫자를 생성한 실행으로 연결되는 링크를 담고 있다. 게이트는 초안이 아니라 실행 기록을 읽으며, 각 숫자가 어떤 실행의 `stdout`에 나타난 경우에만 초안을 통과시킨다. null 결과가 나오면 아이디어 재도출로 되돌아간다. 인용은 OpenAlex와 Crossref를 대상으로 실시간으로 확인되므로, 각 인용은 실제 DOI를 갖는다.

## 구성

자격 증명은 `~/.omnisci/env`에 있으며, 한 줄에 하나의 `KEY=VALUE`이 들어갑니다. Windows에서는 `%USERPROFILE%\.omnisci\env`에도 있습니다.

```
DEEPSEEK_API_KEY=...
ANTHROPIC_API_KEY=...
```

이 파일은 순수 데이터로 엄격하게 파싱됩니다. 값은 시작 시 환경 변수에서 제거되므로, 에이전트가 작성하는 분석 코드에는 포함되지 않습니다.

두 모델이 두 가지 작업을 수행합니다. 백본은 추론과 작성을 담당합니다. 지각 사이드카는 픽셀을 읽고, 증거가 이미지, 파형, 비디오 또는 포인트 클라우드일 때 작업을 인계받습니다.

| Edition | Backbone | Perception sidecar |
|---|---|---|
| desktop, terminal | `deepseek-v4-flash`, or any OpenAI-compatible endpoint via `OMNISCI_BASE_URL` / `OMNISCI_API_KEY` / `OMNISCI_MODEL` | `claude-sonnet-5` by default, `deepseek-v4-flash-vision-exp` on the same DeepSeek key, changed with `OMNISCI_VISION_PROVIDER` / `OMNISCI_VISION_MODEL` |
| engine | any, selected by `OMNIST_MODEL`, covering OpenAI, Anthropic, OpenRouter, a local vLLM or sglang server, or your own gateway | `OMNIST_PERCEIVER` |

데스크톱 에디션에서는 두 모델 모두 설정 대화상자에서 설정됩니다. 이 대화상자는 실제 요청에 응답한 후 구성을 저장합니다. 전송 방식은 모델 이름에 따라 결정되므로, 자체 URL과 키를 제공하면 됩니다. 전체 표는 [`docs/USAGE.md`](../USAGE.md)에 있습니다.

나가는 트래픽은 세 가지 종류로 나뉩니다. 첫 번째는 사용자 자신의 모델 엔드포인트입니다. 두 번째는 하루 한 번 GitHub에 대한 릴리스 확인이며, 이는 `OMNISCI_UPDATE_CHECK=off`가 끕니다. 세 번째는 데스크톱 앱에 종속성 설치를 요청할 때 발생하며, PyPI와 tectonic 릴리스 페이지에 도달합니다.

## 소스에서 빌드

[Bun](https://bun.sh) 1.3 이상이 필요합니다.

```bash
cd cli
bun install
bun run tools/gen-skill-assets.ts    # embed the skill, then it is one file
bun run build                        # -> dist/omnisci

cd ../desktop
bun install
bun run build:desktop                # -> dist-desktop/omnisci-desktop
```

데스크톱 런처는 순수 TypeScript로 작성되었으며 `--target`로 크로스 컴파일됩니다. CLI는 실행되는 플랫폼에서 빌드됩니다. 그 이유는 CLI가 수식 렌더링용 네이티브 모듈을 가져오고, 크로스 빌드된 바이너리가 잘못된 아키텍처용 복사본을 포함하여 수식이 처음 렌더링될 때 문제가 드러나기 때문입니다. CI는 모든 CLI 아티팩트를 해당 플랫폼에서 빌드합니다.

## 테스트

```bash
python3 scripts/scan_leaks.py        # scan for personal data
python3 scripts/check_parity.py      # engine, both skills and the desktop agree
python3 skill/build.py               # the skill is still self-contained

cd cli      && bun run typecheck && bun test
cd desktop  && bun run build:assets && bun run typecheck && bun test gateway launcher && bun run test:e2e
```

CI는 모든 푸시에서 위의 모든 테스트와 컴파일된 런처의 라이브 스모크 테스트를 실행합니다. `v*` 태깅은 릴리스 아티팩트를 빌드하고 게시합니다.

## 저장소 구조

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

두 가지 스킬 에디션, 생성된 파일 및 플랫폼별 빌드에 대한 참고 사항은 [`docs/DEVELOPMENT.md`](../DEVELOPMENT.md)에서 확인할 수 있습니다.

## 상태

초기 소프트웨어, 버전 `0.1.2`. 인터페이스는 아직 유동적이며 릴리스에서 변경될 수 있습니다.

| Platform | Terminal agent | Desktop |
|---|---|---|
| macOS arm64 | released | released |
| Linux x86_64 | released | released |
| Linux arm64 | released | released |
| Windows x64 | released | released |

macOS에서는 데스크톱 앱이 15.7.7 / M3에서 설치, 실행, 메뉴 막대, 종료, 재실행, 단일 인스턴스, 루프백 바인딩 및 서명을 통해 검증되었으며, macOS에서의 엔드투엔드 논문 실행이 그 목록의 다음 항목입니다. Windows 빌드는 CI에서 생성되고 컴파일되며, 필요한 코드 경로가 작성되었습니다. 여전히 부족한 것은 실제 Windows 머신에서의 보고서입니다. Intel Mac은 소스에서 빌드됩니다. [소스에서 빌드](#build-from-source)를 참조하세요.

릴리스 자산은 단일 `SHA256SUMS`에 나열되며, `install.sh`와 `install.ps1`이 설치 전에 이를 확인합니다.

## 샘플 논문

단일 실행으로 처음부터 끝까지 작성된 다섯 편의 논문은 [`papers/`](../../papers/)에 있으며, 받은 동료 검토 점수와 함께 제공됩니다. 작동 예시 중 하나는 `"noise"` 라벨이 붙은 STEAD 지진 파형입니다. 에이전트는 3성분 파형을 읽고, 노이즈 라벨 세트 안에서 코히런트 도달을 찾아낸 뒤, 스스로 생성한 대체 귀무 분포와 대조하여 검정했습니다.

```bash
git clone https://github.com/Omni-Scientist/OmniScientist.git && cd OmniScientist
python -m venv .venv && source .venv/bin/activate && pip install -r engine/requirements.txt
export OMNIST_MODEL=claude-sonnet-5 ANTHROPIC_API_KEY=sk-ant-...
python engine/omniscientist/agentic.py --task stead_seismic --stage run
```

`engine/`는 기술 보고서가 설명하는 참조 구현이며, 스크립트 기반의 재현 가능한 실행에 사용할 구현입니다. `OMNIST_MODEL`는 백본을 선택하고 전송 방식은 이름에서 결정되므로, 자체 엔드포인트와 키를 제공하면 됩니다.

결과 논문인 [Coherent polarized signals in a substantial fraction of noise-labeled STEAD traces](../../papers/seismology_stead_noise.pdf)는 샘플링된 노이즈 라벨 트레이스 중 21.7%가 1% 오경보율에서 실제 신호를 포함한다고 보고합니다.

## 기여하기

이슈와 풀 리퀘스트는 환영합니다. Windows 및 Intel Mac 사용자의 보고는 특히 유용합니다. PR을 열기 전에 [Tests](#tests)에 있는 검사를 실행하세요. CI가 실행하는 것과 동일한 검사입니다. 새 분야를 추가하려면 `series.json` 하나를 `engine/examples/` 아래에 두면 되며, 이에 대한 설명은 [`docs/USAGE.md`](../USAGE.md)에 있습니다.

## 인용

이 소프트웨어의 기반이 되는 기술 보고서는 [arXiv](https://arxiv.org/abs/2608.13558)에서 확인할 수 있습니다.

```bibtex
@article{omniscientist2026,
  title   = {OmniScientist: An Omni-Modal Omni-Discipline AI Scientist},
  author  = {Li, Bobo and Fei, Hao and Ju, Tianjie and Lee, Mong-Li and Hsu, Wynne},  % scan-leaks: allow
  journal = {arXiv preprint arXiv:2608.13558},
  year    = {2026}
}
```

저자와 소속 정보가 포함된 논문용 버전의 이 페이지는 [`README_paper.md`](../README_paper.md)에서 확인할 수 있습니다.

## 라이선스

[MIT](../../LICENSE).
