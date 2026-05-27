#!/usr/bin/env bash
# Run a tsx entrypoint with OneCLI proxy env (for extract and other Fathom API scripts).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/onecli-proxy-env.sh"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"
exec npx --yes tsx "$@"
