# PARA for a portfolio

Copied from the personal second brain's *method*, not its content. That brain stays personal and
separate; nothing here reads it and nothing there reads this.

## The one rule

**File by actionability, not by topic.** Not "where does this belong?" but "what does this change
about what I do?" Topic filing feels tidy and answers nothing; actionability filing means the
folder itself tells you whether something is live.

## The four buckets, and where they already live

This tree was PARA-shaped before it had the name. Keep the real folder names — `apps/` says more
than `Areas/` ever will.

| PARA | Here | Test |
|---|---|---|
| **Projects** | `now.md`, `rollouts/*.md` | has a finish line, and a `done-when` you could observe |
| **Areas** | `apps/*.md`, `company.md` | ongoing, never "done" — an app is never finished, only current |
| **Resources** | `decisions/`, `runbooks/` | might be useful later; no owner, no deadline |
| **Archives** | `log/<year>.md` | was one of the above, isn't live now |

## Routing a new input

1. Does it change what happens next? → `now.md`, or a `rollouts/` file if it spans apps.
2. Is it a lasting fact about an app? → that app's `apps/<key>.md`.
3. Is it a choice, with reasoning worth keeping? → `decisions/<year>.md` + one line in the index.
4. Is it reusable, app-agnostic how-to? → `common/*.md` knowhow.
5. Finished? → one line in `log/<year>.md`, and drop it from `now.md`.
6. None of the above → it isn't worth writing down. Say so and stop.

The last rule is the load-bearing one. A brain that files everything is a landfill.

## Active layer vs ledger

Every bucket splits in two, and they have opposite rules:

- **Active** (`now.md`, `company.md`, `decisions/index.md`, app frontmatter): only what governs
  *now*. The manager reads it every session, so it stays lean. When something stops being true,
  drop the line.
- **Ledger** (`log/<year>.md`, `decisions/<year>.md`, `backlog.md`): the reasoning, the backstory,
  your words verbatim. Never auto-read, `rg`'d on demand — so it can grow forever, free.

Save freely to the ledger. Keep the active layer small enough to read in one breath.

## Retrieval

No database, no embeddings, no service — markdown plus `rg`/`find`, same as the personal brain.
The index is the bounded read; a full entry is pulled only when its id actually comes up.
