#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
IMAGE=${OMNISCI_IMAGE:-omnisci:test}
SANDBOX=(
  --read-only --cap-drop=ALL --security-opt=no-new-privileges --pids-limit=1024
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777
  --tmpfs /home/bun:rw,nosuid,nodev,mode=1777
)

docker build -f "$PROJECT_DIR/docker/Dockerfile" -t "$IMAGE" "$PROJECT_DIR"
docker run --rm --init "${SANDBOX[@]}" -e DEEPSEEK_API_KEY=omnisci-credential-sentinel \
  "$IMAGE" bun run /opt/omnisci/tests/credential-smoke.ts
docker run --rm --init "${SANDBOX[@]}" "$IMAGE" bash /opt/omnisci/tests/env-loader-smoke.sh
docker run --rm --init "$IMAGE" bash -lc \
  'cd /opt/omnisci && bun run typecheck && bun test && bun run build && ./dist/omnisci --help'
docker run --rm --init "${SANDBOX[@]}" "$IMAGE" python3 /opt/omnisci/tests/integrity_test.py
docker run --rm --init "${SANDBOX[@]}" "$IMAGE" bash /opt/omnisci/docker/smoke.sh
