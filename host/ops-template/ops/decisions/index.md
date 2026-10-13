# Decisions index

Two tiers. THIS index is the **active** layer — one terse line per decision that still governs
something today; it's the bounded read. Full reasoning lives in the **ledger** (`decisions/2026.md`):
reviewable by the human, greppable by an LLM on demand, and NEVER injected into a prompt.

Line format:
`<id> | <date> | <status> | <title> | <ref-key|-> | <file>`
status: active | superseded | reversed

**Read discipline.** `rg` the index for a topic, never read it whole. When a decision stops
governing, drop its line from this active index — its full entry stays in the ledger for review.
Save freely to the ledger; it never costs prompt context.

<!-- one line per standing decision, e.g.
- D-0001 | 2026-01-31 | active | Ship the thing | - | decisions/2026.md
-->
