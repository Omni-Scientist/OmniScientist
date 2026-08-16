#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
IMAGE=${OMNISCI_IMAGE:-omnisci:test}
ENV_FILE=${OMNISCI_ENV_FILE:-}
# shellcheck disable=SC1091
. "$PROJECT_DIR/bin/credential-env.sh"
RUN_E2E=false
if [ "${1:-}" = "--e2e" ]; then
  RUN_E2E=true
  shift
fi
if [ "$#" -ne 0 ]; then
  echo "用法: $0 [--e2e]" >&2
  exit 64
fi

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

SANDBOX=(
  --read-only --cap-drop=ALL --security-opt=no-new-privileges --pids-limit=1024
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777
  --tmpfs /home/bun:rw,nosuid,nodev,mode=1777
)

docker run --rm --init "${SANDBOX[@]}" \
  -e DEEPSEEK_API -e DEEPSEEK_API_KEY -e ANTHROPIC_API_KEY \
  -e OMNISCI_VISION_PROVIDER -e OMNISCI_VISION_MODEL \
  "$IMAGE" bun run /opt/omnisci/tests/api-smoke.ts
if $RUN_E2E; then
  docker run --rm --init "${SANDBOX[@]}" \
    -e DEEPSEEK_API -e DEEPSEEK_API_KEY -e ANTHROPIC_API_KEY \
    -e OMNISCI_VISION_PROVIDER -e OMNISCI_VISION_MODEL \
    "$IMAGE" bash /opt/omnisci/docker/e2e.sh
fi
