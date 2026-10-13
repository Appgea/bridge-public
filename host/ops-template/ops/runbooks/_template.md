---
runbook: <name>
inputs: [app_key]            # params the CPO must resolve before running
hands: [api, browser, human] # which hands this flow uses
updated: YYYY-MM-DD
---

# <name> — runbook

**Trigger.** When to run this.
**Done when.** The end state that means success.

## Steps
Each step is tagged with the hand that does it:
- `[api]`     — CPO does it via skill/MCP. Name the exact tool.
- `[browser]` — CPO emits a **prompt block** for the browser hand (Claude for Chrome /
  Playwright MCP). The prompt must be complete and copy-pasteable.
- `[human]`   — queued as a `you`-owned task; CPO waits.

1. `[hand]` step — tool/skill — what + verification.

## Run state (resumable — so any model can pick up cold)
Execution progress lives in the app file, NOT in the model's context. On first run, write a
`## Runbook: <name>` block into `../apps/<app_key>.md` listing every step as a checkbox:
```
## Runbook: <name> (started YYYY-MM-DD)
- [ ] 1 <step>  [api]
- [ ] 2 <step>  [browser]
...
```
Do ONE step per turn: the first `[ ]`, then tick `[x] … — <result>` and stop. Resuming =
read this block, continue from the first `[ ]`. Remove the block when all steps are `[x]`.

## Logging
On each step, also append a one-line entry to `../apps/<app_key>.md` `## Log` and tick the
relevant `checklist` flags in its frontmatter. Open `[human]` steps → `../tasks.md`.
