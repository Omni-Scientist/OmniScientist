#!/usr/bin/env bash
# Package the compiled launcher into a tarball a user can unpack and install.
#
#   ./build-linux.sh --binary ../../dist-desktop/omnisci-desktop --version 0.1.0 --out dist/
#
# Produces dist/OmniSci-Desktop-Linux-<arch>.tar.gz containing the binary,
# the desktop entry, the icon and install.sh.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BINARY="" VERSION="0.0.0" OUT="$HERE/dist" ARCH=""

while [ $# -gt 0 ]; do
  case "$1" in
    --binary)  BINARY="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --out)     OUT="$2"; shift 2 ;;
    --arch)    ARCH="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

[ -n "$BINARY" ] || { echo "--binary is required" >&2; exit 1; }
[ -f "$BINARY" ] || { echo "no such binary: $BINARY" >&2; exit 1; }
[ -n "$ARCH" ] || ARCH=$(uname -m)

NAME="OmniSci-Desktop-Linux-$ARCH"
STAGE=$(mktemp -d)/$NAME
mkdir -p "$STAGE" "$OUT"

install -m 0755 "$BINARY" "$STAGE/omnisci-desktop"
install -m 0755 "$HERE/install.sh" "$STAGE/install.sh"
install -m 0644 "$HERE/omniscientist.desktop.in" "$STAGE/omniscientist.desktop.in"
install -m 0644 "$HERE/../macos/icon-1024.png" "$STAGE/icon.png"

cat > "$STAGE/README.txt" <<EOF
OmniScientist Desktop $VERSION ($ARCH)

安装（不需要 root）：

    ./install.sh

装完在应用菜单里搜 OmniScientist，点开会自动打开浏览器。
也可以不安装，直接跑：

    ./omnisci-desktop

卸载：

    ./install.sh --uninstall

第一次运行还需要 Python 3.10+ 和 tectonic 才能出 PDF。界面上会检测并引导安装，
装在 ~/.local/share/omniscientist 下，不动系统环境。

API key 写在 ~/.omnisci/env，每行 KEY=VALUE：

    DEEPSEEK_API_KEY=...
    ANTHROPIC_API_KEY=...
EOF

tar -czf "$OUT/$NAME.tar.gz" -C "$(dirname "$STAGE")" "$NAME"
rm -rf "$(dirname "$STAGE")"

( cd "$OUT" && sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256" )
echo "wrote $OUT/$NAME.tar.gz"
