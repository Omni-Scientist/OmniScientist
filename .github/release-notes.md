## Install

**Desktop app**
[⬇ Windows installer](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/OmniSci-Desktop-Windows-x64-setup.exe) ·
[⬇ macOS (Apple silicon)](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/OmniSci-Desktop-macOS.zip) ·
[⬇ Linux (.deb)](https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/OmniSci-Desktop-Linux-x64.deb)

For the terminal agent or the skill, paste this into Claude Code, Cursor, Codex,
or anything else with a shell. The agent reads the setup document and installs
it for you.

```text
Read https://omni-scientist.github.io/setup/install.md and install and configure the OmniScientist skill for this agent, following the steps.
```

More options at <https://omni-scientist.github.io/>.

## Downloads

| File | What it is |
|---|---|
| `OmniSci-Desktop-Windows-x64-setup.exe` | Desktop app, Windows installer |
| `OmniSci-Desktop-macOS.zip` | Desktop app, macOS (Apple silicon) |
| `OmniSci-Desktop-Linux-x64.deb` | Desktop app, Ubuntu/Debian package |
| `omnisci-CLI-*.tar.gz`, `omnisci-CLI-Windows-x64.zip` | Terminal agent |
| `omnisci-skill.zip` | Skill, unpack into `~/.claude/skills/` |

Verify with `sha256sum -c SHA256SUMS`.
