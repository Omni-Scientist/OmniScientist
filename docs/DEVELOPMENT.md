# Development

## Repository layout

```
OmniScientist/
├── engine/            the reference engine and evaluation harness, with its cases and data
│   ├── omniscientist/     flat, self-contained modules
│   ├── examples/          case specifications and seven small real-data demos
│   ├── datasets/          provenance and split manifest
│   └── scripts/data.py    list, fetch and verify public research data
├── skill/             the Claude Code edition, self-contained, no API key
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

## Build and test

```bash
python3 scripts/scan_leaks.py            # nothing personal ships
python3 scripts/check_parity.py          # engine, both skills and the desktop agree
python3 skill/build.py                   # the skill is still self-contained

cd cli
bun install && bun x tsc --noEmit && bun test
bun run tools/gen-skill-assets.ts        # embed the skill, then it is one file
bun build --compile --minify --define 'process.env.DEV="false"' src/cli.tsx --outfile dist/omnisci

cd ../desktop
bun install && bun run build:assets
bun run typecheck && bun test gateway    # covers the browser and Bun sides
bun run build:desktop                    # -> dist-desktop/omnisci-desktop
```

CI runs all of the above plus a live smoke test of the launcher on every push. Tagging
`v*` builds the release artifacts.

## Notes on the build

**Two generated files, two rules.** `cli/src/skill-assets.generated.ts` names committed
files, so it is committed too and CI fails if regenerating it produces a diff.
`desktop/launcher/assets.generated.ts` names content-hashed build output that exists
only after `vite build`, so it is not committed, and type checking the desktop from a
clean clone needs `build:assets` first.

**The desktop has two tsconfigs.** The browser code and the Bun code (gateway, launcher,
tools) need different settings. Folding them into one left the launcher unchecked.

**The CLI is built per platform.** It pulls a native module for formula rendering, and a
cross-built binary carries the wrong architecture's copy, which fails only when a formula
is first rendered. CI builds every CLI artifact on its own platform.

## The two editions of the skill

`skill/omnisci` and `cli/skills/omnisci` look alike and are built for different hosts.
In the Claude Code edition the host reads the pixels itself, so `ingest` takes the
host's own words. In the CLI edition the pixels go to a separate vision model, so
`ingest` carries a receipt binding image, question and observation by SHA-256, and the
gate verifies it. Swapping one for the other leaves the receipt check with nothing to
check.
