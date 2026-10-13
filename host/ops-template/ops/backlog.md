# Task ledger — the queued backlog

The **queue** of not-yet-started items. When an item is picked up, it **graduates** into a
`work/<id>.md` stream (the in-flight board — see `work/index.md`); this file holds only what's
still waiting. Small one-shot tasks can finish here without a stream; multi-step or parallel
efforts become streams.

Append-only. Newest on top. Two owners:
- `you`  — needs human taste, creative direction, or final approval.
- `cpo`  — mechanical/LLM-doable (release, screenshots, RC sync, ASO, metadata).

Format (one line each):
`- [ ] | <owner> | <ref-key|->| <priority P0-P3> | <task>  [done-when: <observable criterion>]   (created YYYY-MM-DD)`
`done-when:` is REQUIRED on `cpo` tasks (the machine-checkable goal — P-13) and omitted on `you`
tasks (the human is the criterion). Don't mark `[x]` until the `done-when` is observed, not assumed.
Mark `[x]` when done. `/cpo archive` sweeps `[x]` lines to `tasks/archive/`.
This file holds **only Active** — no Done pile lives here. Soft cap: 25 items.

## Active

<!-- one line per queued task, newest on top -->
