#!/bin/bash
# Shared first-run dependency setup for development and release builds.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UI="$ROOT/apps/desktop/ui"
if [[ ! -x "$UI/node_modules/.bin/vite" || ! -x "$UI/node_modules/.bin/tsc" ]]; then
  echo "installing frontend deps (first run)"
  npm --prefix "$UI" ci --engine-strict
fi
