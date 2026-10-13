# Work streams — the in-flight board

Every **focused, multi-step effort currently running** = one file `work/<stream-id>.md`.
This index is the spine: one line per ACTIVE stream. It is your company-wide view of what's
in flight across all projects and who owns it — the answer to "what's going on right now".

Why sharded: one writer per stream file means many agents/humans work in parallel with **zero
write contention** (no shared-file races). Same shape as `apps/<key>.md` + `portfolio.yaml`.

Line format:
`<stream-id> | <app-ref(s)|-> | <owner> | <status> | <done-when>`
- owner: `you` | `cpo` | an agent label (e.g. `agent-checkout-paywall`, a background/remote id)
- status: `active` | `blocked` | `review` (awaiting human) | `merging`

## Read discipline
Read THIS index for the board; open a single `work/<id>.md` only for that stream's detail.
Never `cat` all stream files. Soft cap: **15 active streams** — over that is WIP overload, a
signal to close/merge, not to grow silently.

## Lifecycle
1. A queued `tasks.md` line is picked up → open `work/<id>.md` from `_template.md`, add a line here.
2. Classify semantic authority: clear request → `logic_status: direct`; cheap reversible ambiguity →
   `assumed` and state the assumption; ambiguous + consequential → draft `## Logic Patch`, set
   `logic_status: draft`, and stop before planning until the human approves it.
3. The owner logs progress INTO its own stream file (record-as-you-act lands here, not in a shared file).
4. Before calling it done, describe the observable result at proportionate depth. Fill the full
   `## Delivery Review` for substantial product work; visible flows require rendered/interactive
   evidence, not terminal output alone.
5. On done (`done-when` observed): distill the durable residue to its ONE permanent home —
   a decision → `decisions/`, a state change → `apps/<key>.md` `## Log` (one high-signal line,
   written once at close), a taste signal → `_system/taste.md`. Then archive the stream file to
   `work/archive/` and remove its line here. The stream itself is Tier-3 transient.

## Active

<!-- one line per ACTIVE stream -->
