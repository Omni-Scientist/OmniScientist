#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "用法: $0 <数据目录> [omnisci 参数...]" >&2
  exit 64
fi

if [ ! -d "$1" ]; then
  echo "数据目录不存在: $1" >&2
  exit 66
fi
DATA_DIR=$(realpath -- "$1")
shift

PROJECT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
IMAGE=${OMNISCI_IMAGE:-omnisci:local}
ENV_FILE=${OMNISCI_ENV_FILE:-}
# shellcheck disable=SC1091
. "$PROJECT_DIR/bin/credential-env.sh"

if [ -z "$ENV_FILE" ]; then
  if [ -f "$HOME/.omnisci/env" ]; then
    ENV_FILE="$HOME/.omnisci/env"
  else
    echo "找不到 API 配置。设置 OMNISCI_ENV_FILE，或创建 ~/.omnisci/env。" >&2
    exit 78
  fi
fi

docker build -f "$PROJECT_DIR/docker/Dockerfile" -t "$IMAGE" "$PROJECT_DIR"

omnisci_load_env_file "$ENV_FILE"
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"

if [ -t 0 ]; then
  TTY=(-it)
else
  TTY=(-i)
fi

SANDBOX=(
  --read-only
  --cap-drop=ALL
  --security-opt=no-new-privileges
  --pids-limit="${OMNISCI_PIDS_LIMIT:-1024}"
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777
  --tmpfs /home/bun:rw,nosuid,nodev,mode=1777
)

if [ "$#" -eq 0 ]; then
  set -- -C /work
fi

exec docker run "${TTY[@]}" "${SANDBOX[@]}" --rm --init \
  -e DEEPSEEK_API -e DEEPSEEK_API_KEY \
  -e ANTHROPIC_API_KEY \
  -e OMNISCI_VISION_PROVIDER -e OMNISCI_VISION_MODEL \
  -v "$DATA_DIR:/work" \
  "$IMAGE" /opt/omnisci/bin/omnisci "$@"
