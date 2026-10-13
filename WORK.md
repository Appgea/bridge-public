# Work — the task→agent dispatch loop  *(legacy stack)*

> **This is history.** It describes the retired Python dashboard (`panellib/`, `web/dash/`)
> and a Work tab that was a task board. Appgea Panel's Work tab is an editor, and its plan is
> `next/WORK.md`. Kept for the reasoning, not as a roadmap.

Panel today is a strong **agent-run + git/release monitor**. It is not yet a **project
manager**, because the core object of a PM — a persistent unit of WORK with a status — has no
home in the UI. Everything shown is either *ephemeral* (live agent sessions) or *derived* (git
ahead-count, release tags). This doc is the plan to close that gap.

## Principle: derive status, don't declare it
Solo devs never maintain boards — a kanban you hand-update rots in two weeks and becomes another
read-only panel like Decisions. So Work is **launch-capable** and status is **derived**:

- **Doing** = the task has a live agent session attached.
- **Done** = its session ended *and* commits landed referencing it.
- **Todo / Blocked** = the only manually-set states.

Every task's primary action is **Start agent**: open the composer pre-filled with the task text,
spawn a session tab **bound to that task**. The session tab shows which task it serves; the task
shows which session serves it. Source of truth stays `tasks.md` / `work/index.md` (parsed and
written back, greppable). Watch the file, re-render.

## Surfaces

### 1. Per-project `Work` tab
- Placement: **right after Overview, before Decisions** (work should outrank governance in the nav).
- Layout: a grouped **list**, not kanban columns — *Now / Next / Blocked / Done (collapsed)*.
  Columns waste horizontal space at solo-dev WIP levels, and we already have a width problem.
- Row: title · derived status chip · attached-session chip (click = jump to that terminal tab) ·
  commit refs if any · **Start agent** button.
- Composer at the top: add an item in one keystroke.

### 2. Home `Next up` section
- Slot **between "Running now" and "Unpushed work."**
- Top ~3 *Next* items across the portfolio, each with app icon + **Start** button.
- Fixes the dead state: when no agent is running and nothing's unpushed, Home currently says
  "nothing," when the true answer is "here's what to kick off."
- Home then reads: **blocked on me → in flight → what to launch → what to push → what to release.**
  A complete control loop.

### 3. Overview Brief card
- Add a one-line "N open · M blocked" with a door into Work — same pattern as the Git/Release cards.

## Also planned (cheap, high-value)

### `While you were away` strip (Home)
"Needs you" only shows agents *currently* waiting — a session that finished, committed, and closed
at 3am leaves no trace. Add a small Home strip fed from session history: what agents did since you
last looked. Slot it right after the Work board.

### Decisions double-nav (afternoon fix)
Panel draws a row of view buttons and the embedded iframe draws its own near-duplicate row under
it. Suppress the iframe's internal nav (query param) or drop Panel's duplicate row. Jank in an
embedded module is a warning about the module strategy, not just this screen.

### Dead canvas (do LAST)
~660px content column in a ~1070px main area → empty right gutter + vertical space on Home/Overview.
This is a symptom of not-enough-content, not a layout bug. The Work tab + a two-column Overview
consume most of it. Don't polish a vacuum.

## The test for every future module
Does it close the loop from **intent → dispatched agent**, or does it just display state? Work with
a Start-agent button is what crosses Panel from monitor to manager.

## Build order
1. ~~Git graph render bug~~ — **not a bug** (was mid-load); dropped.
2. **Work surface (v1) — SHIPPED.** `panellib/tasks.py` parses the ledger (portfolio.yaml key→dir
   map, tasks.md queue, work/index.md streams); `GET /tasks[?project=]` serves it. Frontend
   `web/dash/work.js`: per-project **Work tab** (In flight / Blocked / Queued / Done groups),
   Home **"Next up"** section, Overview Brief **"Open Work"** door. **Start agent** dispatches via
   the existing `consultInstance` seed path. *Read + dispatch only.*
   - Deferred to v2: write-back (check off / set blocked from the UI), a formal task↔session
     binding (so "Doing" is derived from a live attached session, and the session tab names its
     task), and a one-keystroke "add item" composer.
2b. **Work write-back + composer (v2, part 1) — SHIPPED.** `POST /tasks` (`tasks_mutate` in
   `panellib/tasks.py`) edits the ledger in place by exact-raw-line match: `add` (appends under
   `## Active`, path→ref so it lands in the project's filter), `done`/`reopen` a queued task,
   `block`/`unblock` a stream. Frontend: a top-of-tab **composer** (input + P0–P3 + Add, Enter to
   queue) and per-row controls — ✓ done on Queued, ↺ reopen on Done, ⛔/▶ block-toggle on streams.
   All mutate → re-fetch → repaint. Verified live (curl + browser round-trip). *Manual states only —
   Doing/Done-by-commit stay derived.*
   - **Bug found + fixed while verifying:** `web/dash/app.js` had a stray unconditional
     `workMode=false;` glued after the releaseMode `if`, so every background poll forced the Work
     tab closed on the next tick. v1's "verified" screenshots were captured in the pre-poll window,
     masking it. Removed the stray statement; Work tab now survives poll cycles.
   - Still deferred to v2 part 2: task↔session binding (the harder piece).
3. Decisions double-nav.
4. "While you were away" strip.
5. Dead-canvas layout pass.
