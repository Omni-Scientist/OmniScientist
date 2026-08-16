#!/usr/bin/env bash
# Install OmniScientist Desktop for the current user. No root, no system directories.
#
#   ./install.sh              install into ~/.local
#   ./install.sh --uninstall  remove everything this script created
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PREFIX="${PREFIX:-$HOME/.local}"
BIN_DIR="$PREFIX/bin"
APP_DIR="$PREFIX/share/applications"
ICON_DIR="$PREFIX/share/icons/hicolor/512x512/apps"
BIN="$BIN_DIR/omnisci-desktop"
ENTRY="$APP_DIR/omniscientist.desktop"
ICON="$ICON_DIR/omniscientist.png"

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$BIN" "$ENTRY" "$ICON"
  command -v update-desktop-database >/dev/null && update-desktop-database "$APP_DIR" 2>/dev/null || true
  echo "已卸载。~/.omnisci 和工作区目录保留，要一起清就自己删。"
  exit 0
fi

[ -f "$HERE/omnisci-desktop" ] || { echo "同目录下找不到 omnisci-desktop" >&2; exit 1; }

mkdir -p "$BIN_DIR" "$APP_DIR" "$ICON_DIR"
install -m 0755 "$HERE/omnisci-desktop" "$BIN"
install -m 0644 "$HERE/icon.png" "$ICON"
sed "s|@BIN@|$BIN|g" "$HERE/omniscientist.desktop.in" > "$ENTRY"
chmod 0644 "$ENTRY"

command -v update-desktop-database >/dev/null && update-desktop-database "$APP_DIR" 2>/dev/null || true
command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -f -t "$PREFIX/share/icons/hicolor" 2>/dev/null || true

echo "装好了。"
echo "  应用菜单里搜 OmniScientist，或者直接跑 $BIN"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "  提示：$BIN_DIR 不在 PATH 里，命令行调用要写全路径" ;;
esac
