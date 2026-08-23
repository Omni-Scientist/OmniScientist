#!/usr/bin/env bash
# icon-1024.png -> OmniScientist.icns
#
# icon-1024.png is committed. It is the rounded-grey tile with the mark centred on it,
# composed from icon-glyph-1024.png (the bare transparent mark). A fully transparent
# icon reads as unfinished in the Dock, which is why the tile exists.
# Padded to Apple's icon grid (824 of 1024),
# so no SVG rasterizer is needed. Only sips and iconutil are used, both of which
# ship with macOS.
#
#   ./make-icns.sh [out_dir]
#
# NOTE: written on Linux and never executed. Whoever does the macOS packaging
# should run it, fix whatever is wrong, and drop this notice.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SRC="$HERE/icon-1024.png"
OUT="${1:-$HERE}"
SET="$(mktemp -d)/OmniScientist.iconset"

[ -f "$SRC" ] || { echo "missing $SRC" >&2; exit 1; }
command -v iconutil >/dev/null || { echo "iconutil not found: this script only runs on macOS" >&2; exit 1; }

mkdir -p "$SET"
# Every size Apple asks for, base and @2x.
for spec in "16:icon_16x16" "32:icon_16x16@2x" "32:icon_32x32" "64:icon_32x32@2x" \
            "128:icon_128x128" "256:icon_128x128@2x" "256:icon_256x256" "512:icon_256x256@2x" \
            "512:icon_512x512" "1024:icon_512x512@2x"; do
  px="${spec%%:*}"; name="${spec#*:}"
  sips -z "$px" "$px" "$SRC" --out "$SET/$name.png" >/dev/null
done

mkdir -p "$OUT"
iconutil -c icns "$SET" -o "$OUT/OmniScientist.icns"
rm -rf "$(dirname "$SET")"
echo "wrote $OUT/OmniScientist.icns"
