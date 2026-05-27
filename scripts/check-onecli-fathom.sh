#!/usr/bin/env bash
# Quick health check: OneCLI gateway + Fathom secret wiring for extract.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/onecli-proxy-env.sh"

echo "OneCLI gateway: ${ONECLI_GATEWAY}"
# CONNECT-tunnel probe: any HTTPS request reveals if the proxy accepts the agent token
probe=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 5 \
  -x "$ONECLI_GATEWAY" \
  -H "Proxy-Authorization: Bearer ${ONECLI_AGENT_ACCESS_TOKEN}" \
  "https://example.com/" 2>&1 || true)
case "$probe" in
  200|301|302|404) echo "  gateway: reachable, agent token accepted" ;;
  407) echo "  gateway: reachable but agent token REJECTED (407) — check ONECLI_AGENT_ACCESS_TOKEN" ;;
  000) echo "  gateway: NOT reachable on ${ONECLI_GATEWAY} (run onecliStart)" ;;
  *)   echo "  gateway: reachable, probe HTTP $probe" ;;
esac

AOC_TOKEN="${ONECLI_AOC_TOKEN:-${ONECLI_AGENT_ACCESS_TOKEN}}"
PROXY_URL="http://x:${AOC_TOKEN}@${ONECLI_GATEWAY#http://}"
code=$(curl -sS -o /dev/null -w "%{http_code}" \
  --proxy "$PROXY_URL" \
  --cacert "${ONECLI_CA:-$HOME/.onecli/gateway-ca.pem}" \
  -H "X-Api-Key: Fathom" \
  "https://api.fathom.ai/external/v1/meetings?include_transcript=false&include_summary=false")

echo "Fathom via proxy (X-Api-Key: Fathom): HTTP $code"
case "$code" in
  200) echo "  OK — extract should work." ;;
  401) echo "  Fix in OneCLI dashboard (http://127.0.0.1:10254):" 
       echo "    1. Secrets → Fathom → paste your ROTATED key from fathom.video/settings/integrations"
       echo "    2. Host: api.fathom.ai | Header: X-Api-Key | valueFormat: {value} (NOT Bearer {value})"
       echo "    3. Agent has access to this secret"
       ;;
  503) echo "  Fathom API may be degraded — retry later." ;;
  *) echo "  Unexpected — check agent token and secret host pattern." ;;
esac
