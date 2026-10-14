/**
 * A pretend Panel backend for README screenshots. capture.mjs injects this before the real UI
 * loads, so every screen is the shipped frontend drawing invented data. Nothing here reads or
 * writes a file, starts a process or talks to a network.
 *
 * It answers the same Tauri commands the Rust side answers (see `invoke` calls in ui/src) and
 * replays agent events and terminal output through the same event channels. A command it does not
 * know logs `[demo] unhandled` and returns null, which is the first place to look when a new
 * screen comes up empty.
 */
(() => {
  const ROOT = "/Users/dev/projects";
  const now = Date.now();

  /* ------------------------------------------------------------- portfolio */

  const project = (id, name, extra = {}) => ({
    id,
    name,
    path: `${ROOT}/${name}`,
    exists: true,
    group: "",
    role: "leaf",
    type: "generic",
    parent_id: "",
    extension_id: "",
    ...extra,
  });

  const PROJECTS = [
    project("tavla", "Tavla"),
    project("wolf2048", "Wolf2048"),
    project("sudokov", "Sudokov"),
    project("payee", "Payee"),
    project("memor", "Memor"),
    project("fitstrail", "Fitstrail"),
  ];

  const GIT = {
    tavla: { branch: "main", ahead: 2, behind: 0, dirty: 3, is_repo: true },
    wolf2048: { branch: "daily-challenge", ahead: 4, behind: 0, dirty: 5, is_repo: true },
    sudokov: { branch: "main", ahead: 1, behind: 0, dirty: 0, is_repo: true },
    payee: { branch: "main", ahead: 0, behind: 0, dirty: 1, is_repo: true },
    memor: { branch: "main", ahead: 0, behind: 0, dirty: 0, is_repo: true },
    fitstrail: { branch: "strava-import", ahead: 0, behind: 3, dirty: 0, is_repo: true },
  };

  /** Where each app stands in ops/portfolio.yaml. The sidebar sorts its lanes from this. */
  const STANDINGS = [
    { project: "tavla", key: "tavla", status: "live", notes: "Online matches and the doubling cube." },
    { project: "wolf2048", key: "wolf2048", status: "building", notes: "Daily challenge mode." },
    { project: "sudokov", key: "sudokov", status: "review", notes: "1.4 in App Store review." },
    { project: "payee", key: "payee", status: "live", notes: "" },
    { project: "memor", key: "memor", status: "paused", notes: "" },
    { project: "fitstrail", key: "fitstrail", status: "building", notes: "Strava import." },
  ];

  /** Commits per day for the last two weeks, oldest first. The sidebar draws these as bars. */
  const DAYS = {
    tavla: [0, 1, 0, 2, 3, 0, 0, 1, 4, 2, 0, 3, 5, 2],
    wolf2048: [2, 0, 0, 1, 0, 3, 2, 0, 0, 4, 1, 0, 2, 3],
    sudokov: [0, 0, 3, 1, 0, 0, 0, 2, 0, 0, 1, 0, 0, 1],
    payee: [0, 0, 0, 0, 1, 0, 0, 0, 0, 2, 0, 0, 0, 1],
    memor: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    fitstrail: [1, 0, 2, 0, 0, 1, 0, 0, 3, 0, 1, 2, 0, 1],
  };

  const session = (projectId, n, kind, title) => ({
    id: `s-${projectId}-${n}`,
    project: projectId,
    kind,
    title,
    terminal_id: `t-${projectId}-${n}`,
  });

  const SESSIONS = [
    session("tavla", 1, "claude", "claude"),
    session("tavla", 2, "shell", "shell"),
    session("wolf2048", 1, "codex", "codex"),
    session("sudokov", 1, "claude", "claude"),
    session("payee", 1, "shell", "shell"),
  ];

  /* ----------------------------------------------------------------- files */

  const CUBE_BEFORE = `import 'dart:async';

import 'match.dart';
import 'player.dart';

/// The doubling cube: who owns it, what it is worth, and the offer in flight.
class DoublingCube {
  DoublingCube(this.match);

  final Match match;

  int value = 1;
  Player? owner;
  CubeOffer? pendingOffer;
  Timer? offerTimer;

  static const offerTimeout = Duration(seconds: 30);

  bool canOffer(Player by) =>
      match.state == GameState.playing &&
      pendingOffer == null &&
      (owner == null || owner == by) &&
      value < 64;

  void offer(Player by) {
    if (!canOffer(by)) return;
    pendingOffer = CubeOffer(from: by, value: value * 2);
    offerTimer = Timer(offerTimeout, () => decline(by.opponent));
    match.notify();
  }

  void accept(Player by) {
    final offer = pendingOffer;
    if (offer == null || offer.from == by) return;
    value = offer.value;
    owner = by;
    _clearOffer();
    match.notify();
  }

  void decline(Player by) {
    final offer = pendingOffer;
    if (offer == null || offer.from == by) return;
    _clearOffer();
    match.finish(winner: offer.from, points: value);
  }

  void resign(Player by) {
    match.state = GameState.over;
    match.finish(winner: by.opponent, points: value);
  }

  void _clearOffer() {
    pendingOffer = null;
    offerTimer?.cancel();
    offerTimer = null;
  }
}

class CubeOffer {
  const CubeOffer({required this.from, required this.value});

  final Player from;
  final int value;
}
`;

  const CUBE_AFTER = CUBE_BEFORE.replace(
    "  void resign(Player by) {\n",
    "  void resign(Player by) {\n    pendingOffer = null;\n    offerTimer?.cancel();\n",
  );

  const RESIGN_TEST = `import 'package:flutter_test/flutter_test.dart';
import 'package:tavla/game/doubling_cube.dart';
import 'package:tavla/game/match.dart';
import 'package:tavla/game/player.dart';

void main() {
  for (final resigner in [Player.white, Player.black]) {
    test('\${resigner.name} resigning clears a pending offer', () {
      final match = Match.local();
      final cube = DoublingCube(match);
      cube.offer(resigner.opponent);

      cube.resign(resigner);

      expect(cube.pendingOffer, isNull);
      expect(cube.offerTimer?.isActive ?? false, isFalse);
      expect(match.state, GameState.over);
    });
  }
}
`;

  const TAVLA_FILES = {
    "README.md": "# Tavla\n\nBackgammon for two, local or online.\n",
    "pubspec.yaml": "name: tavla\ndescription: Backgammon for two.\nversion: 3.4.1+58\n\nenvironment:\n  sdk: ^3.5.0\n",
    "analysis_options.yaml": "include: package:flutter_lints/flutter.yaml\n",
    "lib/main.dart": "import 'package:flutter/material.dart';\n\nimport 'ui/app.dart';\n\nvoid main() => runApp(const TavlaApp());\n",
    "lib/game/doubling_cube.dart": CUBE_AFTER,
    "lib/game/board.dart": "/// Twenty-four points, the bar and two homes.\nclass Board {}\n",
    "lib/game/match.dart": "enum GameState { waiting, playing, over }\n",
    "lib/game/player.dart": "enum Player { white, black }\n",
    "lib/online/match_socket.dart": "/// Relays moves and cube actions between two devices.\nclass MatchSocket {}\n",
    "lib/ui/app.dart": "import 'package:flutter/material.dart';\n\nclass TavlaApp extends StatelessWidget {\n  const TavlaApp({super.key});\n}\n",
    "lib/ui/board_view.dart": "class BoardView {}\n",
    "lib/ui/cube_offer_banner.dart": "class CubeOfferBanner {}\n",
    "test/game/doubling_cube_test.dart": "void main() {}\n",
    "test/game/resign_clears_offer_test.dart": RESIGN_TEST,
  };

  const HEAD = { "lib/game/doubling_cube.dart": CUBE_BEFORE };
  const GIT_STATES = {
    "lib/game/doubling_cube.dart": "modified",
    "lib/ui/cube_offer_banner.dart": "modified",
    "test/game/resign_clears_offer_test.dart": "untracked",
  };

  const readDir = (dir) => {
    const prefix = dir ? `${dir}/` : "";
    const seen = new Map();
    for (const path of Object.keys(TAVLA_FILES)) {
      if (!path.startsWith(prefix)) continue;
      const [name, ...rest] = path.slice(prefix.length).split("/");
      seen.set(name, seen.get(name) || rest.length > 0);
    }
    return [...seen]
      .map(([name, is_dir]) => ({ name, is_dir }))
      .sort((a, b) => Number(b.is_dir) - Number(a.is_dir) || a.name.localeCompare(b.name));
  };

  const relative = (path) => path.replace(`${ROOT}/Tavla/`, "");

  /* ------------------------------------------------------------- terminals */

  const ESC = "\x1b[";
  const c = {
    reset: `${ESC}0m`,
    dim: `${ESC}2m`,
    bold: `${ESC}1m`,
    red: `${ESC}31m`,
    green: `${ESC}32m`,
    yellow: `${ESC}33m`,
    blue: `${ESC}34m`,
    magenta: `${ESC}35m`,
    cyan: `${ESC}36m`,
    gray: `${ESC}90m`,
    orange: `${ESC}38;5;209m`,
  };
  const lines = (...rows) => rows.join("\r\n") + "\r\n";

  const SCREENS = {
    "t-tavla-1": lines(
      `${c.orange}✻${c.reset} ${c.bold}claude${c.reset} ${c.dim}· ${ROOT}/Tavla${c.reset}`,
      "",
      `${c.gray}>${c.reset} After a player resigns, the doubling cube offer stays on screen. Fix it and add a test.`,
      "",
      `${c.reset}⏺ I'll find where the offer is cleared and why resign skips it.`,
      "",
      `⏺ ${c.bold}Search${c.reset}(pattern: "pendingOffer", path: "lib")`,
      `  ${c.gray}⎿  Found 4 matches in 2 files${c.reset}`,
      "",
      `⏺ ${c.bold}Read${c.reset}(lib/game/doubling_cube.dart)`,
      `  ${c.gray}⎿  Read 65 lines${c.reset}`,
      "",
      `⏺ ${c.bold}Update${c.reset}(lib/game/doubling_cube.dart)`,
      `  ${c.gray}⎿  Updated lib/game/doubling_cube.dart with 2 additions${c.reset}`,
      `      ${c.gray}48${c.reset}    void resign(Player by) {`,
      `      ${c.gray}49${c.reset} ${c.green}+    pendingOffer = null;${c.reset}`,
      `      ${c.gray}50${c.reset} ${c.green}+    offerTimer?.cancel();${c.reset}`,
      `      ${c.gray}51${c.reset}      match.state = GameState.over;`,
      "",
      `⏺ ${c.bold}Write${c.reset}(test/game/resign_clears_offer_test.dart)`,
      `  ${c.gray}⎿  Wrote 38 lines${c.reset}`,
      "",
      `⏺ ${c.bold}Bash${c.reset}(flutter test test/game)`,
      `  ${c.gray}⎿  00:04 +27: All tests passed!${c.reset}`,
      "",
      `⏺ Resigning now clears the pending offer and its timer. The new test covers both players.`,
      "",
      `${c.orange}✻${c.reset} Checking the online match path… ${c.dim}(18s · esc to interrupt)${c.reset}`,
    ),
    "t-tavla-2": lines(
      `${c.green}dev@studio${c.reset} ${c.blue}Tavla${c.reset} % flutter analyze`,
      "Analyzing Tavla...",
      "No issues found! (ran in 3.1s)",
      `${c.green}dev@studio${c.reset} ${c.blue}Tavla${c.reset} % `,
    ),
    "t-wolf2048-1": lines(
      `${c.bold}codex${c.reset} ${c.dim}· ${ROOT}/Wolf2048${c.reset}`,
      "",
      `${c.cyan}user${c.reset}`,
      "Add a daily challenge: one seeded board per day, same for every player.",
      "",
      `${c.magenta}codex${c.reset}`,
      "Seeding the board from the UTC date keeps it the same worldwide.",
      `  ${c.green}•${c.reset} Edited lib/modes/daily_challenge.dart ${c.green}(+64)${c.reset}`,
      `  ${c.green}•${c.reset} Edited lib/game/board.dart ${c.green}(+9${c.reset} ${c.red}-2)${c.reset}`,
      `  ${c.green}•${c.reset} Edited lib/ui/menu.dart ${c.green}(+12)${c.reset}`,
      "",
      `${c.yellow}Allow command?${c.reset}`,
      `  $ dart run build_runner build --delete-conflicting-outputs`,
      `  ${c.bold}[y]${c.reset} yes   ${c.bold}[a]${c.reset} always   ${c.bold}[n]${c.reset} no`,
    ),
    "t-sudokov-1": lines(
      `${c.orange}✻${c.reset} ${c.bold}claude${c.reset} ${c.dim}· ${ROOT}/Sudokov${c.reset}`,
      "",
      `${c.gray}>${c.reset} Hints should explain the technique, not just fill the cell.`,
      "",
      `⏺ ${c.bold}Update${c.reset}(lib/hints/hint_engine.dart)`,
      `  ${c.gray}⎿  Updated with 48 additions and 6 removals${c.reset}`,
      "",
      `⏺ ${c.bold}Bash${c.reset}(flutter test)`,
      `  ${c.gray}⎿  00:06 +112: All tests passed!${c.reset}`,
      "",
      `⏺ Hints now name the technique (naked pair, hidden single, X-wing) and highlight`,
      `  the cells that prove it. Reported to Panel.`,
      "",
      `${c.gray}>${c.reset} `,
    ),
    "t-payee-1": lines(
      `${c.green}dev@studio${c.reset} ${c.blue}Payee${c.reset} % flutter test --coverage`,
      "00:02 +18: loading test/split/split_rules_test.dart",
      "00:05 +64: test/currency/rates_cache_test.dart: refreshes after 12 hours",
      `00:07 +93: ${c.green}All tests passed!${c.reset}`,
      `${c.green}dev@studio${c.reset} ${c.blue}Payee${c.reset} % `,
    ),
  };

  /* ---------------------------------------------------------------- events */

  const callbacks = new Map();
  const listeners = new Map();
  let nextId = 1;

  const emit = (event, payload) => {
    for (const handler of listeners.get(event) ?? []) {
      callbacks.get(handler)?.({ event, id: handler, payload });
    }
  };

  const agent = (projectId, sessionId, body) => emit("panel-agent-event", { project: projectId, session_id: sessionId, ...body });

  const REPORTS = [
    {
      project: "fitstrail",
      session: null,
      agent: "codex",
      title: "Strava import is blocked",
      outcome: "blocked",
      text: "Strava rejects the redirect URL. Add the production callback in the Strava API settings.",
    },
    {
      project: "memor",
      session: null,
      agent: "claude",
      title: "Deck import keeps images",
      outcome: "done",
      text: "Anki decks now import with their pictures. Tested with a 2,400-card deck.",
    },
    {
      project: "tavla",
      session: "s-tavla-1",
      title: "Online moves arrive in half the time",
      outcome: "done",
      text: "Moves are batched per turn instead of per checker. Median latency went from 410 ms to 190 ms.",
    },
    {
      project: "sudokov",
      session: "s-sudokov-1",
      title: "Hints explain the technique",
      outcome: "done",
      text: "Every hint now names its technique and highlights the cells that prove it. 112 tests pass.",
    },
    {
      project: "payee",
      session: "s-payee-1",
      title: "Currency cache refreshes twice a day",
      outcome: "done",
      text: "Rates older than 12 hours refresh on launch. Offline launches keep the last rates.",
    },
    {
      project: "wolf2048",
      session: "s-wolf2048-1",
      title: "Daily challenge needs a name",
      outcome: "needs_decision",
      text: "The mode works. Pick a menu label: \"Daily\", \"Today's board\" or \"Daily Wolf\".",
    },
    {
      project: "tavla",
      session: "s-tavla-1",
      title: "Resign clears the cube offer",
      outcome: "progress",
      text: "Local games are fixed and tested. Checking the online match path next.",
    },
  ];

  /** Bring the portfolio to life: terminal screens, agent state, edited files and reports. */
  function play() {
    for (const [terminalId, data] of Object.entries(SCREENS)) {
      emit("panel-terminal-output", { terminalId, data, closed: false });
    }
    for (const s of SESSIONS) {
      if (s.kind === "shell") continue;
      agent(s.project, s.id, { kind: "session_started", provider: s.kind });
    }
    for (const report of REPORTS) {
      agent(report.project, report.session, {
        kind: "visual_requested",
        view: "message",
        title: report.title,
        payload: {
          title: report.title,
          outcome: report.outcome,
          text: report.text,
          _panel_project: report.project,
          // A report from an agent that has since closed names itself; a live one is named by its session.
          ...(report.agent ? { source: report.agent, agent_kind: report.agent } : {}),
        },
      });
    }
    agent("tavla", "s-tavla-1", { kind: "agent_status", status: "thinking", detail: "Fix the doubling cube offer after resign" });
    for (const path of ["lib/game/doubling_cube.dart", "test/game/resign_clears_offer_test.dart"]) {
      agent("tavla", "s-tavla-1", { kind: "file_changed", path: `${ROOT}/Tavla/${path}`, summary: null });
    }
    agent("tavla", "s-tavla-1", {
      kind: "activity",
      activity_id: "a1",
      state: "finished",
      label: "test",
      detail: "flutter test test/game · 27 passed",
      success: true,
    });
    agent("tavla", "s-tavla-1", { kind: "agent_status", status: "working", detail: "Checking the online match path" });
    agent("sudokov", "s-sudokov-1", { kind: "turn_finished", success: true, summary: "Hints explain the technique" });
    agent("wolf2048", "s-wolf2048-1", { kind: "agent_status", status: "waiting", detail: "Allow dart run build_runner?" });
  }

  /* -------------------------------------------------------------- commands */

  const COMMANDS = {
    launch_context: () => ({ single_project: null }),
    list_modules: () => [
      { name: "git-manager", title: "Git", icon: "⎇", project_surfaces: [] },
      { name: "support", title: "Support", icon: "✉", project_surfaces: [] },
    ],
    list_groups: () => [],
    list_projects: () => PROJECTS,
    restore_wall: () => ({ savedAt: 0, sessions: SESSIONS.map((s) => ({ session: s, screen: "" })) }),
    project_dashboard: ({ project: id }) => GIT[id] ?? { branch: "", ahead: 0, behind: 0, dirty: 0, is_repo: false },
    project_modules: () => ({ configured: false, enabled: ["git"], work_exclude: [] }),
    project_standings: () => STANDINGS,
    project_activity: ({ project: id }) => {
      const days = DAYS[id] ?? Array(14).fill(0);
      const last = days.reduce((at, n, i) => (n ? i : at), -1);
      return { last_commit: last >= 0 ? now - (13 - last) * 86_400_000 : 0, days };
    },
    run_inventory: () => ({ devices: [], leases: {}, androidDevices: [], iosDevices: [], targets: [] }),
    session_busy: () => false,
    session_cwd: ({ session: id }) => {
      const s = SESSIONS.find((one) => one.id === id);
      return s ? `${ROOT}/${PROJECTS.find((p) => p.id === s.project).name}` : null;
    },
    file_changes: () => [],
    set_attention: () => null,
    resize_terminal: () => null,
    write_terminal: () => null,
    read_dir: ({ path }) => readDir(path),
    read_file: ({ path }) => {
      const text = TAVLA_FILES[relative(path)];
      if (text === undefined) throw new Error(`no such file: ${path}`);
      return text;
    },
    git_file_states: () => GIT_STATES,
    git_head_file: ({ path }) => HEAD[relative(path)] ?? TAVLA_FILES[relative(path)] ?? null,
    project_files: () => Object.keys(TAVLA_FILES),
    file_relationships: () => [
      { path: "lib/game/match.dart", line: 3, direction: "outgoing", detail: "import 'match.dart'" },
      { path: "lib/game/player.dart", line: 4, direction: "outgoing", detail: "import 'player.dart'" },
      { path: "lib/ui/cube_offer_banner.dart", line: 7, direction: "incoming", detail: "DoublingCube" },
      { path: "test/game/resign_clears_offer_test.dart", line: 2, direction: "incoming", detail: "DoublingCube" },
    ],
    symbol_locations: () => [],
    project_symbols: () => [],
    warm_code_nav: () => null,
    debug_breakpoints: () => ({}),
    debug_profiles: () => [],
    debug_targets: () => [],
    debug_status: () => ({ active: false, phase: "idle", threadId: null }),
    debug_set_breakpoints: () => null,
    module_request: ({ path }) => {
      if (path.startsWith("/m/support/inbox")) return { unread: 2, items: [] };
      const name = path.split("/")[2];
      // The real host answers a module that is not installed with a 404, and the UI handles that.
      if (!["git-manager", "support"].includes(name)) throw new Error(`unknown module: ${name}`);
      console.log("[demo] unhandled module route", path);
      return {};
    },
    "plugin:event|listen": ({ event, handler }) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
      return nextId++;
    },
    "plugin:event|unlisten": () => null,
  };

  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback(callback) {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    unregisterCallback: (id) => callbacks.delete(id),
    convertFileSrc: (path) => path,
    async invoke(cmd, args = {}) {
      const answer = COMMANDS[cmd];
      if (answer) return answer(args);
      if (cmd.startsWith("plugin:")) return null;
      console.log("[demo] unhandled", cmd, JSON.stringify(args).slice(0, 120));
      return null;
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__panelDemo = { play, emit };
})();
