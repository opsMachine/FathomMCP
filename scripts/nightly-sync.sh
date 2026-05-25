#!/usr/bin/env bash
# Nightly Fathom KB sync: extract -> transform -> embed.
#
# Safe to run manually as well as from a systemd timer or cron entry.
# A flock guards against overlapping runs (e.g. timer firing while a
# manual `npm run sync:nightly` is mid-flight).
#
# Stdout/stderr are tee'd to <data-root>/data/logs/sync-YYYY-MM-DD.log AND
# to the parent process so journald (or your terminal) still sees everything.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Make node + tsx available when invoked from a non-interactive shell
# (systemd user services don't source ~/.zshrc).
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1090,SC1091
  . "$NVM_DIR/nvm.sh" >/dev/null
fi

# Mirror the convention from src/lib/paths.ts: corpus lives under
# $FATHOM_DATA_ROOT (defaults to the FathomMCP repo root for back-compat).
DATA_ROOT="${FATHOM_DATA_ROOT:-$REPO_ROOT}"

LOCK_DIR="$DATA_ROOT/data"
LOCK_FILE="$LOCK_DIR/.sync.lock"
mkdir -p "$LOCK_DIR"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[$(date -Iseconds)] another sync is already running ($LOCK_FILE) -- exiting"
  exit 0
fi

LOG_DIR="$DATA_ROOT/data/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/sync-$(date +%Y-%m-%d).log"

# Mirror everything from here on into the daily log file too.
exec > >(tee -a "$LOG_FILE") 2>&1

ts() { date -Iseconds; }

run_step() {
  local name="$1"; shift
  local start
  start=$(date +%s)
  echo "[$(ts)] ==> $name"
  if "$@"; then
    local elapsed=$(( $(date +%s) - start ))
    echo "[$(ts)] <== $name OK (${elapsed}s)"
  else
    local rc=$?
    echo "[$(ts)] <== $name FAILED (exit $rc)"
    exit "$rc"
  fi
}

echo "[$(ts)] === Fathom nightly sync starting (node=$(node --version 2>/dev/null || echo missing)) ==="

run_step "extract"   npm run --silent extract
run_step "transform" npm run --silent transform
run_step "embed"     npm run --silent embed

# Hygiene: keep only the last 30 daily logs.
find "$LOG_DIR" -maxdepth 1 -type f -name 'sync-*.log' -mtime +30 -delete 2>/dev/null || true

echo "[$(ts)] === Fathom nightly sync done ==="
