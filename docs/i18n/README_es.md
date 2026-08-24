<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../assets/title-dark.png">
  <img src="../../assets/title.png" width="560" alt="OmniScientist">
</picture>
<br/>

### Un científico de IA abierto y omni-modal que se ejecuta en tu propia máquina

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
<a href="../../README.md">English</a> · <a href="README_zh.md">简体中文</a> · <a href="README_fr.md">Français</a> · <strong>Español</strong> · <a href="README_zh-Hant.md">繁體中文</a> · <a href="README_ja.md">日本語</a> · <a href="README_ko.md">한국어</a> · <a href="README_pt.md">Português</a> · <a href="README_de.md">Deutsch</a> · <a href="README_ru.md">Русский</a>
</p>

</div>

---

## Noticias

- **2026-08-24** · **Compatibilidad multiidioma.** La interfaz del espacio de trabajo y esta página están disponibles en varios idiomas, que se listan arriba y se cambian desde la barra de herramientas de la aplicación.
- **2026-08-23** · **Soporte multimodal de DeepSeek.** `deepseek-v4-flash-vision-exp` se une al sidecar de percepción, así una única clave de DeepSeek cubre ahora tanto el razonamiento como la visión. *(v0.1.2)*
- **2026-08-18** · **Primer parche.** Los recursos de publicación incluyen un único `SHA256SUMS`, y los instaladores lo verifican antes de instalar. *(v0.1.1)*
- **2026-08-16** · **Primera publicación pública.** Aplicación de escritorio, agente de terminal y una habilidad de Claude Code, desde un mismo código base. *(v0.1.0)*
- **2026-08-13** · **Informe técnico.** [arXiv:2608.13558](https://arxiv.org/abs/2608.13558), con ejecuciones en doce modalidades.

---

<img src="../../assets/shot-paper.jpg" width="100%" alt="The compiled paper in the research log, each highlighted number linked to the run that produced it">

El documento compilado junto a la traza del experimento, con cada número resaltado remitiendo a la ejecución que lo produjo.

<img src="../../assets/shot-mol.jpg" width="100%" alt="A ball-and-stick conformer computed from the chemistry case's SMILES, in the research log">

Un confórmero de bolas y varillas calculado a partir del propio SMILES del caso de química, que llega al registro de investigación a mitad de la ejecución.

<img src="../../assets/shot-ct.jpg" width="100%" alt="A 64-cubed CT volume read as a point cloud, in the research log">

Un volumen CT de 64³ leído como nube de puntos, junto a las llamadas a herramientas que lo produjeron.

Apunta OmniScientist a una carpeta de datos y a una dirección de investigación. Observa el propio material en bruto, formula una hipótesis, escribe y ejecuta su propio código de análisis, lee las figuras que obtiene y redacta un artículo en el que cada número se remonta a un registro de ejecución real. Una ejecución termina en un PDF compilado con figuras, tablas y referencias que se resuelven a DOIs reales.

Imágenes, formas de onda, audio, video, nubes de puntos, trayectorias, tablas y fórmulas entran tal cual.

## Instalación

### Con un agente

Pega esto en **Claude Code**, **Cursor**, **Codex**, o cualquier otra herramienta con shell.

Para más detalles, consulta [omniscientist.github.io](https://omni-scientist.github.io/).

```text
Read https://omni-scientist.github.io/setup/install.md and install the OmniScientist desktop app on this machine, following the steps.
```

### Descarga

| | macOS | Linux | Windows |
|---|---|---|---|
| **Desktop app** | [arm64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/OmniScientist-macos-arm64.tar.gz) | [x86_64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/OmniScientist-linux-x86_64.tar.gz) · [arm64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/OmniScientist-linux-arm64.tar.gz) | [x64](https://github.com/Omni-Scientist/OmniScientist/releases/latest) |
| **Terminal agent** | [arm64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-darwin-arm64) | [x86_64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-linux-x86_64) · [arm64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-linux-arm64) | [x64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-windows-x86_64.exe) |
| **Claude Code skill** | [omnisci-skill.zip](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-skill.zip) | [omnisci-skill.zip](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-skill.zip) | [omnisci-skill.zip](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-skill.zip) |

El agente de terminal también se instala en una sola línea. Usa `curl -fsSL https://raw.githubusercontent.com/Omni-Scientist/OmniScientist/main/install.sh | sh` en macOS y Linux, y `irm https://raw.githubusercontent.com/Omni-Scientist/OmniScientist/main/install.ps1 | iex` en Windows.

## El espacio de trabajo

Cada etapa se transmite a la transcripción, y cada artefacto llega al registro de investigación en el momento en que se crea. Eso cubre la salida de matplotlib, el script que la generó, la tabla de datos subyacente y, al final, el artículo compilado.

El espacio de trabajo es una aplicación web local. La barra de direcciones de las capturas de pantalla anteriores muestra `127.0.0.1` porque ese es el despliegue completo. El diseño se colapsa a una sola columna en un teléfono. Cerrar la pestaña detiene la ejecución tras un período de gracia de 30 segundos, por lo que una actualización de la página la mantiene activa.

La interfaz sigue el idioma del navegador en el primer lanzamiento y se puede cambiar desde la barra de herramientas, entre: inglés, chino simplificado y tradicional, francés, español, japonés, coreano, portugués, alemán y ruso.

## Procedencia

Cada número en el borrador lleva un enlace que apunta a la ejecución que lo produjo. Una compuerta lee el registro de ejecución en lugar del borrador y acepta el borrador una vez que cada uno de esos números ha aparecido en el `stdout` de alguna ejecución. Un resultado nulo se redirige a la re-ideación. Las citas se resuelven en tiempo real contra OpenAlex y Crossref, por lo que cada una lleva un DOI real.

## Configuración

Las credenciales se encuentran en `~/.omnisci/env`, una `KEY=VALUE` por línea, y en `%USERPROFILE%\.omnisci\env` en Windows.

```
DEEPSEEK_API_KEY=...
ANTHROPIC_API_KEY=...
```

El archivo se analiza estrictamente como datos. Los valores se eliminan del entorno al inicio, de modo que quedan fuera del código de análisis que el agente escribe.

Dos modelos desempeñan dos funciones. El backbone razona y escribe. Un sidecar de percepción lee los píxeles y toma el control cuando la evidencia es una imagen, una forma de onda, un vídeo o una nube de puntos.

| Edition | Backbone | Perception sidecar |
|---|---|---|
| desktop, terminal | `deepseek-v4-flash`, or any OpenAI-compatible endpoint via `OMNISCI_BASE_URL` / `OMNISCI_API_KEY` / `OMNISCI_MODEL` | `claude-sonnet-5` by default, `deepseek-v4-flash-vision-exp` on the same DeepSeek key, changed with `OMNISCI_VISION_PROVIDER` / `OMNISCI_VISION_MODEL` |
| engine | any, selected by `OMNIST_MODEL`, covering OpenAI, Anthropic, OpenRouter, a local vLLM or sglang server, or your own gateway | `OMNIST_PERCEIVER` |

En la edición de escritorio, ambos se establecen desde el diálogo de configuración, que guarda la configuración una vez que ha respondido a una solicitud en directo. El transporte se deduce del nombre del modelo, por lo que proporcionas tu propia URL y clave. La tabla completa está en [`docs/USAGE.md`](../USAGE.md).

El tráfico saliente es de tres tipos. El primero es el endpoint de tu propio modelo. El segundo es una comprobación de versiones una vez al día contra GitHub, que `OMNISCI_UPDATE_CHECK=off` desactiva. El tercero ocurre cuando le pides a la aplicación de escritorio que instale sus dependencias, y llega a PyPI y a la página de versiones de tectonic.

## Compilar desde el código fuente

Requiere [Bun](https://bun.sh) 1.3 o superior.

```bash
cd cli
bun install
bun run tools/gen-skill-assets.ts    # embed the skill, then it is one file
bun run build                        # -> dist/omnisci

cd ../desktop
bun install
bun run build:desktop                # -> dist-desktop/omnisci-desktop
```

El lanzador de escritorio es TypeScript puro y se compila de forma cruzada con `--target`. La CLI se compila en la plataforma en la que se ejecuta, porque incorpora un módulo nativo para el renderizado de fórmulas y un binario compilado de forma cruzada lleva la copia de la arquitectura incorrecta, lo que se manifiesta la primera vez que se renderiza una fórmula. CI compila cada artefacto de la CLI en su propia plataforma.

## Pruebas

```bash
python3 scripts/scan_leaks.py        # scan for personal data
python3 scripts/check_parity.py      # engine, both skills and the desktop agree
python3 skill/build.py               # the skill is still self-contained

cd cli      && bun run typecheck && bun test
cd desktop  && bun run build:assets && bun run typecheck && bun test gateway launcher && bun run test:e2e
```

CI ejecuta todo lo anterior más una prueba de humo en vivo del lanzador compilado en cada push. Etiquetar `v*` compila y publica los artefactos de la versión.

## Estructura del repositorio

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

Las notas sobre las dos ediciones de habilidades, los archivos generados y la compilación por plataforma se encuentran en [`docs/DEVELOPMENT.md`](../DEVELOPMENT.md).

## Estado

Software en fase inicial, versión `0.1.2`. Las interfaces aún están evolucionando y las versiones pueden cambiarlas.

| Platform | Terminal agent | Desktop |
|---|---|---|
| macOS arm64 | released | released |
| Linux x86_64 | released | released |
| Linux arm64 | released | released |
| Windows x64 | released | released |

En macOS, la aplicación de escritorio se verifica mediante instalación, lanzamiento, barra de menús, salida, reinicio, instancia única, vinculación de loopback y firma, en 15.7.7 / M3, y una ejecución de extremo a extremo de un artículo en macOS es el siguiente paso en esa lista. Las compilaciones de Windows vienen de CI y compilan, y las rutas de código que necesitan están escritas para ellas. Lo que aún falta es un informe desde una máquina Windows real. Los Mac con Intel compilan desde el código fuente; consulte [Compilar desde el código fuente](#build-from-source).

Los activos de la versión se enumeran en un único `SHA256SUMS`, que `install.sh` y `install.ps1` comprueban antes de instalar.

## Artículos de muestra

Cinco artículos escritos de principio a fin por una sola ejecución están en [`papers/`](../../papers/), con las puntuaciones de revisión por pares que recibieron. Un ejemplo práctico son las trazas sísmicas STEAD que llevan una etiqueta de "ruido". El agente leyó las formas de onda de tres componentes, encontró llegadas coherentes dentro del conjunto etiquetado como ruido y las probó contra una distribución nula sustituta que generó por sí mismo.

```bash
git clone https://github.com/Omni-Scientist/OmniScientist.git && cd OmniScientist
python -m venv .venv && source .venv/bin/activate && pip install -r engine/requirements.txt
export OMNIST_MODEL=claude-sonnet-5 ANTHROPIC_API_KEY=sk-ant-...
python engine/omniscientist/agentic.py --task stead_seismic --stage run
```

`engine/` es la implementación de referencia que el informe técnico describe, y la que se debe usar para ejecuciones scriptables y reproducibles. `OMNIST_MODEL` selecciona el backbone y el transporte se deduce del nombre, así que usted aporta su propio endpoint y clave.

El artículo resultante, [Señales polarizadas coherentes en una fracción sustancial de trazas STEAD etiquetadas como ruido](../../papers/seismology_stead_noise.pdf), informa que el 21.7% de las trazas muestreadas etiquetadas como ruido contienen señal real a una tasa de falsa alarma del 1%.

## Contribuciones

Las issues y las pull requests son bienvenidas. Los reportes desde Windows y Macs Intel son especialmente útiles. Antes de abrir una PR, ejecuta las verificaciones de [Tests](#tests), que son las mismas que ejecuta CI. Añadir una disciplina requiere un `series.json` bajo `engine/examples/`, como se describe en [`docs/USAGE.md`](../USAGE.md).

## Citación

El informe técnico de este software está disponible en [arXiv](https://arxiv.org/abs/2608.13558).

```bibtex
@article{omniscientist2026,
  title   = {OmniScientist: An Omni-Modal Omni-Discipline AI Scientist},
  author  = {Li, Bobo and Fei, Hao and Ju, Tianjie and Lee, Mong-Li and Hsu, Wynne},  % scan-leaks: allow
  journal = {arXiv preprint arXiv:2608.13558},
  year    = {2026}
}
```

La versión de esta página para el artículo, con autores y afiliaciones, es [`README_paper.md`](../README_paper.md).

## Licencia

[MIT](../../LICENSE).
