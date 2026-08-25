## Install

Paste this into Claude Code, Cursor, Codex, or anything else with a shell. The
agent reads the setup document and installs it for you.

```text
Read https://omni-scientist.github.io/setup/install.md and install and configure the OmniScientist skill for this agent, following the steps.
```

For the desktop app or the terminal agent, get the line for your machine at
<https://omni-scientist.github.io/>.

## Downloads

| File | What it is |
|---|---|
| `OmniSci-Desktop-Windows-x64.zip`, `OmniSci-Desktop-macOS.zip`, `OmniSci-Desktop-Linux-*.tar.gz` | Desktop workbench |
| `omnisci-CLI-Windows-x64.zip`, `omnisci-CLI-macOS.tar.gz`, `omnisci-CLI-Linux-*.tar.gz` | Terminal agent |
| `omnisci-skill.zip` | Skill, unpack into `~/.claude/skills/` |

Verify with `sha256sum -c SHA256SUMS`.
