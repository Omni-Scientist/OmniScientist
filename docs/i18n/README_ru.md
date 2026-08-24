<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../assets/title-dark.png">
  <img src="../../assets/title.png" width="560" alt="OmniScientist">
</picture>
<br/>

### Открытый омнимодальный ИИ-учёный, работающий на вашей собственной машине

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
<a href="../../README.md">English</a> · <a href="README_zh.md">简体中文</a> · <a href="README_fr.md">Français</a> · <a href="README_es.md">Español</a> · <a href="README_zh-Hant.md">繁體中文</a> · <a href="README_ja.md">日本語</a> · <a href="README_ko.md">한국어</a> · <a href="README_pt.md">Português</a> · <a href="README_de.md">Deutsch</a> · <strong>Русский</strong>
</p>

</div>

---

## Новости

- **2026-08-24** · **Поддержка нескольких языков.** Интерфейс рабочей области и эта страница доступны на нескольких языках, перечисленных вверху этой страницы и переключаемых из панели инструментов в приложении. *([v0.1.3](https://github.com/Omni-Scientist/OmniScientist/releases/tag/v0.1.3))*
- **2026-08-23** · **Поддержка мультимодальности DeepSeek.** `deepseek-v4-flash-vision-exp` присоединяется к сайдкару восприятия, так что один ключ DeepSeek теперь покрывает и рассуждение, и зрение. *([v0.1.2](https://github.com/Omni-Scientist/OmniScientist/releases/tag/v0.1.2))*
- **2026-08-18** · **Первый патч-релиз.** Артефакты релиза содержат один `SHA256SUMS`, и установщики проверяют его перед установкой. *([v0.1.1](https://github.com/Omni-Scientist/OmniScientist/releases/tag/v0.1.1))*
- **2026-08-16** · **Первый публичный релиз.** Настольное приложение, терминальный агент и навык Claude Code из единой кодовой базы. *([v0.1.0](https://github.com/Omni-Scientist/OmniScientist/releases/tag/v0.1.0))*
- **2026-08-13** · **Технический отчёт.** [arXiv:2608.13558](https://arxiv.org/abs/2608.13558), с прогонами по двенадцати модальностям.

---

<img src="../../assets/shot-paper.jpg" width="100%" alt="The compiled paper in the research log, each highlighted number linked to the run that produced it">

Скомпилированная статья рядом с трассой эксперимента: каждое выделенное число ведёт к запуску, который его породил.

<img src="../../assets/shot-mol.jpg" width="100%" alt="A ball-and-stick conformer computed from the chemistry case's SMILES, in the research log">

Шаростержневой конформер, вычисленный из SMILES самого химического примера и появляющийся в журнале исследования в ходе запуска.

<img src="../../assets/shot-ct.jpg" width="100%" alt="A 64-cubed CT volume read as a point cloud, in the research log">

Объём КТ 64³, прочитанный как облако точек, рядом с вызовами инструментов, которые его создали.

Направьте OmniScientist на папку с данными и укажите исследовательское направление. Он сам смотрит на исходный материал, формирует гипотезу, пишет и запускает собственный код анализа, читает возвращаемые графики и составляет статью, в которой каждое число прослеживается до реальной записи выполнения. Запуск завершается скомпилированным PDF с рисунками, таблицами и ссылками, ведущими к реальным DOI.

Изображения, сигналы, аудио, видео, облака точек, траектории, таблицы и формулы принимаются как есть.

## Установка

### С помощью агента

Вставьте это в **Claude Code**, **Cursor**, **Codex** или любой другой инструмент с shell.

Подробнее см. [omniscientist.github.io](https://omni-scientist.github.io/).

```text
Read https://omni-scientist.github.io/setup/install.md and install the OmniScientist desktop app on this machine, following the steps.
```

### Загрузка

| | macOS | Linux | Windows |
|---|---|---|---|
| **Desktop app** | [arm64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/OmniScientist-macos-arm64.tar.gz) | [x86_64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/OmniScientist-linux-x86_64.tar.gz) · [arm64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/OmniScientist-linux-arm64.tar.gz) | [x64](https://github.com/Omni-Scientist/OmniScientist/releases/latest) |
| **Terminal agent** | [arm64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-darwin-arm64) | [x86_64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-linux-x86_64) · [arm64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-linux-arm64) | [x64](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-windows-x86_64.exe) |
| **Claude Code skill** | [omnisci-skill.zip](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-skill.zip) | [omnisci-skill.zip](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-skill.zip) | [omnisci-skill.zip](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-skill.zip) |

Терминальный агент также устанавливается одной командой. Используйте `curl -fsSL https://raw.githubusercontent.com/Omni-Scientist/OmniScientist/main/install.sh | sh` на macOS и Linux, и `irm https://raw.githubusercontent.com/Omni-Scientist/OmniScientist/main/install.ps1 | iex` на Windows.

## Рабочее пространство

Каждый этап транслируется в протокол, и каждый артефакт попадает в журнал исследования в момент своего появления. Это относится и к выводу matplotlib, и к скрипту, который его построил, и к таблице данных за ним, и в конце — к собранной статье.

Рабочее пространство — это локальное веб-приложение. В адресной строке на скриншотах выше указано `127.0.0.1`, потому что это и есть весь деплой. На телефоне раскладка сворачивается в одну колонку. Закрытие вкладки останавливает выполнение после 30-секундной отсрочки, так что обновление страницы сохраняет его активным.

Интерфейс при первом запуске следует языку браузера и переключается из панели инструментов на английский, упрощённый и традиционный китайский, французский, испанский, японский, корейский, португальский, немецкий и русский.

## Происхождение

Каждое число в черновике содержит ссылку на запуск, который его породил. Шлюз читает запись выполнения, а не черновик, и пропускает черновик, как только каждое из этих чисел появилось в `stdout` некоторого запуска. Нулевой результат направляется обратно на повторную генерацию идей. Цитирования разрешаются в реальном времени через OpenAlex и Crossref, поэтому каждое из них содержит настоящий DOI.

## Конфигурация

Учётные данные хранятся в `~/.omnisci/env`, по одному `KEY=VALUE` в строке, а в Windows — в `%USERPROFILE%\.omnisci\env`.

```
DEEPSEEK_API_KEY=...
ANTHROPIC_API_KEY=...
```

Файл разбирается строго как данные. Значения удаляются из окружения при запуске, поэтому они не попадают в аналитический код, который пишет агент.

Две модели выполняют две задачи. Основная модель рассуждает и пишет. Сайдкар восприятия читает пиксели и берёт управление на себя, когда данные представляют собой изображение, сигнал, видео или облако точек.

| Edition | Backbone | Perception sidecar |
|---|---|---|
| desktop, terminal | `deepseek-v4-flash`, or any OpenAI-compatible endpoint via `OMNISCI_BASE_URL` / `OMNISCI_API_KEY` / `OMNISCI_MODEL` | `claude-sonnet-5` by default, `deepseek-v4-flash-vision-exp` on the same DeepSeek key, changed with `OMNISCI_VISION_PROVIDER` / `OMNISCI_VISION_MODEL` |
| engine | any, selected by `OMNIST_MODEL`, covering OpenAI, Anthropic, OpenRouter, a local vLLM or sglang server, or your own gateway | `OMNIST_PERCEIVER` |

В настольной версии обе задаются через диалог настроек, который сохраняет конфигурацию после того, как ответит на реальный запрос. Транспорт определяется по имени модели, поэтому вы указываете свой собственный URL и ключ. Полная таблица приведена в [`docs/USAGE.md`](../USAGE.md).

Исходящий трафик бывает трёх видов. Первый — это ваш собственный эндпоинт модели. Второй — ежедневная проверка релизов на GitHub, которую отключает `OMNISCI_UPDATE_CHECK=off`. Третий происходит, когда вы просите настольное приложение установить его зависимости; при этом выполняется обращение к PyPI и странице релизов tectonic.

## Сборка из исходников

Требуется [Bun](https://bun.sh) версии 1.3 или новее.

```bash
cd cli
bun install
bun run tools/gen-skill-assets.ts    # embed the skill, then it is one file
bun run build                        # -> dist/omnisci

cd ../desktop
bun install
bun run build:desktop                # -> dist-desktop/omnisci-desktop
```

Десктопный лаунчер написан на чистом TypeScript и кросскомпилируется с помощью `--target`. CLI собирается на той платформе, где он будет запускаться, потому что он подключает нативный модуль для рендеринга формул, а кросскомпилированный бинарник содержит копию с неправильной архитектурой — это проявится при первом же рендеринге формулы. CI собирает каждый артефакт CLI на своей собственной платформе.

## Тесты

```bash
python3 scripts/scan_leaks.py        # scan for personal data
python3 scripts/check_parity.py      # engine, both skills and the desktop agree
python3 skill/build.py               # the skill is still self-contained

cd cli      && bun run typecheck && bun test
cd desktop  && bun run build:assets && bun run typecheck && bun test gateway launcher && bun run test:e2e
```

CI запускает всё вышеперечисленное, а также живой смоук-тест собранного лаунчера при каждом пуше. Тегирование `v*` собирает и публикует релизные артефакты.

## Структура репозитория

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

Примечания о двух редакциях навыков, генерируемых файлах и сборке для каждой платформы находятся в [`docs/DEVELOPMENT.md`](../DEVELOPMENT.md).

## Статус

Раннее ПО, версия `0.1.2`. Интерфейсы всё ещё меняются, и релизы могут их изменить.

| Platform | Terminal agent | Desktop |
|---|---|---|
| macOS arm64 | released | released |
| Linux x86_64 | released | released |
| Linux arm64 | released | released |
| Windows x64 | released | released |

На macOS настольное приложение проверено по пунктам: установка, запуск, строка меню, выход, повторный запуск, одиночный экземпляр, loopback-привязка и подпись, на 15.7.7 / M3. Сквозной прогон статьи на macOS — следующий в этом списке. Сборки для Windows приходят из CI и компилируются, а необходимые им пути кода написаны для них. Чего пока не хватает — так это отчёта с реальной машины Windows. Intel Mac собираются из исходников, см. [Сборка из исходников](#build-from-source).

Артефакты релиза перечислены в одном `SHA256SUMS`, который `install.sh` и `install.ps1` проверяют перед установкой.

## Примеры статей

Пять статей, написанных от начала до конца за один запуск, находятся в [`papers/`](../../papers/) вместе с присвоенными им оценками рецензирования. Один проработанный пример — сейсмические трассы STEAD с меткой «шум». Агент прочитал трёхкомпонентные формы волн, обнаружил когерентные вступления внутри набора с меткой «шум» и проверил их на суррогатном нулевом распределении, сгенерированном им самим.

```bash
git clone https://github.com/Omni-Scientist/OmniScientist.git && cd OmniScientist
python -m venv .venv && source .venv/bin/activate && pip install -r engine/requirements.txt
export OMNIST_MODEL=claude-sonnet-5 ANTHROPIC_API_KEY=sk-ant-...
python engine/omniscientist/agentic.py --task stead_seismic --stage run
```

`engine/` — эталонная реализация, описанная в техническом отчёте, и именно её следует использовать для скриптуемых и воспроизводимых запусков. `OMNIST_MODEL` выбирает бэкбон, а транспорт следует из названия, так что вы подключаете свою конечную точку и ключ.

В итоговой статье, [Когерентные поляризованные сигналы в значительной доле трасс STEAD с меткой «шум»](../../papers/seismology_stead_noise.pdf), сообщается, что 21.7% выбранных трасс с меткой «шум» несут реальный сигнал при уровне ложных тревог 1%.

## Участие в разработке

Issues и pull requests приветствуются. Особенно полезны отчёты с Windows и Intel Mac. Перед созданием PR запустите проверки из раздела [Tests](#tests) — это те же проверки, которые выполняет CI. Добавление дисциплины требует одного `series.json` в `engine/examples/`, как описано в [`docs/USAGE.md`](../USAGE.md).

## Цитирование

Технический отчет, лежащий в основе этого программного обеспечения, опубликован на [arXiv](https://arxiv.org/abs/2608.13558).

```bibtex
@article{omniscientist2026,
  title   = {OmniScientist: An Omni-Modal Omni-Discipline AI Scientist},
  author  = {Li, Bobo and Fei, Hao and Ju, Tianjie and Lee, Mong-Li and Hsu, Wynne},  % scan-leaks: allow
  journal = {arXiv preprint arXiv:2608.13558},
  year    = {2026}
}
```

Версия этой страницы для публикации в статье, с авторами и аффилиациями, — [`README_paper.md`](../README_paper.md).

## Лицензия

[MIT](../../LICENSE).
