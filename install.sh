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

# The CLI edition is discontinued (2026-09-02). The desktop app and the Claude
# Code skill are the supported editions; releases stopped carrying CLI binaries,
# so this script now says so plainly instead of handing you a 404.
echo "The OmniScientist CLI has been discontinued." >&2
echo "Get the desktop app or the Claude Code skill instead:" >&2
echo "  https://github.com/Omni-Scientist/OmniScientist/releases/latest" >&2
exit 1

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
  *) die "这个安装脚本只支持 Linux 和 macOS，你的系统是 ${os}。Windows 请用 install.ps1" ;;
esac

arch=$(uname -m)
case "$arch" in
  x86_64|amd64) arch=x86_64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) die "没有 $arch 架构的构建。可以从源码编译，见 docs/INSTALL.md" ;;
esac

# 名字跟 release.yml 的产物名、assetPatternFor() 是同一套：一律不带版本号
# （这样 latest/download 是永远有效的链接），一律用人话不用 uname 的黑话。
# check_parity.py 会盯着这三处别漂。
if [ "$os" = "darwin" ]; then
  # Intel Mac 不发（决定于 2026-08-18）。以前这里会去下一个不存在的名字拿 404，
  # 改名之后所有 Mac 都会命中同一个包，那是个 arm64 的二进制，装上也跑不了，
  # 所以在这儿就说清楚，别让人装完才发现。
  [ "$arch" = "arm64" ] || die "Intel Mac 没有预编译版本，只发 Apple 芯片（M1 及以后）。可以从源码编译，见 docs/INSTALL.md"
  asset="omnisci-CLI-macOS.tar.gz"
elif [ "$arch" = "arm64" ]; then
  asset="omnisci-CLI-Linux-ARM64.tar.gz"
else
  asset="omnisci-CLI-Linux-x64.tar.gz"
fi

if [ "$VERSION" = "latest" ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$VERSION"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

say "下载 $asset ..."
fetch "$base/$asset" "$tmp/$asset" \
  || die "下载失败。确认 $REPO 有已发布的 release，或用 VERSION=vX.Y.Z 指定一个版本"

# 校验和是可选的：release 里有就核，没有也不拦着装，但要说清楚跳过了。
# 全部产物的校验和都在同一个 SHA256SUMS 里（以前是每个产物旁边挂一个 .sha256，
# release 列表被撑成两倍长）。第二列可能带 * 前缀，那是 sha256sum 的二进制模式。
if fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" 2>/dev/null; then
  want=$(awk -v want="$asset" '{ name = $2; sub(/^\*/, "", name); if (name == want) { print $1; exit } }' \
           "$tmp/SHA256SUMS")
  if command -v sha256sum >/dev/null 2>&1; then
    got=$(sha256sum "$tmp/$asset" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    got=$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')
  else
    got=""
  fi
  if [ -z "$want" ]; then
    # 必须写成 ${asset}：紧跟着的全角逗号是多字节，bash 3.2（macOS 自带那个）会把它
    # 当成变量名的一部分，set -u 下直接崩成 "unbound variable"。
    say "SHA256SUMS 里没有 ${asset}，跳过校验"
  elif [ -z "$got" ]; then
    say "本机没有 sha256 工具，跳过校验"
  elif [ "$got" != "$want" ]; then
    die "校验和不匹配，下载的文件不对，已中止"
  else
    say "校验和通过"
  fi
else
  say "这个 release 没带校验和，跳过校验"
fi

# 以前挂上去的是裸二进制，直接就是要装的那个文件。现在是 tar.gz：100MB 不压缩
# 太浪费，而且一个没有扩展名的文件谁也不知道该拿它怎么办（omnisci-darwin-arm64
# 在 v0.1.5 只被下载了 3 次，全场垫底）。**先验校验和再解包**，顺序不能反。
tar -xzf "$tmp/$asset" -C "$tmp" || die "解压失败，下载的包可能不完整"
[ -f "$tmp/omnisci" ] || die "包里没有 omnisci，release 的产物可能不对"

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
