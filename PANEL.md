# Panel + native terminal

> **Status (2026-07):** the right-hand companion panel is GONE from the project screen. The
> shell is two columns now — rail + work. `panel_emit` visuals still arrive: they land on the
> Dashboard stage, the Inbox, and the terminal wall. `ask_user` lands in the **ask tray**, a stack of
> cards over every screen, bottom right (`features/ask_tray.ts`). The agent stays parked until you
> answer, press Skip (`{"skipped": true}`), or the ask times out. The ambient feed, the pulse
> canvas and the show queue were deleted with the panel.

The redesign: stop re-rendering the agent's TUI. Show the **real** tmux session in the browser
(the default for both Claude and Codex whenever tmux is installed),
and put the rich stuff — animations and questions — in a **companion panel** driven by two feeds:

- **Deterministic** (the backbone): Claude session hooks → `panel.from_hook` → animations that
  fire because the hook fired, not because the model remembered. Git commits, file edits, turn
  stop/notify. No model cooperation required.
- **Intentional**: the agent calls the `appgea-panel` MCP tools — `panel_emit` for a visual it
  wants to show, `ask_user` for a real question it needs answered before continuing.
- **Plain lens**: every completed agent reply gets a separate, isolated presentation pass for the
  panel. The original reply and terminal stay unchanged, and the rewritten text is never fed back
  into the main session. `config.json` can disable it with `"plainView": false`.

Everything is a **registry keyed by a free-string type**, so new animations and new question
kinds are one-line additions with zero plumbing changes.

## Pieces

| File | Role |
|---|---|
| `panellib/panel.py` | core: `emit` / `ask` (blocking) / `answer` / `snapshot` / `from_hook` |
| `panellib/terminal.py` | ttyd manager — attach a browser terminal to the live tmux session |
| `mcp/panel_mcp.py` | stdio MCP server, tools `panel_emit` + `ask_user`, forwards to the panel port |
| `web/dash/panel.js` | frontend registries + built-in fallbacks/widgets, `panelTick()` |
| `web/dash/terminal.js` | ttyd iframe overlay + toggle button, `termSync()` |
| server routes | `GET /panel`, `POST /panel/emit|ask|answer`, `GET /terminal/attach` |
| launch wiring | per-instance `--mcp-config`, panel hook events, auto-allowed MCP tools |

## Flow

```
 hooks ─(deterministic)─┐
                        ├─► panel.emit ──► instance.panel ──► GET /panel ──► panel.js ──► animation
 MCP panel_emit ────────┘                       ▲
 MCP ask_user ─► POST /panel/ask (BLOCKS) ──► panel.ask ─┘          answer ◄─ POST /panel/answer ◄─ widget
```

`ask` blocks the MCP tool call on a `threading.Event` until the browser POSTs an answer (or it
times out). The answer is returned as the tool result — the agent never reads the panel or the
PTY to get it.

## Add a new animation type

Backend needs nothing. Emit from anywhere (a hook mapping in `panel.from_hook`, a module, or the
agent via `panel_emit`), then register a renderer:

```js
// any script loaded after panel.js
registerAnim("deploy", (payload, el) => {
  el.innerHTML = `<div class="pev-t">deploy</div><div class="pev-b">${payload.env} · ${payload.sha}</div>`;
});
```

Unknown types fall back to a compact `card`, so it's safe before you write the renderer. Prefix
families such as `git-*` route to the owning module's shared renderer; the Git module therefore
owns its pull/commit/push scenes without adding Git-specific presentation to Panel core.

Built-ins: `note`, `milestone`, `status`, `tool`, `progress`, `git` (+ `git-*`), `card`.

## Hand selected work to a new session

A `multi` ask may include `handoff: {task, provider, button}`. Its submit button creates a new
session in the same project, seeds the chosen titles as the first task, switches the dashboard to
that tab, and starts the agent. This is for turning a review/brainstorm session into a clean
implementation session without copying a checklist by hand.

## Add a new question kind

Backend is agnostic — `spec.kind` is just a string it stores. Register a widget: given the spec,
call `submit(value)` with whatever answer object you want the agent to receive.

```js
registerPanelAsk("rating", (spec, submit, el) => {
  [1,2,3,4,5].forEach(n => {
    const b = document.createElement("button"); b.className = "opt"; b.textContent = "★".repeat(n);
    b.onclick = () => submit({ rating: n });
    el.appendChild(b);
  });
});
```

Then the agent calls `ask_user(kind="rating", prompt="How'd it go?")` and gets back
`{"rating": 4}` as the tool result. Built-in kinds: `choice`, `multi`, `confirm`, `text`, `form`.

## Terminal

`GET /terminal/attach?instance=<id>` ensures a `ttyd` is attached read/write to the instance's
tmux session and returns its URL; the dashboard embeds it in an iframe (🖥 Attach button).
Requires `ttyd` (`brew install ttyd`); headless instances have no pane and degrade to the feed /
backend-log button. The ttyd is reaped when the instance stops.

## Notes / live-verify

- Codex MCP wiring is best-effort (inline `-c mcp_servers.*` TOML); Claude is first-class
  (`--mcp-config`). Codex's command lifecycle deterministically maps completed Git activity into
  the same module scenes as Claude's hooks; intentional milestones still use `panel_emit`.
- Bash `PostToolUse` is now forwarded (for git animations); that's one hook subprocess per bash
  command — fine for a single-user tool, but it's the one added per-turn cost.
- Tests: `python3 test_panel.py` (panel core + full MCP handshake round-trip).
