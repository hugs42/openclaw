#!/usr/bin/env bash
set -euo pipefail

LABEL="com.openclaw.chatgpt-pro-bridge"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
TARGET="gui/$(id -u)/$LABEL"

usage() {
  echo "Usage: $0 {start|stop|restart|status|logs}"
}

cmd="${1:-}"
case "$cmd" in
  start)
    if [[ ! -f "$PLIST_PATH" ]]; then
      echo "Missing $PLIST_PATH. Run scripts/setup-bridge-service.sh first."
      exit 1
    fi
    launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || true
    launchctl enable "$TARGET"
    launchctl kickstart -k "$TARGET"
    ;;
  stop)
    launchctl bootout "$TARGET" 2>/dev/null || true
    ;;
  restart)
    launchctl kickstart -k "$TARGET"
    ;;
  status)
    launchctl print "$TARGET"
    ;;
  logs)
    LOG_DIR="$HOME/.openclaw/chatgpt-pro-bridge/logs"
    ls -la "$LOG_DIR" 2>/dev/null || true
    echo "--- tail stdout ---"
    tail -n 80 "$LOG_DIR/supervisor.stdout.log" 2>/dev/null || true
    echo "--- tail stderr ---"
    tail -n 80 "$LOG_DIR/supervisor.stderr.log" 2>/dev/null || true
    ;;
  *)
    usage
    exit 1
    ;;
esac
