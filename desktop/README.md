# desktop: the browser workspace

The same agent as [`cli/`](../cli/), behind a research workspace instead of a
terminal: conversations on the left, the active thread in the centre, and the
session's papers, figures, tables, and code on the right.

One executable starts a loopback server and opens your default browser at it. The
window is your browser, and the interface is a web page served out of the binary. No
Electron, no Tauri, no embedded WebView.

## Install (Linux)

```bash
tar -xzf OmniScientist-<version>-linux-<arch>.tar.gz
cd OmniScientist-<version>-linux-<arch>
./install.sh                  # per-user, no root
./install.sh --uninstall
```

It lands in `~/.local/bin` with a menu entry and an icon. Or skip installing and run
`./omnisci-desktop` directly.

## macOS

The release ships `OmniScientist.app`: a menu-bar host that starts the service,
waits for it to answer, opens the browser, and can quit it again. It is ad-hoc
signed, which is what makes it runnable on Apple Silicon and is unrelated to
Gatekeeper; the documented install path is a terminal command, which never sets the
quarantine attribute. See [`packaging/macos/README.md`](packaging/macos/README.md).

Verified on macOS 15.7.7 / M3: install, launch, menu bar, quit, relaunch, single
instance, loopback-only binding, token handling and signature. The end-to-end paper
run on macOS has not been done.

## Models

The settings dialog configures two independent lines: the research model that reasons
and writes, and the vision model that reads pixels. They are separate because the
DeepSeek endpoint takes text only, so a DeepSeek backbone still needs someone else for
the images.

Vision ships with `claude-sonnet-5` and `gpt-5.6-luna` as one-click choices, plus a
custom endpoint for anything OpenAI-compatible that accepts `image_url`. Saving sends a
real test image and shows what the model reported seeing, so a text-only model is
refused at the point of configuration rather than inventing observations later. Both
lines are written to `~/.omnisci/env` as `OMNISCI_*` variables, which is the same
configuration the CLI reads.

## Runtime contract

The launcher is the contract the macOS packaging depends on. Changing
`launcher/main.ts` changes that contract.

| | |
|---|---|
| Address | binds `127.0.0.1` only, never `0.0.0.0` |
| Port | `--port` or `$OMNISCI_GATEWAY_PORT`, default is a free ephemeral port |
| Auth | a 32-byte token appears once, in the launch URL, and is exchanged for an `HttpOnly` `SameSite=Strict` cookie by a redirect, so it never stays in the address bar |
| Workspace | `--workspace`, or `$OMNISCI_WORKSPACE_ROOT`, else `~/OmniScientist`. The only user directory it may read or write |
| Single instance | `~/.omnisci/desktop.lock`, validated by an actual health probe rather than a bare pid check |
| Browser | opened automatically; `--no-open` prints the URL instead |
| Logs | `~/.omnisci/logs/desktop-<date>.log` |
| `GET /api/health` | unauthenticated, so the instance check can use it |
| `GET /api/doctor` | python, its packages, and tectonic, with versions |
| `POST /api/bootstrap` | installs the missing ones into the app data directory |
| `POST /api/quit` | authenticated; answers **before** exiting |
| Exit codes | 0 fine, 1 bad arguments or config, 2 the port would not bind. Missing python or tectonic still starts, and the interface offers to install them |

## Development

```bash
cd ../cli && bun install     # the gateway imports the agent from cli/src
cd ../desktop && bun install

bun run dev:local            # vite on :4317, gateway on :4318, real backend
bun run build:assets         # vite build + generate the embedded asset module
bun x tsc --noEmit
bun test gateway launcher
bun run build:desktop        # -> dist-desktop/omnisci-desktop
```

`launcher/assets.generated.ts` is a build product and is not committed: it names
content-hashed files that only exist after `vite build`. Type checking from a clean
clone therefore needs `build:assets` first.

The plain `bun run dev` serves the mock transport, which is the demo data with no
backend at all. `dev:local` is the one that runs real sessions.

## Layout

```
src/         the React workspace; every screen depends only on the
             ResearchTransport contract in src/types.ts
gateway/     sessions, streaming, approvals, artifacts; imports the agent
             loop, model, tools, guard, and standards from cli/src unchanged
launcher/    the executable: embedded assets, token exchange, process
             lifecycle, dependency bootstrap
packaging/   linux, macos and windows
```

The browser consumes versioned runtime events, not ANSI output. Workbench artifacts
come from the paper manifest and tool receipts, never from parsing assistant prose or
watching arbitrary filesystem changes.
