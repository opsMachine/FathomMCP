#!/usr/bin/env bash
# Export proxy env for Fathom REST API calls through OneCLI.
# Requires: ONECLI_AGENT_ACCESS_TOKEN, gateway on ONECLI_GATEWAY (default :10255),
# vault secret placeholder "Fathom" for host api.fathom.ai (header X-Api-Key).
#
# Usage: source scripts/onecli-proxy-env.sh   # then npm run extract / tsx ...
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT/.env"
  set +a
fi

GATEWAY="${ONECLI_GATEWAY:-http://127.0.0.1:10255}"
TOKEN="${ONECLI_AGENT_ACCESS_TOKEN:-}"

if [ -z "$TOKEN" ]; then
  echo "onecli-proxy-env: set ONECLI_AGENT_ACCESS_TOKEN in $REPO_ROOT/.env" >&2
  echo "  (copy from OM-Repo .cursor/mcp.json fathom env, or OneCLI dashboard)" >&2
  exit 1
fi

# Token embedded in proxy URL (basic auth) — how OneCLI expects it
# Use the aoc_ prefix token (from /api/agents response), not the oc_ management token
AOC_TOKEN="${ONECLI_AOC_TOKEN:-${ONECLI_AGENT_ACCESS_TOKEN}}"
PROXY_URL="http://x:${AOC_TOKEN}@${GATEWAY#http://}"
export HTTP_PROXY="$PROXY_URL"
export HTTPS_PROXY="$PROXY_URL"
export http_proxy="$PROXY_URL"
export https_proxy="$PROXY_URL"
export NO_PROXY="${NO_PROXY:-localhost,127.0.0.1}"
export NODE_USE_ENV_PROXY=1
export GIT_HTTP_PROXY_AUTHMETHOD=basic
export FATHOM_API_KEY="${FATHOM_API_KEY:-Fathom}"

# OneCLI CA cert — enables MITM mode so the gateway can inject headers.
# Must be trusted for the TARGET connection (NODE_EXTRA_CA_CERTS for Node;
# --cacert for curl). Without it, gateway falls back to plain tunnel mode
# and cannot inject the real API key.
ONECLI_CA="${ONECLI_CA:-$HOME/.onecli/gateway-ca.pem}"
if [ -f "$ONECLI_CA" ]; then
  export NODE_EXTRA_CA_CERTS="$ONECLI_CA"
  export ONECLI_CA
else
  echo "onecli-proxy-env: CA cert not found at $ONECLI_CA" >&2
  echo "  Fix: docker cp onecli:/app/data/gateway/ca.pem ~/.onecli/gateway-ca.pem" >&2
  exit 1
fi

if [ "$FATHOM_API_KEY" != "Fathom" ]; then
  echo "onecli-proxy-env: FATHOM_API_KEY should be placeholder 'Fathom' (real key lives in OneCLI vault)" >&2
  exit 1
fi
