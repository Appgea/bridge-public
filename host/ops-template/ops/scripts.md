# Scripts — the deterministic layer (the city's roads & plumbing)

Durable, relied-on scripts only. They do deterministic work WITHOUT spending model tokens; the LLM
spends tokens on judgment, not rote. This is the navigable index — find the script here instead of
re-deriving or duplicating one.

Rules:
- Listed here = DURABLE: needed, maintained, self-checkable. A dead entry is rot — retire it.
- One-off / TEMP scripts are NOT listed — written, used, and deleted (they come and go).
- A durable script must earn its upkeep. Dead, or broken-but-trusted → retire it (worse than none).

Format: `` - `path` — purpose · check: <how you know it still works> ``

## Brain / system (ops-owned)
- `setup.sh` — deploy root config from `setup/` (symlink driver+skills, render settings, arm vault hook) · check: idempotent re-run → PASS
- `setup/vault/with.sh` — deny the retired plaintext runner and direct callers to constrained brokers · check: exits 2
- `setup/vault/clear.sh` — prevent accidental deletion of persistent encrypted credentials · check: exits 2
- `setup/hooks/guard-vault.sh` — PreToolUse hook: block any bash referencing `vault/secrets/` directly · check: deny still fires
- `setup/skills/showcase/scripts/install_flutter_preview.sh` — install/update the reusable Flutter visual-preview harness · check: idempotent copy, changed-file refusal, explicit `--force`

## Per-app scripts
Live in each app repo (fastlane, `deploy/`, `tools/`) and are recorded in that app's `apps/<key>.md`
when relied-on — e.g. a server's `deploy/deploy.sh`.
Not duplicated here (other repos may be on a branch or absent).
