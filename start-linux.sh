#!/usr/bin/env bash
cd "$(dirname "$0")" || exit 1

# Start server
python3 local_server.py &
SERVER_PID=$!

# Kill server when script exits
cleanup() {
  kill $SERVER_PID 2>/dev/null
}
trap cleanup EXIT

# Launch Firefox (blocking)
mkdir -p "$HOME/.local/share/doom-entryway-firefox-profile"

XAPP_FORCE_GTKWINDOW_ICON="/home/damee/.local/share/icons/doom-entryway.png" \
firefox \
  --class DoomEntryway \
  --name DoomEntryway \
  --profile "$HOME/.local/share/doom-entryway-firefox-profile" \
  --no-remote \
  --new-window \
  "http://localhost:8000"

# When Firefox closes → script continues → trap fires → server killed
