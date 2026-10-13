#!/usr/bin/env bash
# PreToolUse(Bash) guard: block any Bash command that references a vault/secrets/ file
# directly, or that hits human-only vault routes. Broker routes such as /vault/probe, /vault/asc,
# and /vault/play never return credential material. Exit 2 = block.
cmd="$(cat | python3 -c 'import sys,json; print(json.load(sys.stdin).get("tool_input",{}).get("command",""))' 2>/dev/null)"
[ -z "$cmd" ] && exit 0   # fail-open on parse error; Read-deny still protects

# Any reference to vault/secrets/... is forbidden (the wrapper takes a bare name, not a path).
if printf '%s' "$cmd" | grep -qE 'vault/secrets/'; then
  echo "Blocked: vault/secrets/ contains protected ciphertext. Use a constrained Panel broker route." >&2
  exit 2
fi
# The panel's HTTP write/list routes (/vault/secret, /vault/secrets) aren't filesystem
# paths, so the rule above misses them — block those too. /vault/probe stays allowed: it's
# the documented way to USE a secret and never echoes the value back.
if printf '%s' "$cmd" | grep -qE '/vault/(secret|secrets|unlock|import-legacy)'; then
  echo "Blocked: the vault's write/list HTTP route is protected from agents. Use /vault/probe to USE a secret, or ask the human to add/change one via the vault page." >&2
  exit 2
fi
exit 0
