#!/usr/bin/env bash
set -euo pipefail

mkdir -p "$HOME/.omnisci"
# shellcheck disable=SC1091
. /opt/omnisci/bin/credential-env.sh
omnisci_seal_credentials
exec "$@"
