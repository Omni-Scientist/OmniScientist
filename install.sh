#!/usr/bin/env sh
# OmniScientist CLI installer.
#
#   curl -fsSL https://omni-scientist.github.io/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/Omni-Scientist/OmniScientist/main/install.sh | sh
#
# Downloads one file. The binary carries the skill inside it, so there is nothing
# to unpack and no directory layout to preserve.
#
#   VERSION=v0.1.0 sh install.sh     pin a release instead of taking the latest
#   BIN_DIR=/usr/local/bin sh ...    install somewhere else
set -eu

REPO="Omni-Scientist/OmniScientist"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
VERSION="${VERSION:-latest}"

say()  { printf '%s\n' "$*"; }
die()  { printf 'omnisci: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "需要 $1，请先安装"; }

need uname
command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || die "需要 curl 或 wget"

fetch() {  # fetch <url> <dest>
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$2" "$1"
  else
    wget -qO "$2" "$1"
  fi
}

os=$(uname -s)
case "$os" in
  Linux)  os=linux ;;
  Darwin) os=darwin ;;
  *) die "这个安装脚本只支持 Linux 和 macOS，你的系统是 $os。Windows 请用 install.ps1" ;;
esac

arch=$(uname -m)
case "$arch" in
  x86_64|amd64) arch=x86_64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) die "没有 $arch 架构的构建。可以从源码编译，见 docs/INSTALL.md" ;;
esac

asset="omnisci-$os-$arch"
if [ "$VERSION" = "latest" ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$VERSION"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

say "下载 $asset ..."
fetch "$base/$asset" "$tmp/omnisci" \
  || die "下载失败。确认 $REPO 有已发布的 release，或用 VERSION=vX.Y.Z 指定一个版本"

# 校验和是可选的：release 里有就核，没有也不拦着装，但要说清楚跳过了
if fetch "$base/$asset.sha256" "$tmp/omnisci.sha256" 2>/dev/null; then
  want=$(awk '{print $1}' "$tmp/omnisci.sha256")
  if command -v sha256sum >/dev/null 2>&1; then
    got=$(sha256sum "$tmp/omnisci" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    got=$(shasum -a 256 "$tmp/omnisci" | awk '{print $1}')
  else
    got=""
  fi
  if [ -n "$got" ] && [ "$got" != "$want" ]; then
    die "校验和不匹配，下载的文件不对，已中止"
  fi
  [ -n "$got" ] && say "校验和通过" || say "本机没有 sha256 工具，跳过校验"
else
  say "这个 release 没带校验和，跳过校验"
fi

chmod 0755 "$tmp/omnisci"

# Apple Silicon 上内核拒绝执行没有签名的可执行文件。ad-hoc 签名免费、不需要账号，
# 跟 Gatekeeper 是两回事：curl 下载的文件本来就不带隔离属性，不会被 Gatekeeper 拦。
if [ "$os" = "darwin" ] && command -v codesign >/dev/null 2>&1; then
  codesign --force --sign - "$tmp/omnisci" >/dev/null 2>&1 || true
fi

mkdir -p "$BIN_DIR"
mv "$tmp/omnisci" "$BIN_DIR/omnisci"

say ""
say "装好了: $BIN_DIR/omnisci"
case ":$PATH:" in
  *":$BIN_DIR:"*) say "直接敲 omnisci 就能用。" ;;
  *) say "注意: $BIN_DIR 不在 PATH 里。加上这一行："
     say "  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
say ""
say "还需要一个 API key，写进 ~/.omnisci/env："
say "  DEEPSEEK_API_KEY=..."
say "  ANTHROPIC_API_KEY=...     # 看图、信号、音视频、三维数据时用到"
say ""
say "出 PDF 还要 python3 和 tectonic，装法见"
say "  https://github.com/$REPO/blob/main/docs/INSTALL.md"
