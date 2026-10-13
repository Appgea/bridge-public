# Git as one spine of time

The plan for the Git tab. Sibling of `WORK.md`. Second draft.

## What changed from the first draft

The first draft was a map with seven lands, three columns on top and two strips below. That is
five regions. The current screen was rewritten once already because four regions competed for
one glance. Seven lands would repeat the mistake with prettier names.

This draft keeps three regions. It reads in one direction, top to bottom. It adds the one thing
the first draft lacked: a **next move**. And it makes the **agent turn** the unit of work, because
that is what is different about this repo. A human and an agent share it.

## Rules

- **Gamified means one clear move at a time.** The screen always says what to do next and gives
  one button for it. Do it, and the next move appears. In sync and clean is the win state.
- **Honest motion.** Nothing moves unless git is doing that thing now. Same rule as the sweep.
- **Git words stay under the surface.** No "staging", "index", "HEAD", "upstream", "rebase".
  Hover shows the git word for anyone who wants to learn it.
- **Position beats numbers.** Ahead and behind are places on the spine, not counters.
- **Every destructive verb sits next to its undo.**
- **No points, badges, streaks, confetti.** Fake progress hides real progress.

## The screen

```
┌──────────────────────────────────────────────────────────────────────┐
│ NEXT MOVE   The agent's last turn left 5 files. Pack them?           │
│             [ Commit turn 3 ]  ⌘↵                  tavla · main · ⋯  │
├────────────────────────────┬─────────────────────────────────────────┤
│ SPINE                      │ FOCUS                                   │
│                            │                                         │
│ ◌ waiting                  │  Turn 3 · agent · 4 min ago             │
│   ▾ Turn 3 · 🤖 · 4m       │  "add retry backoff to auth"            │
│       auth.dart            │                                         │
│       login.dart           │  message  [ Add retry backoff to auth ] │
│       auth_test.dart       │  5 files · all go in                    │
│   ▸ Yours · 2 files        │  [ Commit ]   [ Discard turn · undo ]   │
│                            │                                         │
│ ● Add retry budget  you 1h │  (or: a diff, a commit, the remote line)│
│ ● Fix login copy    🤖  2h │                                         │
│ ━━━ origin/main ━━━ Send 2 │                                         │
│ ● Release 1.4          2d  │                                         │
│ ● Tidy assets          3d  │                                         │
│   ⋯ older                  │                                         │
├────────────────────────────┴─────────────────────────────────────────┤
│ SAFETY   undo last commit · put aside · bring back (1)   branches ▸  │
└──────────────────────────────────────────────────────────────────────┘
```

Three regions plus a thin safety bar. Below, each one: what it looks like, what it does, why it
earns the space.

### 1. Next Move — the game loop

**Looks.** One sentence and one button at the top. Always present. The sentence names the state in
plain words. The button is the single verb that moves the repo forward. When there is nothing to
do: "In sync. Clean." in a calm tone, no button.

**Does.** The sentence comes from a fixed ladder, first match wins:

1. Operation stopped or conflicts → "Merge stopped on 3 files." **Resolve** / Abort.
2. Waiting files from an agent turn → "Turn 3 left 5 files." **Commit turn 3**.
3. Waiting files from you → "You changed 2 files." **Commit**.
4. Remote has work you don't → "2 commits waiting at origin." **Bring in**.
5. Unsent commits → "2 commits not sent." **Send**.
6. Nothing → "In sync. Clean."

`⌘↵` presses the button from anywhere on the tab.

**Why.** This is the whole gamification. A git screen today is a dashboard. You read everything
and decide. A game gives you one move. For a person with many repos and short attention, one
sentence and one button turns Git from a chore into a rhythm. Press, watch it land, press again.
The ladder is also the same order a careful person would choose by hand, so the button never
suggests something wrong.

### 2. Spine — everything in time, one column

One vertical line. Newest at the top. Future above, past below. It replaces the change list, the
receipts list, the sync bar and the remote status in one reading direction.

**Waiting, at the top.** Not yet a commit. Grouped by **turn**: each agent turn is a card with the
robot mark, its prompt as the title, and its files. Your own edits are one card marked "Yours".
Inside a card, the intent groups from today's `GROUP_RULES` still sort the files. Turn data comes
from the hook events the frontend already receives, `file_changed` and `turn_finished` per
session. Files git sees that no hook touched fall into "Yours".

**Stones, below.** Each commit is a stone with subject, author mark, age. The author mark is the
robot or you, read from the commit author. Refs are small flags.

**The remote line.** A horizontal rule across the spine labeled `origin/main`. It sits exactly
where the remote is. Stones above it are not sent. The line carries the verb: **Send 2**. When
the remote has commits you lack, ghost stones appear above the line in a lighter tone with
**Bring in 2** on the line. No remote: the line is dotted and says "no remote · add one".

**Does.** Click a turn card, a file, a stone or the line and Focus shows it. `j` `k` walk the
spine. Right-click a stone: revert, cherry-pick, reset here. Scroll down loads older history.

**Why.** Today "what is dirty", "did it land" and "am I in sync" are three places. Here they are
three heights on one line. Ahead and behind stop being numbers to decode. They are distances you
see. Grouping dirt by turn is the biggest win: the question is never "what changed in
`auth.dart`". It is "what did the agent do in that last turn, and do I keep it". One card
answers that and commits it in one press with the prompt as the message.

### 3. Focus — the right side, one thing at a time

**Looks.** Shows whatever is selected on the spine. Four faces:

- **A turn card.** Prompt, files, a message field prefilled from the prompt, **Commit** and
  **Discard turn** with undo. Uncheck a file to leave it behind. That is the only place the
  subset commit lives.
- **A file.** The diff, or the image for visuals. Same renderer as today.
- **A stone.** The commit contents and its diff.
- **The remote line.** What will move and which way. Send or Bring in with the live phase word
  from `/push/progress` and `/pull/progress`.

**Why.** One thing at a time is the opposite of the current inspector plus action rail. The
verb lives with the thing it acts on. Commit is on the turn. Send is on the line. Nothing needs a
toolbar.

### 4. Safety bar — the undo you can see

**Looks.** A thin strip at the bottom. **Undo last commit**, **Put aside** with count, **Bring
back** with the latest stash title. After any destructive act a card appears for two minutes:
"Discarded login.dart · bring back".

**Why.** Git is unpleasant because undo is hidden. A visible, always-true undo removes the fear.
Fear gone is the largest enjoyment gain on this screen and costs three buttons.

### 5. Branches — a drawer, not a land

**Looks.** Hidden by default. `branches ▸` opens a drawer from the right. Each branch is a short
vertical thread next to the spine, starting at the stone where it forked. Current one is bright.
Remote-only are dotted.

**Does.** Click to switch. **Merge into main** and **Delete** on each thread. New branch from the
drawer head. No drag, no drop. Uses `/branch`, `/checkout`, `/merge`, `/branches/delete`.

**Why.** A one-person portfolio uses branches rarely. They must not cost the main glance. When
one exists, drawing its fork point answers the only question that matters about it. Merge by
button, not drag, because a merge in the wrong direction is the one mistake that takes an hour.

### 6. Atlas — the same spine, every repo

**Looks.** Click the repo name in the header. Each repo becomes one row: name, tiny spine as a
sparkline with waiting, unsent and incoming marks. Rows with anything to do are lit.
**Pull all** and **Push all** at the top run the existing sweep in `git-sync.ts`.

**Why.** The sweep is the best Git code in Panel and it is hidden behind a dashboard chip. The
atlas gives it a home and uses the same visual language as the single-repo view.

## Motion

The four moments in `git-moment.ts` stay and move onto the spine:

- **Commit.** The turn card folds into a stone and drops to the top of the stone list.
- **Send.** Stones above the line slide through it. The line rises to the top.
- **Bring in.** Ghost stones darken and settle in place.
- **Merge.** The thread in the drawer bends into the spine at a new stone.

Each phase binds to the progress endpoints. Agent git events from hooks play the same scenes with
the robot mark at the origin. After a scene settles, Next Move updates.

## Build order

1. Spine with stones and the remote line. Replaces receipts and sync bar. `/graph`, `/status`,
   `/push`, `/pull`. 1 day.
2. Waiting cards by turn, joined from hook events to `/status`. 1 day.
3. Next Move ladder and `⌘↵`. 0.5 day.
4. Focus faces: turn, file, stone, line. Reuses today's diff renderer. 1 day.
5. Safety bar and the two-minute undo card. 0.5 day.
6. Moments onto the spine. 1 day.
7. Branch drawer. 0.5 day.
8. Atlas over the existing sweep. 1 day.

No backend change. Every verb already exists in `host/modules/git-manager/lib/gitops.py`.

## Not doing

- Lane-coloured graphs. One spine, threads only in the drawer.
- Drag-and-drop for merge, rebase or reset.
- A file tree. The spine shows only what changed.
- Points, levels, badges, confetti.
- Changing the dashboard Git card or its agent buttons.

## Status

Built in one pass. `features/git.ts`, `features/git.css`, turn feed from `main.ts` through
`project_tools.ts`. `git-moment.ts` is gone.

Two deviations from the plan above:

- Motion is DOM classes on the spine, not a canvas. Packing, sending and arriving are classes
  that go on while the request runs and come off when status lands. Phase words come from
  `/pull/progress`.
- Incoming ghosts sit directly under the remote line, not above it. Above the line is yours.
