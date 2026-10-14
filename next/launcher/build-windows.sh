#!/bin/bash
# Builds Appgea Panel on Windows, from Git Bash. The Windows counterpart of build-app.sh: same
# staging and UI steps, then an NSIS installer instead of a signed .app.
#
#   ./launcher/build-windows.sh
#
# Needs Rust (rustup), the MSVC build tools, Node, Python and `cargo install tauri-cli`.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$PATH:$HOME/.cargo/bin"

# .cargo/config.toml points rustc at a Homebrew sccache. An empty wrapper turns it off here.
export RUSTC_WRAPPER=

bash "$ROOT/launcher/stage-resources.sh"
bash "$ROOT/launcher/prepare-ui.sh"

cd "$ROOT/apps/desktop/src-tauri"
cargo tauri build --bundles nsis -- --locked

EXE="$ROOT/target/release/appgea-panel-desktop.exe"
[[ -f "$EXE" ]] || { echo "build finished but no exe at: $EXE" >&2; exit 1; }
echo "app:       $EXE"
echo "installer: $(ls "$ROOT"/target/release/bundle/nsis/*.exe)"
