#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STATE_DIR="$HOME/.openclaw/chatgpt-pro-bridge"
ENV_FILE="$STATE_DIR/bridge.env"
LOG_DIR="$STATE_DIR/logs"
STDOUT_LOG="$LOG_DIR/supervisor.stdout.log"
STDERR_LOG="$LOG_DIR/supervisor.stderr.log"
MIN_RESTART_DELAY_SEC="${BRIDGE_RESTART_DELAY_SEC:-2}"

mkdir -p "$STATE_DIR" "$LOG_DIR"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
fi

: "${BRIDGE_MODE:=http}"
export BRIDGE_MODE

stop_requested=0
child_pid=""

on_stop() {
  stop_requested=1
  if [[ -n "${child_pid:-}" ]]; then
    kill -TERM "$child_pid" 2>/dev/null || true
  fi
}

trap on_stop INT TERM

cd "$ROOT_DIR"

if [[ ! -f "dist/index.js" ]]; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] dist/index.js missing. Run npm run build first." >>"$STDERR_LOG"
  exit 1
fi

while true; do
  if [[ "$stop_requested" -eq 1 ]]; then
    exit 0
  fi

  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] starting bridge process" >>"$STDOUT_LOG"
  node dist/index.js >>"$STDOUT_LOG" 2>>"$STDERR_LOG" &
  child_pid=$!
  # Keep supervisor alive even when child exits non-zero.
  set +e
  wait "$child_pid"
  exit_code=$?
  set -e
  child_pid=""

  if [[ "$stop_requested" -eq 1 ]]; then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] stopped by signal" >>"$STDOUT_LOG"
    exit 0
  fi

  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] bridge exited (code=$exit_code), restarting in ${MIN_RESTART_DELAY_SEC}s" >>"$STDERR_LOG"
  sleep "$MIN_RESTART_DELAY_SEC"
done
