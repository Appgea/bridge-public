# setup/ — the bootstrap source of truth

The root-level config (`CLAUDE.md`, `.claude/`, `vault/` scripts) lives at your portfolio
root, which is usually NOT a git repo — so it can't be version-controlled there. This folder holds
the **tracked, canonical copies**, and `../setup.sh` deploys them into place.

## Fresh machine / clone
```
# place this tree as <portfolio-root>/ops, then:
bash ops/setup.sh
```
That deploys every root-level file, renders `.claude/settings.json` with the right absolute
paths, arms the vault hook, restores the git pre-commit health gate, and creates the encrypted Vault store.

## Source of truth
Edit the files **here** (in `setup/`), then run `bash ops/setup.sh` to redeploy. The root
copies are deployment artifacts — don't edit them directly, they get overwritten.

## What it deploys
| source | → | deployed to |
|---|---|---|
| `setup/CLAUDE.md` | | `<root>/CLAUDE.md` |
| `setup/root-gitignore` | | `<root>/.gitignore` |
| `setup/settings.json.tmpl` | (rendered) | `<root>/.claude/settings.json` |
| `setup/commands/cpo.md` | | `<root>/.claude/commands/cpo.md` |
| `setup/workflows/autopilot.js` | | `<root>/.claude/workflows/autopilot.js` |
| `setup/hooks/guard-vault.sh` | | `<root>/.claude/hooks/guard-vault.sh` |
| `setup/vault/{with,clear}.sh`, `MANIFEST.md` | | `<root>/vault/…` |
