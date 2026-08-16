# cli: the terminal agent

A general terminal agent that can do ordinary workspace tasks with its file, shell,
search, and vision tools. The OmniScientist paper workflow ships as an opt-in skill
and activates only when you actually ask for a paper.

```bash
./bin/omnisci                       # interactive, in the current directory
./bin/omnisci -C ~/work "为什么构建失败"   # one-shot task
./bin/omnisci --data ~/slides       # unattended: data in, candidate paper out
```

Opening a workspace does not start a paper run. `--data` is the only thing that does,
and it exits non-zero unless the run used the dedicated `omnisci_record`,
`omnisci_bib`, and `omnisci_compile` tools, their receipts match the ledger,
bibliography, manifest, TeX, and PDF hashes, the gate passed on that exact TeX, and
every evidence image and figure has a current `view_image` receipt.

## Credentials

`~/.omnisci/env`, one `KEY=VALUE` per line:

```
DEEPSEEK_API_KEY=...
ANTHROPIC_API_KEY=...
```

The file is parsed strictly as data. An optional `export` prefix and matching quotes
are accepted; anything else makes the whole file be ignored rather than guessed at.
It is never sourced as shell code. At startup the values are handed over through a
one-time file descriptor and removed from the environment, so the analysis scripts
and shell commands the agent runs do not inherit them.

The perception sidecar is a separate model from the backbone. The DeepSeek endpoint
accepts text parts only, so `view_image` sends pixels elsewhere and returns a bounded
factual observation. It is the same dedicated-perceiver design as the technical report's
text-backbone experiments.

| | |
|---|---|
| `OMNISCI_VISION_PROVIDER` | `anthropic` (default), `openai`, `deepseek`, `custom` |
| `OMNISCI_VISION_MODEL` | `claude-sonnet-5` (default), or e.g. `gpt-5.6-luna` |
| `OMNISCI_VISION_BASE_URL` | only for `custom`, any OpenAI-compatible endpoint that takes `image_url` |

`gpt-5.6-luna` reads images at $0.20 / $1.20 per million tokens against Sonnet 5's
$2.00 / $10.00. It is a reasoning model, so its reasoning tokens are billed as output
and the gap in practice is smaller than the list price suggests. The sidecar has its own
base URL, so the backbone and the eye can sit on different endpoints.

For any other OpenAI-compatible endpoint, point `OMNISCI_BASE_URL`,
`OMNISCI_API_KEY`, and `OMNISCI_MODEL` at it.

## Hard blocks

`src/guard.ts` is enforcement, not prompting. The model here is small, and a rule
that lives only in a system prompt is a rule a small model will walk around. So the
dangerous cases are refused in code, before the approval gate, and `--auto-approve`
does not reach them.

A refusal always carries a rewritten safe command. Refusing without an alternative
makes a model either stall or go looking for a way around, which is worse than the
original request.

Built-in rules cover what is dangerous anywhere: `rm`, `find -delete`, `shred`,
`truncate`, `mkfs`, `rsync --delete`, `qdel`, `git push`, `git reset --hard`.
Anything that is only a rule on *your* machine belongs in
`~/.omnisci/guard-rules.json`; copy [`guard-rules.example.json`](guard-rules.example.json)
and edit. You can also switch off a built-in by id.

It is a blacklist, so it leaks: `e=rm; $e -rf x` gets through. It catches a weak
model's slips, not a determined bypass, which would need an OS sandbox.

## Layout

```
src/
├── cli.tsx        entry point, flags, the interactive shell
├── loop.ts        the agent loop
├── model.ts       OpenAI-compatible streaming tool-calling client
├── guard.ts       hard blocks
├── hooks.ts       PreToolUse hooks, same settings.json shape as Claude Code
├── skills.ts      skill discovery and the use_skill tool
├── delivery.ts    the --data acceptance check
└── tools/         fs, shell, search, vision, artifacts, omnisci
skills/omnisci/    this edition's copy of the skill (see below)
docker/            the hardened sandbox and the offline test suite
```

## Development

```bash
bun install
bun x tsc --noEmit
bun test
bun build --compile --minify --define 'process.env.DEV="false"' src/cli.tsx --outfile dist/omnisci
```

The compiled binary is not enough on its own: `bin/omnisci` resolves the skill from
`<root>/skills`, and the python CLIs must exist as real files because they run as
subprocesses. `packaging/build-tarball.sh` assembles the layout the launcher expects.

Docker is the reference environment for the full suite:

```bash
./docker/test.sh          # type check, unit tests, compiled CLI, model-free pipeline
./docker/test-api.sh      # a small real-API smoke test
./docker/run.sh /path/to/workspace
```

## The bundled skill

The copy in `skills/omnisci` verifies a `view_image` receipt that binds image,
question and observation by SHA-256, because here the pixels go to a separate model.
The repository's top-level `skill/` is the Claude Code edition, where the host reads
the pixels itself and there is no receipt. See
[`docs/DEVELOPMENT.md`](../docs/DEVELOPMENT.md).
