<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../assets/title-dark.png">
  <img src="../../assets/title.png" width="560" alt="OmniScientist">
</picture>
<br/>

### Un scientifique IA ouvert et omni-modal qui s'exécute sur votre propre machine

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
<a href="../../README.md">English</a> · <a href="README_zh.md">简体中文</a> · <strong>Français</strong> · <a href="README_es.md">Español</a> · <a href="README_zh-Hant.md">繁體中文</a> · <a href="README_ja.md">日本語</a> · <a href="README_ko.md">한국어</a> · <a href="README_pt.md">Português</a> · <a href="README_de.md">Deutsch</a> · <a href="README_ru.md">Русский</a>
</p>

</div>

---

## Actualités

- **2026-08-24** · **Prise en charge multilingue.** L’interface de l’espace de travail et cette page sont disponibles en plusieurs langues, listées en haut de cette page et sélectionnables depuis la barre d’outils de l’application. *(v0.1.3)*
- **2026-08-23** · **Prise en charge multimodale DeepSeek.** `deepseek-v4-flash-vision-exp` rejoint le side-car de perception, si bien qu’une seule clé DeepSeek couvre désormais le raisonnement et la vision. *(v0.1.2)*
- **2026-08-18** · **Première version corrective.** Les artefacts de version portent un unique `SHA256SUMS`, et les installateurs le vérifient avant l’installation. *(v0.1.1)*
- **2026-08-16** · **Première version publique.** Application de bureau, agent terminal et compétence Claude Code, à partir d’une seule base de code. *(v0.1.0)*
- **2026-08-13** · **Rapport technique.** [arXiv:2608.13558](https://arxiv.org/abs/2608.13558), avec des exécutions sur douze modalités.

---

<img src="../../assets/shot-paper.jpg" width="100%" alt="The compiled paper in the research log, each highlighted number linked to the run that produced it">

L'article compilé à côté de la trace d'expérience, chaque numéro surligné renvoyant à l'exécution qui l'a produit.

<img src="../../assets/shot-mol.jpg" width="100%" alt="A ball-and-stick conformer computed from the chemistry case's SMILES, in the research log">

Un conformère en boules et bâtonnets calculé à partir du SMILES du cas de chimie lui-même, arrivant dans le journal de recherche en cours d'exécution.

<img src="../../assets/shot-ct.jpg" width="100%" alt="A 64-cubed CT volume read as a point cloud, in the research log">

Un volume CT 64³ lu comme un nuage de points, à côté des appels d'outils qui l'ont produit.

Pointez OmniScientist vers un dossier de données et une direction de recherche. Il examine le matériau brut lui-même, formule une hypothèse, écrit et exécute son propre code d'analyse, lit les figures qui lui reviennent, et rédige un article dont chaque nombre peut être retracé jusqu'à un enregistrement d'exécution réel. Une exécution se termine par un PDF compilé avec des figures, des tableaux et des références qui résolvent vers des DOI réels.

Images, formes d'onde, audio, vidéo, nuages de points, trajectoires, tableaux et formules entrent tels quels.

## Installation

### Avec un agent

Collez ceci dans **Claude Code**, **Cursor**, **Codex**, ou tout autre outil disposant d'un shell.

Pour plus de détails, veuillez consulter [omniscientist.github.io](https://omni-scientist.github.io/).

```text
Read https://omni-scientist.github.io/setup/install.md and install the OmniScientist desktop app on this machine, following the steps.
```

### Téléchargement

| | macOS | Linux | Windows |
|---|---|---|---|
| **Desktop app** | [arm64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/OmniScientist-macos-arm64.tar.gz) | [x86_64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/OmniScientist-linux-x86_64.tar.gz) · [arm64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/OmniScientist-linux-arm64.tar.gz) | [x64](https://github.com/Omni-Scientist/OmniScientist/releases/latest) |
| **Terminal agent** | [arm64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-darwin-arm64) | [x86_64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-linux-x86_64) · [arm64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-linux-arm64) | [x64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-windows-x86_64.exe) |
| **Claude Code skill** | [omnisci-skill.zip](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-skill.zip) | [omnisci-skill.zip](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-skill.zip) | [omnisci-skill.zip](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-skill.zip) |

L'agent de terminal s'installe également en une ligne. Utilisez `curl -fsSL https://raw.githubusercontent.com/Omni-Scientist/OmniScientist/main/install.sh | sh` sur macOS et Linux, et `irm https://raw.githubusercontent.com/Omni-Scientist/OmniScientist/main/install.ps1 | iex` sur Windows.

## L'espace de travail

Chaque étape est diffusée dans le transcript, et chaque artefact atterrit dans le journal de recherche dès qu'il existe. Cela inclut la sortie matplotlib, le script qui l'a produite, la table de données correspondante, et à la fin le document compilé.

L'espace de travail est une application web locale. La barre d'adresse dans les captures d'écran ci-dessus affiche `127.0.0.1` car c'est là l'intégralité du déploiement. La mise en page se réduit à une seule colonne sur un téléphone. Fermer l'onglet arrête l'exécution après un délai de grâce de 30 secondes, de sorte qu'un rafraîchissement de la page la maintient en vie.

L'interface suit la langue du navigateur au premier lancement et peut être changée depuis la barre d'outils, en anglais, chinois simplifié et traditionnel, français, espagnol, japonais, coréen, portugais, allemand et russe.

## Provenance

Chaque nombre du brouillon porte un lien vers l'exécution qui l'a produit. Une passerelle lit l'enregistrement d'exécution plutôt que le brouillon et accepte le brouillon une fois que chacun de ces nombres est apparu dans la `stdout` d'une exécution. Un résultat nul est renvoyé vers la ré-idéation. Les citations sont résolues en direct auprès d'OpenAlex et de Crossref, de sorte que chacune porte un vrai DOI.

## Configuration

Les identifiants se trouvent dans `~/.omnisci/env`, un `KEY=VALUE` par ligne, et dans `%USERPROFILE%\.omnisci\env` sous Windows.

```
DEEPSEEK_API_KEY=...
ANTHROPIC_API_KEY=...
```

Le fichier est analysé strictement comme des données. Les valeurs sont retirées de l’environnement au démarrage, afin qu’elles restent hors du code d’analyse que l’agent écrit.

Deux modèles accomplissent deux tâches. Le backbone raisonne et écrit. Un sidecar de perception lit les pixels et prend le relais dès que la preuve est une image, une forme d’onde, une vidéo ou un nuage de points.

| Edition | Backbone | Perception sidecar |
|---|---|---|
| desktop, terminal | `deepseek-v4-flash`, or any OpenAI-compatible endpoint via `OMNISCI_BASE_URL` / `OMNISCI_API_KEY` / `OMNISCI_MODEL` | `claude-sonnet-5` by default, `deepseek-v4-flash-vision-exp` on the same DeepSeek key, changed with `OMNISCI_VISION_PROVIDER` / `OMNISCI_VISION_MODEL` |
| engine | any, selected by `OMNIST_MODEL`, covering OpenAI, Anthropic, OpenRouter, a local vLLM or sglang server, or your own gateway | `OMNIST_PERCEIVER` |

Dans l’édition de bureau, les deux sont définis à partir de la boîte de dialogue des paramètres, qui enregistre une configuration une fois qu’elle a répondu à une requête en direct. Le transport découle du nom du modèle, vous fournissez donc votre propre URL et votre clé. Le tableau complet se trouve dans [`docs/USAGE.md`](../USAGE.md).

Le trafic sortant se décline en trois types. Le premier est votre propre point de terminaison de modèle. Le deuxième est une vérification de version une fois par jour auprès de GitHub, que `OMNISCI_UPDATE_CHECK=off` désactive. Le troisième se produit lorsque vous demandez à l’application de bureau d’installer ses dépendances, et atteint PyPI et la page des versions de tectonic.

## Compiler à partir des sources

Nécessite [Bun](https://bun.sh) 1.3 ou une version plus récente.

```bash
cd cli
bun install
bun run tools/gen-skill-assets.ts    # embed the skill, then it is one file
bun run build                        # -> dist/omnisci

cd ../desktop
bun install
bun run build:desktop                # -> dist-desktop/omnisci-desktop
```

Le lanceur de bureau est en TypeScript pur et est compilé en croix avec `--target`. La CLI est compilée sur la plateforme sur laquelle elle s'exécute, car elle intègre un module natif pour le rendu des formules et qu'un binaire compilé en croix porte la copie de la mauvaise architecture, ce qui se manifeste la première fois qu'une formule est rendue. La CI compile chaque artefact de la CLI sur sa propre plateforme.

## Tests

```bash
python3 scripts/scan_leaks.py        # scan for personal data
python3 scripts/check_parity.py      # engine, both skills and the desktop agree
python3 skill/build.py               # the skill is still self-contained

cd cli      && bun run typecheck && bun test
cd desktop  && bun run build:assets && bun run typecheck && bun test gateway launcher && bun run test:e2e
```

La CI exécute tout ce qui précède, ainsi qu'un test de fumée en conditions réelles du lanceur compilé, à chaque push. Tagger `v*` construit et publie les artefacts de release.

## Structure du dépôt

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

Les notes sur les deux éditions de compétences, les fichiers générés et le build par plateforme se trouvent dans [`docs/DEVELOPMENT.md`](../DEVELOPMENT.md).

## Statut

Logiciel en phase précoce, version `0.1.2`. Les interfaces évoluent encore et les versions peuvent les modifier.

| Platform | Terminal agent | Desktop |
|---|---|---|
| macOS arm64 | released | released |
| Linux x86_64 | released | released |
| Linux arm64 | released | released |
| Windows x64 | released | released |

Sur macOS, l’application de bureau est vérifiée via l’installation, le lancement, la barre de menus, la sortie, le relancement, l’instance unique, la liaison loopback et la signature, sur 15.7.7 / M3, et une exécution de bout en bout d’un article sur macOS est la prochaine étape de cette liste. Les builds Windows proviennent du CI et compilent, et les chemins de code dont ils ont besoin sont écrits pour eux. Ce qui manque encore, c’est un rapport provenant d’une véritable machine Windows. Les Mac Intel se compilent à partir des sources, voir [Build from source](#build-from-source).

Les actifs de version sont répertoriés dans un seul `SHA256SUMS`, que `install.sh` et `install.ps1` vérifient avant l’installation.

## Exemples d'articles

Cinq articles rédigés de bout en bout en une seule exécution sont dans [`papers/`](../../papers/), avec les scores d'évaluation par les pairs qu'ils ont reçus. Un exemple concret est celui des traces sismiques STEAD portant une étiquette « bruit ». L'agent a lu les formes d'onde à trois composantes, a trouvé des arrivées cohérentes dans l'ensemble étiqueté comme bruit, et les a testées contre une distribution nulle de substitution qu'il a générée lui-même.

```bash
git clone https://github.com/Omni-Scientist/OmniScientist.git && cd OmniScientist
python -m venv .venv && source .venv/bin/activate && pip install -r engine/requirements.txt
export OMNIST_MODEL=claude-sonnet-5 ANTHROPIC_API_KEY=sk-ant-...
python engine/omniscientist/agentic.py --task stead_seismic --stage run
```

`engine/` est l'implémentation de référence décrite dans le rapport technique, et celle à utiliser pour des exécutions scriptables et reproductibles. `OMNIST_MODEL` choisit le backbone et le transport découle du nom, donc vous apportez votre propre endpoint et clé.

L'article résultant, [Coherent polarized signals in a substantial fraction of noise-labeled STEAD traces](../../papers/seismology_stead_noise.pdf), rapporte que 21,7 % des traces échantillonnées étiquetées comme bruit portent un signal réel avec un taux de fausses alarmes de 1 %.

## Contribuer

Les issues et les pull requests sont les bienvenues. Les rapports de bugs provenant de Windows et de Mac Intel sont particulièrement utiles. Avant d'ouvrir une PR, exécutez les vérifications de la section [Tests](#tests), qui sont les mêmes que celles de la CI. Ajouter une discipline nécessite un `series.json` sous `engine/examples/`, décrit dans [`docs/USAGE.md`](../USAGE.md).

## Citation

Le rapport technique de ce logiciel est disponible sur [arXiv](https://arxiv.org/abs/2608.13558).

```bibtex
@article{omniscientist2026,
  title   = {OmniScientist: An Omni-Modal Omni-Discipline AI Scientist},
  author  = {Li, Bobo and Fei, Hao and Ju, Tianjie and Lee, Mong-Li and Hsu, Wynne},  % scan-leaks: allow
  journal = {arXiv preprint arXiv:2608.13558},
  year    = {2026}
}
```

La version de cette page destinée à l'article, avec les auteurs et les affiliations, est [`README_paper.md`](../README_paper.md).

## Licence

[MIT](../../LICENSE).
