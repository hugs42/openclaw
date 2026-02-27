#!/usr/bin/env bash
set -euo pipefail

LABEL="com.openclaw.chatgpt-pro-bridge"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STATE_DIR="$HOME/.openclaw/chatgpt-pro-bridge"
ENV_FILE="$STATE_DIR/bridge.env"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"

mkdir -p "$STATE_DIR" "$HOME/Library/LaunchAgents"

if [[ ! -f "$ENV_FILE" ]]; then
  seeded_token="change-me"
  seeded_secret="change-me"
  existing_pid="$(pgrep -f "node dist/index.js" | head -n 1 || true)"
  if [[ -n "$existing_pid" ]]; then
    existing_env="$(ps eww -p "$existing_pid" | sed -n '2p' || true)"
    if [[ -n "$existing_env" ]]; then
      token_match="$(printf '%s\n' "$existing_env" | sed -n 's/.*CHATGPT_BRIDGE_TOKEN=\([^ ]*\).*/\1/p')"
      secret_match="$(printf '%s\n' "$existing_env" | sed -n 's/.*MARKER_SECRET=\([^ ]*\).*/\1/p')"
      if [[ -n "$token_match" ]]; then
        seeded_token="$token_match"
      fi
      if [[ -n "$secret_match" ]]; then
        seeded_secret="$secret_match"
      fi
    fi
  fi

  cat >"$ENV_FILE" <<'EOF'
# Bridge runtime environment
BRIDGE_MODE=http
SESSION_BINDING_MODE=off
CHATGPT_BRIDGE_TOKEN=__TOKEN__
MARKER_SECRET=__SECRET__
# Optional long wait tuning:
# MAX_WAIT_SEC=3600
# JOB_TIMEOUT_MS=3615000
EOF
  # Replace placeholders without printing secret values.
  if [[ "$OSTYPE" == darwin* ]]; then
    sed -i '' "s|__TOKEN__|$seeded_token|g" "$ENV_FILE"
    sed -i '' "s|__SECRET__|$seeded_secret|g" "$ENV_FILE"
  else
    sed -i "s|__TOKEN__|$seeded_token|g" "$ENV_FILE"
    sed -i "s|__SECRET__|$seeded_secret|g" "$ENV_FILE"
  fi
  chmod 600 "$ENV_FILE"
  echo "Created $ENV_FILE."
else
  chmod 600 "$ENV_FILE"
fi

cat >"$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>LimitLoadToSessionType</key>
  <array>
    <string>Aqua</string>
  </array>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>cd "$ROOT_DIR" && "$ROOT_DIR/scripts/bridge-supervisor.sh"</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>2</integer>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
launchctl enable "gui/$(id -u)/$LABEL"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "Service installed and started."
echo "Label: $LABEL"
echo "Plist: $PLIST_PATH"
echo "Env:   $ENV_FILE"
echo
echo "Status:"
launchctl print "gui/$(id -u)/$LABEL" | head -n 40
