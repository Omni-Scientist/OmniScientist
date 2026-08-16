# OmniScientist Desktop for macOS

Double-click an icon, a browser opens on the research workbench, a menu-bar item
lets you quit it. The window is a web page served by a local process on
`127.0.0.1`; there is no native GUI and no Electron.

## Install

`curl` does not set the quarantine attribute, so an app installed this way never
meets Gatekeeper:

```bash
curl -fsSL https://github.com/Omni-Scientist/OmniScientist/releases/latest/download/OmniScientist-$(uname -m).tar.gz | tar -xz -C /Applications
open /Applications/OmniScientist.app
```

`uname -m` prints `arm64` on Apple Silicon and `x86_64` on Intel. Verified on
macOS 15.7.7 / Apple Silicon: the app installs and launches with no Gatekeeper
prompt of any kind.

To remove it: drag `/Applications/OmniScientist.app` to the bin, then delete
`~/.omnisci` (settings and logs) and `~/Library/Application Support/OmniScientist`
(the managed Python environment and tectonic, about 500 MB).

### If you downloaded the archive in a browser instead

A browser stamps `com.apple.quarantine` on the download, the Archive Utility
copies it onto the extracted app, and macOS then refuses to open it. What you see
on macOS 15 (exact wording, captured on 15.7.7):

> **未打开"OmniScientist"**
> Apple无法验证"OmniScientist"是否包含可能危害Mac安全或泄漏隐私的恶意软件。
> \[完成\] \[移到废纸篓\]

The old right-click-then-Open trick was removed in macOS 15. Two ways out:

1. One command, which is what we recommend:

   ```bash
   xattr -dr com.apple.quarantine /Applications/OmniScientist.app
   ```

   Verified: after this the app launches normally.

2. Through the UI: **系统设置 → 隐私与安全性**, scroll to the 安全性 section,
   find the line about OmniScientist being blocked, click **仍要打开**, confirm,
   and authenticate. (Not walked end to end during acceptance; the
   wording above comes from Apple's current UI, while the blocked-dialog wording
   further up was captured from a real block.)

Also note: a quarantined app launched from `~/Downloads` runs **translocated** —
macOS mounts a read-only randomised copy under
`/private/var/folders/.../AppTranslocation/`. OmniScientist works fine that way
because it never writes inside its own bundle, but the path in Activity Monitor
will look strange. Moving the app into `/Applications` ends the translocation.

## What gets installed where

| Path | What |
|---|---|
| `/Applications/OmniScientist.app` | the app: menu-bar host plus the service binary |
| `~/OmniScientist` | default workspace, the only user directory it reads and writes |
| `~/.omnisci/env` | API credentials, mode 0600, never anywhere else |
| `~/.omnisci/desktop.lock` | running instance's pid, port and session token, mode 0600 |
| `~/.omnisci/logs/desktop-<date>.log` | logs, with credentials scrubbed |
| `~/Library/Application Support/OmniScientist` | managed Python venv and tectonic, created by the in-app setup |

## First run: dependencies

The app is self-contained, but producing a PDF needs Python packages and
tectonic, which a clean Mac does not have. The workbench offers to install both
into `~/Library/Application Support/OmniScientist`, touching nothing system-wide.

Measured on macOS 15.7.7 / Apple Silicon with Homebrew Python 3.14.5 present:
about 35 seconds, 435 MB of venv and a 52 MB tectonic 0.17.0. On a Mac with no
Python at all, `python3` is a stub that prompts for the Xcode command line tools;
install those (or Python from python.org) first. That case is untested.

## Building it yourself

```bash
cd cli     && bun install                    # the launcher reaches into cli/src through the gateway
cd ../desktop && bun install
bun run build:desktop                        # workbench + service binary -> dist-desktop/omnisci-desktop

cd packaging/macos
./build-app.sh --binary ../../dist-desktop/omnisci-desktop --version 0.1.0 --out dist
```

For the other architecture, or to build both from one machine:

```bash
cd desktop && bun run build:assets
bun build --compile --minify --target=bun-darwin-x64 launcher/main.ts \
  --outfile dist-desktop/omnisci-desktop-darwin-x64
```

That produces `dist/OmniScientist.app` and `dist/OmniScientist-0.1.0-arm64.tar.gz`.
Requirements: bun, and the Xcode command line tools for `swiftc`, `codesign`,
`sips` and `iconutil`. No Homebrew packages, no CocoaPods, no Xcode project.

Two architectures are built separately. `--universal` merges an arm64 and an
x86_64 service binary with `lipo` into one bundle (verified to keep the payload
Bun appends to its compiled binaries), at the cost of roughly doubling the
download, so per-architecture tarballs are the default.

Signing is ad-hoc by default (`codesign --sign -`), which is what makes the
binaries runnable on Apple Silicon at all and has nothing to do with Gatekeeper.
Set `CODESIGN_IDENTITY` to a Developer ID to sign for real; the script then adds
the hardened runtime, a timestamp and `entitlements.plist`.

## Layout of this directory

| File | What |
|---|---|
| `host/main.swift` | the menu-bar host, AppKit, no dependencies |
| `build-app.sh` | assemble, sign, package, and verify the result |
| `make-icns.sh` | `icon-1024.png` to `OmniScientist.icns`, runs as-is on macOS |
| `Info.plist.in` | bundle template; the build script injects the version |
| `entitlements.plist` | only used when signing with a real Developer ID |
