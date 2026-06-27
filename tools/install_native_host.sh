#!/bin/bash
# Register the whisper native messaging host for Chrome/Edge on macOS.
# Run once:  bash tools/install_native_host.sh

set -e

EXT_ID="iopnknedfgdjmmgjjhglmngfhkpefdgk"

HOST_JSON="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.tmg.whisper.json"
HOST_JSON_EDGE="$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.tmg.whisper.json"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PYTHON="/usr/bin/env python3"

mkdir -p "$(dirname "$HOST_JSON")"
mkdir -p "$(dirname "$HOST_JSON_EDGE")"

tee "$HOST_JSON" > /dev/null <<EOF
{
  "name": "com.tmg.whisper",
  "description": "Whisper transcription via native messaging",
  "path": "$SCRIPT_DIR/whisper_host.py",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXT_ID/"
  ]
}
EOF

chmod +x "$SCRIPT_DIR/whisper_host.py"
cp "$HOST_JSON" "$HOST_JSON_EDGE"
echo "Installed. Chrome: $HOST_JSON"
echo "          Edge:    $HOST_JSON_EDGE"
