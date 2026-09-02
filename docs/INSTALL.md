# Installing OmniScientist

Four editions, three platforms. Pick the edition first; the platform rarely changes
anything.

| Edition | What you get | Needs an API key |
|---|---|:--:|
| [skill](#skill) | OmniScientist inside Claude Code | no |
| [cli](#cli) | a terminal agent, one executable | yes |
| [desktop](#desktop) | a browser workspace, double-click to start | yes |
| [engine](#engine) | the reference implementation the paper reports | yes |

Everything below assumes you also want PDFs at the end. See
[runtime dependencies](#runtime-dependencies) for that part; it is the same for all
four and it is the step people miss.

---

## skill

No API key: your own Claude Code session does the perceiving and the writing.

```bash
curl -fsSL -o omnisci-skill.zip \
  https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/omnisci-skill.zip
unzip omnisci-skill.zip -d ~/.claude/skills/
pip install -r ~/.claude/skills/omnisci/requirements.txt
```

Or from a clone, which is the same directory:

```bash
cp -r skill/omnisci ~/.claude/skills/
```

Check it:

```bash
python3 ~/.claude/skills/omnisci/bin/case_cli.py inspect --dir <any folder of data>
```

It should print the modalities and labels it found. Then start a session and say what
you want, for example *"I have a folder of microscope images in `~/slides`, make me a
paper"*. The skill is selected by its description, or invoke it as `/omnisci`.

---

## cli

**Discontinued.** The standalone terminal agent stopped shipping with 0.2.1. Its
engine lives on inside the desktop app, and Claude Code users take the skill above.
The old one-line installers now print exactly that instead of downloading anything.

### Credentials

`~/.omnisci/env`, one `KEY=VALUE` per line (`%USERPROFILE%\.omnisci\env` on Windows):

```
DEEPSEEK_API_KEY=...
ANTHROPIC_API_KEY=...
```

The file is parsed strictly as data, never sourced as shell. An optional `export`
prefix and matching quotes are accepted; anything else makes the whole file be
ignored rather than half-read. The values are removed from the environment at startup
so the analysis scripts and shell commands the agent runs do not inherit them.

The perception sidecar is a second model that reads the pixels and returns a bounded
observation; the default backbone `deepseek-v4-flash` is text-only. Text-only work does
not need one. It defaults to `claude-sonnet-5` on `ANTHROPIC_API_KEY`; set
`OMNISCI_VISION_PROVIDER`, `OMNISCI_VISION_MODEL` and, for a custom endpoint,
`OMNISCI_VISION_BASE_URL` to move it. `deepseek-v4-flash-vision-exp` runs vision on the
same `DEEPSEEK_API_KEY`, and `gpt-5.6-luna` on `OPENAI_API_KEY` is the cheap alternative
at $0.20 / $1.20 per million tokens. In the desktop build both are picked
from the settings dialog, which sends a real test image before saving.

For any other OpenAI-compatible endpoint as the backbone, set `OMNISCI_BASE_URL`,
`OMNISCI_API_KEY` and `OMNISCI_MODEL` instead.

---

## desktop

A native desktop app (0.2.0 and later). The window, the service behind it, and all
of your data stay on your machine.

### Windows

Download and run the installer, no administrator rights needed. It installs
per-user and adds OmniScientist to the Start Menu.

```text
https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/OmniSci-Desktop-Windows-x64-setup.exe
```

Two things to know. The `bash` tool needs a native bash, so install
[Git for Windows](https://git-scm.com/download/win). WSL's bash is refused on
purpose, because it runs in a different operating system and would silently
produce results in the wrong filesystem. And SmartScreen will warn on first run,
because the binary is not signed with a paid certificate. Choose "More info" then
"Run anyway".

Windows on ARM works through the x64 emulation layer; there is no separate ARM64
build.

### macOS

```bash
curl -fsSL -o /tmp/OmniSci-Desktop-macOS.zip \
  https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/OmniSci-Desktop-macOS.zip
ditto -x -k /tmp/OmniSci-Desktop-macOS.zip /Applications
```

Then open it from Launchpad or Applications.

Install through the terminal rather than a browser download: the quarantine attribute
is set by the *downloader*, and `curl` does not set it, so Gatekeeper never gets
involved. If you do download the zip in a browser, macOS 15 and later will block
the first launch and the way through is System Settings, Privacy & Security, "Open
Anyway" (the old Control-click shortcut was removed in Sequoia).

### Linux

```bash
curl -fsSL -o /tmp/OmniSci-Desktop-Linux-x64.deb \
  https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/OmniSci-Desktop-Linux-x64.deb
sudo apt install /tmp/OmniSci-Desktop-Linux-x64.deb
```

Then launch it from the application menu, or run `OmniScientist`. Uninstall it
through your package manager like any other package.

### What it does at startup

Binds `127.0.0.1` only, takes a free port, generates a random 32-byte token, and hands
the browser that token once in the URL. The server sets it as an `HttpOnly`
`SameSite=Strict` cookie and redirects, so it leaves the address bar and does not end
up in history.

The token is the credential itself, not a one-shot code exchanged for a different
session key: presenting it again during the process's lifetime yields the cookie
again. It lives in `~/.omnisci/desktop.lock` (mode `0600`, ACL-restricted on Windows)
and in the line the launcher prints on startup. Since the service is loopback-only,
what this protects against is other software on the machine reaching the API, not a
remote attacker. Treat that startup line the way you would treat a password.

A lock file at `~/.omnisci/desktop.lock` keeps a second launch from starting a second
service. Logs are under `~/.omnisci/logs/`.

Credentials are the same `~/.omnisci/env` described above. Without them it still starts and
the interface offers to set them.

---

## engine

The implementation the technical report describes. Use it when you want a run to be
scriptable and reproducible rather than conversational.

```bash
git clone git@github.com:Omni-Scientist/OmniScientist.git
cd OmniScientist
python -m venv .venv && source .venv/bin/activate
pip install -r engine/requirements.txt

export OMNIST_MODEL=claude-sonnet-5
export ANTHROPIC_API_KEY=sk-ant-...
python engine/omniscientist/agentic.py --task galaxy_xsurvey --stage run
```

`pipeline.py` reads the model name from `OMNIST_MODEL` and picks the transport, so
you supply your own URL and key. Nothing is hardcoded.

| `OMNIST_MODEL` | Transport | Environment |
|---|---|---|
| `gpt-5.6`, `o3`, ... | OpenAI official, with prompt caching | `OPENAI_API_KEY` |
| `claude-sonnet-5`, ... | Anthropic official | `ANTHROPIC_API_KEY` |
| `or/<vendor>/<model>` | OpenRouter | `OPENROUTER_API_KEY` |
| `local/<name>` | your vLLM or sglang server | `OMNIST_LOCAL_URL`, `OMNIST_LOCAL_KEY` |
| anything else | your own OpenAI-compatible gateway | `OMNIST_GATEWAY_URL`, `OMNIST_GATEWAY_KEY` |

`OMNIST_PERCEIVER` gives vision its own model while another backbone reasons, for
example `OMNIST_PERCEIVER=gpt-5.6-luna` alongside a Claude backbone. The sample papers
were produced with `claude-sonnet-5` doing both. Full reference in
[`USAGE.md`](USAGE.md).

---

## Runtime dependencies

Two things live outside the binaries, and a run needs both to reach a PDF.

**Python 3.10 or newer**, with numpy, pandas, matplotlib, scipy, scikit-learn, sympy,
imageio and soundfile. The exact list is `skill/omnisci/requirements.txt`.

**[tectonic](https://tectonic-typesetting.github.io/)**, which compiles the LaTeX.
Without it a run still produces the `.tex`, says so, and stops there. Everything
before that step works.

The desktop edition can install both for you: it checks on startup and offers to put
them under its own data directory, touching nothing else. The other three expect you
to have them.

Installing tectonic by hand:

```bash
# x86_64
curl -fsSL https://drop-sh.fullyjustified.net | sh && sudo mv tectonic /usr/local/bin/

# ARM (Apple silicon, Graviton, Jetson): the wrong architecture fails with
# "Exec format error", so take the matching build
V=0.17.0; A=$(uname -m)          # aarch64 or x86_64
curl -fsSL "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40$V/tectonic-$V-$A-unknown-linux-musl.tar.gz" \
  | sudo tar -xz -C /usr/local/bin tectonic
```

Anything on `PATH` is used, so the location is up to you.

---

## Building from source

Needs [Bun](https://bun.sh) 1.3 or newer.

```bash
cd cli
bun install
bun run tools/gen-skill-assets.ts      # embed the skill
bun build --compile --minify --define 'process.env.DEV="false"' src/cli.tsx --outfile dist/omnisci

cd ../desktop
bun install
bun run build:desktop                  # -> dist-desktop/omnisci-desktop
```

Cross-compiling the desktop launcher with `--target` works, it has no native
dependencies.

---

## When it does not work

**`omnisci: command not found`** after installing. `~/.local/bin` is not on your
`PATH`. Add `export PATH="$HOME/.local/bin:$PATH"` to your shell profile.

**The run stops at the `.tex`.** tectonic is missing. See above; this is expected
behaviour, not a crash.

**`Exec format error`** on ARM. An x86_64 build of tectonic. Take the `aarch64` one.

**A python import fails partway through a run.** Package versions move: recent pandas
and matplotlib have removed arguments that older analysis code still passes. The run
prints the traceback rather than swallowing it, and the fix is normally in the
analysis script the agent just wrote.

**The desktop page says it needs the launcher.** You opened `127.0.0.1:<port>` without
the token, or the cookie expired after a day. Reopen from the menu-bar item, or
restart it.
