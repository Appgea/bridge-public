#!/usr/bin/env bash
# Bootstrap the ops system: deploy the tracked root-level config from setup/ into
# place, render machine-specific paths, arm the vault hook, and restore the git health gate.
# Run from anywhere:  bash ops/setup.sh   (idempotent).
set -euo pipefail

OPS="$(cd "$(dirname "$0")" && pwd)"          # …/<portfolio-root>/ops
SETUP="$OPS/setup"
ROOT="$(cd "$OPS/.." && pwd)"                  # …/<portfolio-root>
SECRETS="$(cd "$ROOT/.." && pwd)/secrets"      # sibling …/secrets (retained signing infra)

[ -d "$SETUP" ] || { echo "no setup/ source next to setup.sh" >&2; exit 1; }
echo "Deploying ops config to: $ROOT"

mkdir -p "$ROOT/.claude/commands" "$ROOT/.claude/hooks" "$ROOT/.claude/skills" \
         "$ROOT/.claude/workflows" "$ROOT/panel/vault/secrets" "$ROOT/scratch"
touch "$ROOT/panel/vault/secrets/.gitkeep"

# Driver files = SYMLINKS into the versioned source (ops/setup/), so editing the root copy
# edits the tracked file — they can never drift. Everything else is a deployed copy.
ln -sfn "$SETUP/AGENTS.md"        "$ROOT/AGENTS.md"
ln -sfn "$SETUP/workflows/autopilot.js" "$ROOT/.claude/workflows/autopilot.js"
# The /cpo command is retired: the companion lives in Panel (Inbox → @cpo) and reads ops/ as data.
rm -f "$ROOT/.claude/commands/cpo.md"
cp "$SETUP/root-gitignore"        "$ROOT/.gitignore"
# Skills = symlinks into the versioned source (single source, no drift — same rule as the driver)
if [ -d "$SETUP/skills" ]; then
  for d in "$SETUP/skills"/*/; do ln -sfn "${d%/}" "$ROOT/.claude/skills/$(basename "${d%/}")"; done
fi
cp "$SETUP/hooks/guard-vault.sh"  "$ROOT/.claude/hooks/guard-vault.sh"
cp "$SETUP/vault/with.sh"         "$ROOT/panel/vault/with.sh"
cp "$SETUP/vault/clear.sh"        "$ROOT/panel/vault/clear.sh"
[ -f "$ROOT/panel/vault/MANIFEST.md" ] || cp "$SETUP/vault/MANIFEST.md" "$ROOT/panel/vault/MANIFEST.md"

# render settings.json with this machine's absolute paths (deny rules need //abs paths)
sed -e "s|__PORTFOLIO_ROOT__|${ROOT#/}|g" -e "s|__SECRETS_DIR__|${SECRETS#/}|g" \
    "$SETUP/settings.json.tmpl" > "$ROOT/.claude/settings.json"

chmod +x "$ROOT/panel/vault/with.sh" "$ROOT/panel/vault/clear.sh" \
         "$ROOT/.claude/hooks/guard-vault.sh"

echo "  ✓ root config, vault, hook deployed"
echo
echo "Done. Next:"
echo "  1. Relaunch claude from $ROOT so settings.json takes effect."
echo "  2. Add and unlock credentials through Panel's encrypted Vault UI."
