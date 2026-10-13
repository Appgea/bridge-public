# Panel modules

Modules are optional companion products. Panel must continue to launch, manage
agents, and serve its dashboard when a module is absent.

Each module owns a `module.json` manifest and a one-shot executable. Panel
mounts it at `/m/<name>/` on the same origin; there is no companion server or
module-specific process lifecycle. Everything a module can do is declared in
the manifest — panel has no module-specific code:

- `exec` / `build` / `args` — the one-shot binary and how to compile it;
  `buildInputs` lists files/directories that invalidate it.
- `catalog` — endpoint returning the module's per-project items; matched
  entries (by realpath `root`) decorate Panel's project list under
  `modules.<name>` and drive the module's workspace tab.
- `agentDoc` — static file appended to every launched agent's context.
- `agentContext` — `{"registered": file, "unregistered": file}` per-cwd
  templates picked by matching the launch cwd against the catalog; filled
  with `{key} {profile} {root} {root_sh} {cwd} {cwd_sh} {name_sh} {port}`.
- `hooks` — `["PostToolUse", "UserPromptSubmit", …]`: Claude-session lifecycle events the
  module reacts to. Panel forwards each event (via `session_hook.py` → `/hook/<event>`) to
  every subscriber's `POST /hook/<event>` and injects the `{cards, additionalContext}` it returns.
- `agentDir` — `true` to `--add-dir` the module folder into launched agents.
- `requires` — CLIs that must be on PATH for the module to count as available.
- `assets` / `chatAsset` — static files and dashboard chat renderers.
- `animations` — `{"uses": [...ids], "owns": [...ids]}`: allocation entries in the motion ledger
  (`../motion.json`). IDs are namespaced `<namespace>:<name>`. `uses` are `core:*` ids the module
  reuses (implemented in `web/dash/motion.css` as `.mo-<name>`); `owns` are ids the module mints in
  ITS OWN namespace (= this module's `name`, e.g. `git-manager:converge`) and implements in its
  `chatAsset.css`. Mint any name inside your namespace freely — no collisions across namespaces, no
  central sign-off. A module never redefines a `core:*` keyframe. When the same motion shows up in
  ≥2 namespaces it graduates to `core:*` (promotion — see `motion.json` `allocation`), so a shared
  action looks identical in a module's tab and when it replays as a chat card.

Modules can be toggled off from the dashboard settings (persisted as
`disabledModules` in config.json). A disabled module is not built, relayed,
injected into agents, or matched against projects.

## Product Spine

`product-spine/` is the deterministic ownership layer. Panel discovers its
registry, hosts its one-shot renderer, embeds it as the Product Spine workspace, and
injects its CLI grammar (from `agent/*.md` templates) only for registered
projects.

It is a Python package with a Flutter-first extractor, not a Flutter UI. It runs
only as a panel-hosted one-shot (`bin/host.py`, `cgi-argv`) — there is no companion
server or `localhost` port. It also subscribes to session hooks (`PostToolUse`,
`UserPromptSubmit`) so it can flag edits that touch a recorded decision and orient
decision-shaped prompts, all over the panel port.

The module remains a split concern with its own package, tests, registry, data,
and Git history. It does not own Panel agent sessions, configuration, or
secrets.
