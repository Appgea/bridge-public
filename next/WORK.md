# Work — the editor

Work is the tab you type into. It is the only Panel surface held to IDE standards, because it is
the only one where a slow, vague or lying detail costs you a keystroke instead of a glance.

The scope is narrow on purpose. Panel is not competing with VS Code on breadth. It is the editor
for **a human sharing a repository with an agent**, which is a case no other editor is built for:
two writers, one working tree, one of them faster than you and not asking permission. Everything
below is judged against that.

## What is settled

- **The pane wears `--m-work`.** `--accent` is rebound at `.files-root`, so chrome and the
  CodeMirror theme both turn blue. Never hard-code the hue.
- **Two writers, never a clobber.** A clean buffer reloads silently. A dirty buffer becomes a
  conflict the human resolves. Nothing is written or discarded without a click.
- **The `why` outranks the filename.** An agent hands a file over with a reason. The reason is set
  as loud as the name.
- **One editor.** `features/editor/` is the whole typing experience, shared by every editor. A
  change there moves every editor at once. Host panes own only what surrounds the buffer.
- **Motion budget.** Nothing enters. Hover, press, and the 900ms jump flash. That is all.

## The build order

Ranked by how often the absence is felt, not by how hard it is. All five are shipped; what comes
next is at the bottom.

### 1. Repo-wide search — ⌘⇧F — **done**
`code_nav::search` walks the same tree with the same ignore rules the navigator uses, and
`features/editor/find_in_project.ts` is the drawer that shows the answer. Plain text, not regex:
Panel opens arbitrary repositories cold, and a query that quietly means something else because
of a stray `.` is worse than one that only ever means itself. Case and whole-word are the two
toggles that change an answer, so they are the two that exist.

A drawer and not an overlay, because search is a reading task — you walk hits, open one, decide
it was wrong, come back. A centred panel would hide the file you just opened.

### 2. Git state in the tree — **done**; the gutter is still open
`projects::git_file_states` reports every dirty path, and the tree marks it with git's own letter
at the row's right edge. Folders roll up to a dot: a dirty file lights every ancestor, so a
collapsed tree still shows where to look. Deliberately not `git_working_set` — that one curates
for the worklist, and the tree needs the raw truth.

Change bars in the line gutter came with item 4: `projects::git_head_file` serves the committed
blob, `editor/diff.ts` computes the diff, and the shared editor draws it in a 3px gutter beside
the line numbers. Same colours as the tree, so amber means the same thing in both places.

### 3. Tabs survive a project switch — **done**
One workspace per project — tabs, order, active file, scroll. Panel's whole shape is "selecting
a project changes what you SEE, never what is RUNNING", and dropping every buffer broke that
promise on the surface where it cost most. Eight workspaces are kept, evicted least-recent first,
and a workspace holding unsaved edits is never evicted.

Theme and zoom reconfigure every parked state in every workspace, not just the open one. A buffer
must not come back wearing last week's palette.

### 4. A diff, not a conflict bar — **done**
"The agent rewrote this file on disk" was the right sentence with the wrong affordance. Choosing
between two versions you have not seen is a coin toss dressed as a choice. The bar now asks one
thing — **Show what changed** — and the two commands moved into the diff's header, next to the
evidence for them.

`editor/diff.ts` is the one line diff in Panel, shared by the gutter and this view. If those two
ever disagreed, the gutter would be lying about the file you are deciding on. Common prefix and
suffix are trimmed first; a large unrelated middle is declared replaced rather than tabled,
because an honest coarse answer in a frame beats an exact one that drops a keystroke.

### 5. Split the rail — **done**
`RELEVANT` meant two things under one header: the agent's worklist with nothing open, an import
graph with something open. Starting work destroyed the reason you were given for doing it, and
nothing on screen said which question was being answered.

Now **Waiting on you** never moves, and **Related** sits under it and belongs to the open file. It
leaves entirely when nothing is open, because with no file there is no question to answer.

## What is next

Nothing on this list is load-bearing yet. In rough order of how often the absence bites:

- **Split view.** Two files side by side. Real, and the largest of these by far.
- **Replace in project.** ⌘⇧F finds; it does not yet replace.
- **Drag to reorder tabs.** ⌘1…⌘9 follow strip order, so order should be yours to set.

### Shipped since the five above
- Filter the tree by name (the navigator's head is the box); ⌘P opens the whole project, ranked
  name-prefix → name → folder → letters-in-order, with the match marked.
- Context menus. Tree: new file/folder, rename, delete, copy path, reveal in Finder. Tab: close
  others/saved/all, keep open, copy path, reveal. Middle-click closes a tab.
- The VS Code tab model. One preview tab, ever; typing, saving, double-click, or a jump keeps it.
- Indentation follows the file (tabs, or the most common space step). Wrap is per buffer —
  prose on, code off — and the status bar flips it. Trailing whitespace is marked.
- The tree re-reads a folder the moment the agent writes into it.
- Typing no longer rebuilds the tab strip and re-queries the tree on every keystroke.

## The test for anything added here

Does it help a human and an agent share one working tree? Line numbers, folding and a minimap are
table stakes; they earn their place by being unremarkable. The conflict flow, the `why` rail and
the agent-write flash are the surface's actual reason to exist. Spend the effort there.

## History

The old dashboard had a *different* Work — a task board that dispatched agents. That plan and its
shipped history live in the repository-root `WORK.md`, against the retired Python stack. It is not
this surface and is kept only as a record.
