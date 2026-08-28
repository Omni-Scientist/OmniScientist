<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../assets/title-dark.png">
  <img src="../../assets/title.png" width="560" alt="OmniScientist">
</picture>
<br/>

### Um cientista de IA aberto, omni-modal, que roda na sua própria máquina

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
<a href="../../README.md">English</a> · <a href="README_zh.md">简体中文</a> · <a href="README_fr.md">Français</a> · <a href="README_es.md">Español</a> · <a href="README_zh-Hant.md">繁體中文</a> · <a href="README_ja.md">日本語</a> · <a href="README_ko.md">한국어</a> · <strong>Português</strong> · <a href="README_de.md">Deutsch</a> · <a href="README_ru.md">Русский</a>
</p>

</div>

---

https://github.com/user-attachments/assets/02477c18-28ff-4aad-a6bd-b54c6f032bc8

## Notícias

- **2026-08-24** · **Suporte multilíngue.** A interface do workspace e esta página estão disponíveis em vários idiomas, listados no topo desta página e alternados pela barra de ferramentas no aplicativo. *([v0.1.3](https://github.com/Omni-Scientist/OmniScientist/releases/tag/v0.1.3))*
- **2026-08-23** · **Suporte multimodal DeepSeek.** `deepseek-v4-flash-vision-exp` junta-se ao sidecar de percepção, então uma única chave DeepSeek agora cobre tanto raciocínio quanto visão. *([v0.1.2](https://github.com/Omni-Scientist/OmniScientist/releases/tag/v0.1.2))*
- **2026-08-18** · **Primeira versão de correção.** Os artefatos de release trazem um único `SHA256SUMS`, e os instaladores o verificam antes de instalar. *([v0.1.1](https://github.com/Omni-Scientist/OmniScientist/releases/tag/v0.1.1))*
- **2026-08-16** · **Primeira versão pública.** Aplicativo desktop, agente de terminal e uma skill do Claude Code, a partir de um único código-fonte. *([v0.1.0](https://github.com/Omni-Scientist/OmniScientist/releases/tag/v0.1.0))*
- **2026-08-13** · **Relatório técnico.** [arXiv:2608.13558](https://arxiv.org/abs/2608.13558), com execuções em doze modalidades.

---

<img src="../../assets/shot-paper.jpg" width="100%" alt="The compiled paper in the research log, each highlighted number linked to the run that produced it">

O artigo compilado ao lado do rastro do experimento, com cada número destacado remetendo à execução que o produziu.

<img src="../../assets/shot-mol.jpg" width="100%" alt="A ball-and-stick conformer computed from the chemistry case's SMILES, in the research log">

Um confôrmero ball-and-stick calculado a partir do próprio SMILES do caso de química, chegando ao registro de pesquisa durante a execução.

<img src="../../assets/shot-ct.jpg" width="100%" alt="A 64-cubed CT volume read as a point cloud, in the research log">

Um volume de TC 64³ lido como nuvem de pontos, ao lado das chamadas de ferramenta que o produziram.

Aponte o OmniScientist para uma pasta de dados e uma direção de pesquisa. Ele examina o material bruto em si, formula uma hipótese, escreve e executa seu próprio código de análise, lê as figuras que retornam e redige um artigo em que cada número remete a um registro real de execução. Uma execução termina em um PDF compilado com figuras, tabelas e referências que resolvem para DOIs reais.

Imagens, formas de onda, áudio, vídeo, nuvens de pontos, trajetórias, tabelas e fórmulas entram exatamente como estão.

## Instalação

### Com um agente

Cole isto no **Claude Code**, **Cursor**, **Codex** ou em qualquer outra ferramenta com um shell.

Para mais detalhes, consulte [omniscientist.github.io](https://omni-scientist.github.io/).

```text
Read https://omni-scientist.github.io/setup/install.md and install the OmniScientist desktop app on this machine, following the steps.
```

### Download

| | macOS | Linux | Windows |
|---|---|---|---|
| **Desktop app** | [Apple silicon](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/OmniSci-Desktop-macOS.zip) | [x64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/OmniSci-Desktop-Linux-x64.deb) | [x64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/OmniSci-Desktop-Windows-x64-setup.exe) |
| **Terminal agent** | [Apple silicon](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-CLI-macOS.tar.gz) | [x64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-CLI-Linux-x64.tar.gz) · [ARM64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-CLI-Linux-ARM64.tar.gz) | [x64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-CLI-Windows-x64.zip) |
| **Claude Code skill** | [omnisci-skill.zip](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-skill.zip) | [omnisci-skill.zip](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-skill.zip) | [omnisci-skill.zip](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-skill.zip) |

O agente de terminal também é instalado em uma linha. Use `curl -fsSL https://raw.githubusercontent.com/Omni-Scientist/OmniScientist/main/install.sh | sh` no macOS e Linux, e `irm https://raw.githubusercontent.com/Omni-Scientist/OmniScientist/main/install.ps1 | iex` no Windows.

## O espaço de trabalho

Cada etapa flui para a transcrição, e cada artefato é adicionado ao registro de pesquisa no instante em que é criado. Isso inclui a saída do matplotlib, o script que a gerou, a tabela de dados correspondente e, ao final, o artigo compilado.

O espaço de trabalho é um aplicativo web local. A barra de endereço nas capturas de tela acima exibe `127.0.0.1` porque essa é a implantação completa. Em um celular, o layout se reduz a uma única coluna. Fechar a aba interrompe a execução após um período de carência de 30 segundos, portanto recarregar a página a mantém viva.

A interface segue o idioma do navegador no primeiro lançamento e pode ser alternada na barra de ferramentas, em inglês, chinês simplificado e tradicional, francês, espanhol, japonês, coreano, português, alemão e russo.

## Procedência

Cada número no rascunho carrega um link de volta para a execução que o produziu. Um gate lê o registro de execução em vez do rascunho e admite o rascunho assim que cada um desses números tiver aparecido no `stdout` de alguma execução. Um resultado nulo é roteado de volta para a re-ideação. As citações são resolvidas em tempo real contra o OpenAlex e o Crossref, de modo que cada uma carrega um DOI real.

## Configuração

As credenciais ficam em `~/.omnisci/env`, uma `KEY=VALUE` por linha, e em `%USERPROFILE%\.omnisci\env` no Windows.

```
DEEPSEEK_API_KEY=...
ANTHROPIC_API_KEY=...
```

O arquivo é processado estritamente como dados. Os valores são removidos do ambiente na inicialização, para que fiquem fora do código de análise que o agente escreve.

Dois modelos fazem dois trabalhos. O backbone raciocina e escreve. Um sidecar de percepção lê os pixels e assume sempre que a evidência é uma imagem, uma forma de onda, um vídeo ou uma nuvem de pontos.

| Edition | Backbone | Perception sidecar |
|---|---|---|
| desktop, terminal | `deepseek-v4-flash`, or any OpenAI-compatible endpoint via `OMNISCI_BASE_URL` / `OMNISCI_API_KEY` / `OMNISCI_MODEL` | `claude-sonnet-5` by default, `deepseek-v4-flash-vision-exp` on the same DeepSeek key, changed with `OMNISCI_VISION_PROVIDER` / `OMNISCI_VISION_MODEL` |
| engine | any, selected by `OMNIST_MODEL`, covering OpenAI, Anthropic, OpenRouter, a local vLLM or sglang server, or your own gateway | `OMNIST_PERCEIVER` |

Na edição desktop, ambos são definidos na caixa de diálogo de configurações, que salva uma configuração depois de responder a uma solicitação real. O transporte segue o nome do modelo, então você fornece sua própria URL e chave. A tabela completa está em [`docs/USAGE.md`](../USAGE.md).

O tráfego de saída se divide em três tipos. O primeiro é o endpoint do seu próprio modelo. O segundo é uma verificação de lançamentos uma vez ao dia contra o GitHub, que é desativada por `OMNISCI_UPDATE_CHECK=off`. O terceiro ocorre quando você pede ao aplicativo desktop que instale as dependências dele, alcançando o PyPI e a página de lançamento do tectonic.

## Compilar a partir do código-fonte

Requer [Bun](https://bun.sh) 1.3 ou superior.

```bash
cd cli
bun install
bun run tools/gen-skill-assets.ts    # embed the skill, then it is one file
bun run build                        # -> dist/omnisci

cd ../desktop
bun install
bun run build:desktop                # -> dist-desktop/omnisci-desktop
```

O launcher de desktop é TypeScript puro e é compilado de forma cruzada com `--target`. O CLI é compilado na plataforma em que roda, pois inclui um módulo nativo para a renderização de fórmulas, e um binário compilado de forma cruzada carrega a cópia da arquitetura errada, o que se manifesta na primeira vez em que uma fórmula é renderizada. O CI compila cada artefato do CLI em sua própria plataforma.

## Testes

```bash
python3 scripts/scan_leaks.py        # scan for personal data
python3 scripts/check_parity.py      # engine, both skills and the desktop agree
python3 skill/build.py               # the skill is still self-contained

cd cli      && bun run typecheck && bun test
cd desktop  && bun run build:assets && bun run typecheck && bun test gateway launcher && bun run test:e2e
```

O CI executa todos os itens acima, além de um teste de fumaça ao vivo do launcher compilado a cada push. Criar a tag `v*` compila e publica os artefatos de release.

## Estrutura do repositório

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

Notas sobre as duas edições de skill, os arquivos gerados e a compilação por plataforma estão em [`docs/DEVELOPMENT.md`](../DEVELOPMENT.md).

## Status

Software em fase inicial, versão `0.1.2`. As interfaces ainda estão mudando e os lançamentos podem alterá-las.

| Platform | Terminal agent | Desktop |
|---|---|---|
| macOS arm64 | released | released |
| Linux x86_64 | released | released |
| Linux arm64 | released | released |
| Windows x64 | released | released |

No macOS, o aplicativo de desktop é verificado por meio de instalação, inicialização, barra de menus, saída, reinicialização, instância única, vinculação de loopback e assinatura, em 15.7.7 / M3, e uma execução completa de artigo no macOS é a próxima da lista. As builds do Windows vêm da CI e compilam, e os caminhos de código de que precisam estão escritos para elas. O que ainda falta é um relatório de uma máquina Windows real. Macs Intel compilam a partir do código-fonte, veja [Compilação a partir do código-fonte](#build-from-source).

Os artefatos de lançamento estão listados em um único `SHA256SUMS`, que `install.sh` e `install.ps1` verificam antes de instalar.

## Exemplos de artigos

Cinco artigos escritos de ponta a ponta por uma única execução estão em [`papers/`](../../papers/), com as pontuações de revisão por pares que receberam. Um exemplo trabalhado são os traços sísmicos STEAD carregando um rótulo de "ruído". O agente leu as formas de onda de três componentes, encontrou chegadas coerentes dentro do conjunto rotulado como ruído e as testou contra uma distribuição nula substituta que ele mesmo gerou.

```bash
git clone https://github.com/Omni-Scientist/OmniScientist.git && cd OmniScientist
python -m venv .venv && source .venv/bin/activate && pip install -r engine/requirements.txt
export OMNIST_MODEL=claude-sonnet-5 ANTHROPIC_API_KEY=sk-ant-...
python engine/omniscientist/agentic.py --task stead_seismic --stage run
```

`engine/` é a implementação de referência descrita no relatório técnico, e a que deve ser usada para execuções reproduzíveis e scriptáveis. `OMNIST_MODEL` escolhe o backbone e o transporte decorre do nome, então você traz seu próprio endpoint e chave.

O artigo resultante, [Sinais coerentes polarizados em uma fração substancial de traços STEAD rotulados como ruído](../../papers/seismology_stead_noise.pdf), relata que 21,7% dos traços amostrados rotulados como ruído carregam sinal real a uma taxa de falso alarme de 1%.

## Contribuindo

Issues e pull requests são bem-vindos. Relatos de Windows e Macs Intel são especialmente úteis. Antes de abrir um PR, execute as verificações em [Testes](#tests), que são as mesmas que o CI executa. Adicionar uma disciplina exige um `series.json` em `engine/examples/`, descrito em [`docs/USAGE.md`](../USAGE.md).

## Citação

O relatório técnico por trás deste software está no [arXiv](https://arxiv.org/abs/2608.13558).

```bibtex
@article{omniscientist2026,
  title   = {OmniScientist: An Omni-Modal Omni-Discipline AI Scientist},
  author  = {Li, Bobo and Fei, Hao and Ju, Tianjie and Lee, Mong-Li and Hsu, Wynne},  % scan-leaks: allow
  journal = {arXiv preprint arXiv:2608.13558},
  year    = {2026}
}
```

A versão desta página voltada para o artigo, com autores e afiliações, está em [`README_paper.md`](../README_paper.md).

## Licença

[MIT](../../LICENSE).
