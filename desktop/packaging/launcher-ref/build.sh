#!/usr/bin/env bash
# Compile the reference launcher into a single self-contained binary.
#
#   ./build.sh --version 0.1.0 --target bun-darwin-arm64 --out dist/omnisci-desktop-darwin-arm64
#
# The frontend build is embedded at compile time, so the result needs no Node,
# no Bun runtime and no node_modules on the target machine.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
WEB="$HERE/../../dist"
VERSION="0.0.0-dev"
TARGET=""
OUT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --web)     WEB="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --target)  TARGET="$2"; shift 2 ;;   # bun-darwin-arm64 | bun-darwin-x64 | bun-windows-x64 | ...
    --out)     OUT="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

command -v bun >/dev/null || { echo "bun is required: https://bun.sh" >&2; exit 1; }

if [ -z "$OUT" ]; then
  suffix="${TARGET#bun-}"
  OUT="$HERE/dist/omnisci-desktop${suffix:+-$suffix}"
fi
mkdir -p "$(dirname "$OUT")"

if [ -d "$WEB" ]; then
  echo "web assets: $WEB"
else
  echo "WARNING: no frontend build at $WEB; the binary will serve the built-in status page only." >&2
  echo "         Run 'bun install && bun run build' in desktop/ first." >&2
fi

bun run "$HERE/tools/gen-assets.ts" --web "$WEB" --out "$HERE/src/assets.gen.ts"

# Windows needs the .exe suffix or the produced file will not run.
case "$TARGET" in
  bun-windows-*) case "$OUT" in *.exe) ;; *) OUT="$OUT.exe" ;; esac ;;
esac

bun build --compile --minify \
  ${TARGET:+--target="$TARGET"} \
  --define "process.env.OMNISCI_DESKTOP_VERSION=\"$VERSION\"" \
  "$HERE/src/main.ts" --outfile "$OUT"

echo "wrote $OUT ($(du -h "$OUT" | cut -f1))"
