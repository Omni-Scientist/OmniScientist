#!/usr/bin/env bash
# Assemble, sign and package OmniScientist.app from a compiled omnisci-desktop
# binary.
#
#   ./build-app.sh --binary path/to/omnisci-desktop-darwin-arm64 --version 0.1.0 --out dist/
#     -> dist/OmniScientist.app
#        dist/OmniSci-Desktop-macOS.zip
#
#   ./build-app.sh --binary <arm64> --binary-x64 <x64> --universal --version 0.1.0
#     -> one bundle that runs on both, at roughly twice the size.
#
# The menu-bar host is compiled here from host/main.swift; nothing but the Xcode
# command line tools is required. Signing is ad-hoc by default, which is what
# makes the binaries runnable on Apple Silicon at all; set CODESIGN_IDENTITY to
# a Developer ID to sign for real. No certificate detail ever lives in this file.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BINARY="" BINARY_X64="" VERSION="0.0.0" OUT="$HERE/dist" HOST="" UNIVERSAL=0 SKIP_ARCHIVE=0
MIN_MACOS="12.0"

while [ $# -gt 0 ]; do
  case "$1" in
    --binary)     BINARY="$2"; shift 2 ;;
    --binary-x64) BINARY_X64="$2"; shift 2 ;;
    --version)    VERSION="$2"; shift 2 ;;
    --out)        OUT="$2"; shift 2 ;;
    --host)       HOST="$2"; shift 2 ;;   # prebuilt menu-bar host, otherwise compiled here
    --universal)  UNIVERSAL=1; shift ;;
    --no-tar|--no-archive) SKIP_ARCHIVE=1; shift ;;   # --no-tar kept: it predates the switch to zip
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

[ -n "$BINARY" ] || { echo "--binary is required" >&2; exit 1; }
[ -f "$BINARY" ] || { echo "no such binary: $BINARY" >&2; exit 1; }
[ "$(uname -s)" = "Darwin" ] || { echo "this script only runs on macOS" >&2; exit 1; }
command -v codesign >/dev/null || { echo "codesign not found: install the Xcode command line tools" >&2; exit 1; }

BINARY=$(cd "$(dirname "$BINARY")" && pwd)/$(basename "$BINARY")
[ -n "$BINARY_X64" ] && BINARY_X64=$(cd "$(dirname "$BINARY_X64")" && pwd)/$(basename "$BINARY_X64")
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)

# ---------------------------------------------------------------- architecture
# The bundle's architecture comes from the service binary: the host must match
# it, or the .app will not launch on the machine the service was built for.
archs_of() { lipo -archs "$1" 2>/dev/null || echo unknown; }

if [ "$UNIVERSAL" = "1" ]; then
  [ -n "$BINARY_X64" ] || { echo "--universal needs --binary-x64 as well" >&2; exit 1; }
  ARCH_LABEL="universal"
  SWIFT_TARGETS="arm64 x86_64"
else
  ARCH_LABEL=$(archs_of "$BINARY" | awk '{print $1}')
  case "$ARCH_LABEL" in
    arm64|x86_64) ;;
    *) echo "cannot tell the architecture of $BINARY (got '$ARCH_LABEL')" >&2; exit 1 ;;
  esac
  SWIFT_TARGETS="$ARCH_LABEL"
fi
echo "architecture: $ARCH_LABEL"

# ------------------------------------------------------------------- host build
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

if [ -z "$HOST" ]; then
  command -v swiftc >/dev/null || { echo "swiftc not found: install the Xcode command line tools" >&2; exit 1; }
  SLICES=""
  for arch in $SWIFT_TARGETS; do
    echo "compiling the menu-bar host for $arch"
    swiftc -O -target "${arch}-apple-macos${MIN_MACOS}" \
           -o "$STAGE/host-$arch" "$HERE/host/main.swift"
    SLICES="$SLICES $STAGE/host-$arch"
  done
  # shellcheck disable=SC2086
  if [ "$(echo $SLICES | wc -w)" -gt 1 ]; then
    lipo -create $SLICES -output "$STAGE/OmniScientist"
  else
    cp $SLICES "$STAGE/OmniScientist"
  fi
  HOST="$STAGE/OmniScientist"
fi

# ------------------------------------------------------------------ service bin
if [ "$UNIVERSAL" = "1" ]; then
  # lipo keeps the payload Bun appends to the executable; verified on
  # bun 1.3.11 by running the merged binary.
  lipo -create "$BINARY" "$BINARY_X64" -output "$STAGE/omnisci-desktop"
  SERVICE="$STAGE/omnisci-desktop"
else
  SERVICE="$BINARY"
fi

# ---------------------------------------------------------------------- bundle
APP="$OUT/OmniScientist.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

install -m 0755 "$SERVICE" "$APP/Contents/MacOS/omnisci-desktop"
install -m 0755 "$HOST" "$APP/Contents/MacOS/OmniScientist"

# CFBundleVersion must increase monotonically across builds; a bare tag does not,
# so append the commit count when there is a git checkout.
BUILD="$VERSION"
if git -C "$HERE" rev-parse --git-dir >/dev/null 2>&1; then
  BUILD="$VERSION.$(git -C "$HERE" rev-list --count HEAD)"
fi
sed -e "s/@VERSION@/$VERSION/g" -e "s/@BUILD@/$BUILD/g" \
    "$HERE/Info.plist.in" > "$APP/Contents/Info.plist"

if [ -f "$HERE/OmniScientist.icns" ]; then
  cp "$HERE/OmniScientist.icns" "$APP/Contents/Resources/"
else
  "$HERE/make-icns.sh" "$APP/Contents/Resources"
fi

# 菜单栏用的是不带灰底的纯标记：18 点的地方摆一块圆角灰砖既拥挤又跟系统图标不搭。
# Dock 用带底的那张（透明图标在 Dock 里像没做完），两处素材同源不同用。
cp "$HERE/icon-glyph-1024.png" "$APP/Contents/Resources/StatusIcon.png"

# ---------------------------------------------------------------------- signing
# Apple Silicon refuses to execute an unsigned binary, so ad-hoc signing is not
# optional. It is also unrelated to Gatekeeper: see the desktop service contract (5.0).
IDENTITY="${CODESIGN_IDENTITY:--}"
SIGN_EXTRA=()
if [ "$IDENTITY" != "-" ]; then
  # Real identity: hardened runtime and a timestamp, which notarization requires.
  SIGN_EXTRA=(--options runtime --timestamp --entitlements "$HERE/entitlements.plist")
  echo "signing with a Developer ID identity from CODESIGN_IDENTITY"
else
  echo "signing ad-hoc (no Developer ID)"
fi

# Inner binaries first, bundle last: signing the bundle seals whatever the
# inner signatures are at that moment.
codesign --force --sign "$IDENTITY" "${SIGN_EXTRA[@]+"${SIGN_EXTRA[@]}"}" "$APP/Contents/MacOS/omnisci-desktop"
codesign --force --sign "$IDENTITY" "${SIGN_EXTRA[@]+"${SIGN_EXTRA[@]}"}" "$APP/Contents/MacOS/OmniScientist"
codesign --force --sign "$IDENTITY" "${SIGN_EXTRA[@]+"${SIGN_EXTRA[@]}"}" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP" 2>&1 | sed 's/^/  /'

echo "wrote $APP"

# -------------------------------------------------------------------- archive
if [ "$SKIP_ARCHIVE" = "1" ]; then
  exit 0
fi

# zip, not tar.gz: a .app is what macOS users expect to double-click, and zip is
# what Apple's own docs hand out for one. ditto is the only packer that reliably
# keeps a bundle's signature and resource forks intact; plain `zip` happens to work
# too, but ditto is the documented path, so use it.
#
# The name carries neither version nor architecture on purpose. Every asset in the
# release is named this way so that releases/latest/download/<name> stays a link
# that never has to be edited. Only arm64 is built (decided 2026-08-18), so there
# is nothing for an architecture suffix to disambiguate.
ARCHIVE="$OUT/OmniSci-Desktop-macOS.zip"
rm -f "$ARCHIVE"
( cd "$OUT" && ditto -c -k --keepParent OmniScientist.app "$ARCHIVE" )

# The archive is the artefact users actually run, so verify the signature after a
# round trip rather than trusting that the packer preserved everything.
CHECK=$(mktemp -d)
ditto -x -k "$ARCHIVE" "$CHECK"
if codesign --verify --deep --strict --verbose=2 "$CHECK/OmniScientist.app" 2>&1 | sed 's/^/  /'; then
  echo "signature survives the zip round trip"
else
  echo "FAILED: the signature does not survive packing" >&2
  rm -rf "$CHECK"
  exit 1
fi
for binary in omnisci-desktop OmniScientist; do
  [ -x "$CHECK/OmniScientist.app/Contents/MacOS/$binary" ] || {
    echo "FAILED: $binary lost its executable bit in the archive" >&2
    rm -rf "$CHECK"
    exit 1
  }
done
rm -rf "$CHECK"

echo "wrote $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"
