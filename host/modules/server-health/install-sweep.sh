#!/usr/bin/env bash
# Install the launchd job that keeps checking while Panel is closed.
#
# Panel has no scheduler, and a background thread inside the app only runs while the app runs —
# which is exactly not when an overnight outage happens. launchd owns the clock instead; the
# sweep writes the same state file the tab reads, so Panel shows what it missed on next launch.
#
#   ./install-sweep.sh            install and start (every 5 minutes)
#   ./install-sweep.sh --uninstall
set -euo pipefail

LABEL="com.appgea.panel.server-health"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
HOST="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/bin/host.py"
LOGDIR="$HOME/.appgeapanel/state/server-health"
INTERVAL="${INTERVAL:-300}"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "removed $LABEL"
  exit 0
fi

mkdir -p "$(dirname "$PLIST")" "$LOGDIR"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string>
    <string>$HOST</string>
    <string>--sweep</string>
  </array>
  <key>StartInterval</key><integer>$INTERVAL</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>$LOGDIR/sweep.log</string>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
PLIST_EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart "gui/$(id -u)/$LABEL"

echo "installed $LABEL — every ${INTERVAL}s"
echo "log: $LOGDIR/sweep.log"
