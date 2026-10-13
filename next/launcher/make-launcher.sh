#!/bin/zsh
# Builds "Appgea Panel.app" — a real macOS app that launches Panel dev mode.
#
# Why an .app and not a .command: an app has the Panel icon, lives in the Dock, opens with a
# single click and no Terminal window. The launcher itself is invisible (LSUIElement) — the
# only Dock presence you see is Panel itself once it's up. Logs go to
# ~/Library/Logs/appgea-panel.log; opening the app while Panel is running just focuses it.
#
#   ./make-launcher.sh                 -> builds onto the Desktop
#   ./make-launcher.sh /Applications   -> builds into /Applications
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$HOME/Desktop}"
APP="$DEST/Appgea Panel.app"
ICON="$ROOT/apps/desktop/src-tauri/icons/icon.icns"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Appgea Panel</string>
  <key>CFBundleDisplayName</key><string>Appgea Panel</string>
  <!-- TCC identifies ad-hoc-signed apps by PATH, and an ad-hoc re-sign at the same path turns
       the stale record into a SILENT deny. If Desktop access stops working after a rebuild,
       build to a fresh path (or bump this suffix AND move the app) to get the prompt again. -->
  <key>CFBundleIdentifier</key><string>com.appgea.panel.launcher.g2</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>panel-launcher</string>
  <key>CFBundleIconFile</key><string>icon.icns</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

# The ROOT path is baked in at build time so the app works from anywhere (Desktop, Dock,
# /Applications) without guessing where the repo lives.
cat > "$APP/Contents/MacOS/panel-launcher" <<LAUNCH
#!/bin/zsh
ROOT="$ROOT"
LOG="\$HOME/Library/Logs/appgea-panel.log"
export PATH="\$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:\$PATH"

# Panel already up? One Panel is the rule — just bring it forward.
if pgrep -f "target/debug/appgea-panel-desktop" >/dev/null 2>&1; then
  osascript -e 'tell application "Appgea Panel" to activate' >/dev/null 2>&1 || true
  exit 0
fi

osascript -e 'display notification "Igniting — the window opens when the build lands." with title "Appgea Panel"' >/dev/null 2>&1 || true

{
  echo "=== \$(date) launching Appgea Panel ==="
  if [[ ! -d "\$ROOT/apps/desktop/ui/node_modules" ]]; then
    npm install --prefix "\$ROOT/apps/desktop/ui"
  fi
  # MUST run from src-tauri: the tauri CLI resolves beforeDevCommand's cwd relative to where
  # it is invoked, and only this directory makes "npm --prefix ui" land on apps/desktop/ui.
  cd "\$ROOT/apps/desktop/src-tauri"
  cargo tauri dev
  rc=\$?   # NOT "status" — that name is read-only in zsh
  # A dev session you quit normally exits 0. Anything else died before or during boot — say so
  # out loud instead of leaving a log-only death that reads as "Panel is frozen".
  if [[ \$rc -ne 0 ]]; then
    reason="\$(tail -n 3 "\$LOG" | tr '"' "'" )"
    osascript -e "display alert \\"Appgea Panel failed to start\\" message \\"\$reason\\n\\nFull log: ~/Library/Logs/appgea-panel.log\\" as critical" >/dev/null 2>&1 || true
  fi
} >>"\$LOG" 2>&1
LAUNCH
chmod +x "$APP/Contents/MacOS/panel-launcher"

if [[ -f "$ICON" ]]; then
  cp "$ICON" "$APP/Contents/Resources/icon.icns"
else
  echo "warning: icon not found at $ICON — the app will wear the generic icon"
fi

# Ad-hoc signature: without a code identity, macOS privacy (TCC) silently refuses the app
# access to the Desktop folder the repo lives in — WITH one, the first launch shows a proper
# "allow access to Desktop?" prompt and the answer is remembered.
codesign --force --deep -s - "$APP" 2>/dev/null || echo "warning: codesign failed — first launch may be blocked by privacy settings"

# A rebuilt bundle can keep showing a stale icon until Finder's cache lets go.
touch "$APP"
echo "built: $APP"
