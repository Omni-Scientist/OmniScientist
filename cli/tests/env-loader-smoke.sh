#!/usr/bin/env bash
set -euo pipefail

# shellcheck disable=SC1091
. /opt/omnisci/bin/credential-env.sh

CASE_DIR=$(mktemp -d)
ENV_FILE="$CASE_DIR/env"
MARKER="$CASE_DIR/executed"

cat > "$ENV_FILE" <<EOF
# literal dotenv values only
export DEEPSEEK_API=deepseek-fixture
ANTHROPIC_API_KEY="anthropic fixture"
OPENAI_API_KEY=\$(touch "$MARKER")
OMNISCI_VISION_MODEL=fixture-model
EOF

omnisci_load_env_file "$ENV_FILE"
test "$DEEPSEEK_API" = "deepseek-fixture"
test "$ANTHROPIC_API_KEY" = "anthropic fixture"
test "$OMNISCI_VISION_MODEL" = "fixture-model"
test ! -e "$MARKER"
test -z "${OPENAI_API_KEY:-}"

printf '%s\n' 'touch /tmp/omnisci-env-loader-must-not-run' > "$CASE_DIR/invalid"
if omnisci_load_env_file "$CASE_DIR/invalid"; then
  echo "invalid env statement was accepted" >&2
  exit 1
fi
test ! -e /tmp/omnisci-env-loader-must-not-run

echo "OmniScientist strict env loader smoke passed"
