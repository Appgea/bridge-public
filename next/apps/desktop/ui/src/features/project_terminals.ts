/** Project terminal controls. Sessions stay inside this full-screen tab. */

import { ENGINES, type SessionKind } from "./agent-kinds";
import { label as chordText } from "./keymap";
import { icon } from "../icons";
import type { ProjectRunView } from "./runner";
import type { Session } from "../types";
import "./project_terminals.css";

export type ProjectTerminalsEvents = {
  /** Open a new PTY on the selected project. */
  openSession(kind: SessionKind): void;
  /** Start on the selected target. `allowExtra` answers a simulator capacity block. */
  run(allowExtra: boolean): void;
  targetPicker(projectId: string): HTMLElement;
  stop(): void;
  /** "r" hot reload, or "R" hot restart. */
  nudge(restart: boolean): void;
  focusSimulator(): void;
  /** Jump to the portfolio-wide Runs screen, pointed at this project. */
  openRuns(): void;
};

export type ProjectTerminalsHandle = {
  /** Which project the tab is about. Null while nothing is selected. */
  setProject(projectId: string | null): void;
  /**
   * Repaint from truth. Called on session changes, run-state changes and tab entry — it reads
   * everything it needs from the arguments and the run view, so it is safe to call often.
   */
  sync(sessions: Session[], exited: ReadonlySet<string>, run: ProjectRunView | null): void;
};

const make = (tag: string, className: string): HTMLElement => {
  const node = document.createElement(tag);
  node.className = className;
  return node;
};

/** How a run state reads to a human, and how loud it is allowed to be. */
function stateLabel(run: ProjectRunView): { text: string; tone: string } {
  switch (run.state) {
    case "idle":
      return { text: "not running", tone: "t-mute" };
    case "launching":
      return { text: "launching", tone: "t-live" };
    case "building":
      return { text: "building", tone: "t-live" };
    case "running":
      return { text: "running", tone: "t-ok" };
    case "reloaded":
      return { text: "reloaded", tone: "t-ok" };
    case "restarted":
      return { text: "restarted", tone: "t-ok" };
    case "error":
      return { text: "failed", tone: "t-risk" };
    case "paused":
      return { text: "paused", tone: "t-warn" };
    case "stopped":
      return { text: "stopped", tone: "t-mute" };
    default:
      return { text: run.state, tone: "t-mute" };
  }
}

export function mountProjectTerminals(
  host: HTMLElement,
  events: ProjectTerminalsEvents,
): ProjectTerminalsHandle {
  host.classList.add("pt-root");

  let projectId: string | null = null;
  /** The human asked to see the build output. Sticky per project — a failure that opened it
   *  itself must not slam shut on the next repaint. */
  const logOpen = new Set<string>();

  /* ------------------------------------------------------------------- run */

  const runRow = make("div", "pt-row pt-run");
  runRow.hidden = true;

  const runLabel = make("span", "pt-key");
  runLabel.textContent = "RUN";
  const targetSlot = make("span", "pt-target");

  const goButton = document.createElement("button");
  goButton.type = "button";
  goButton.className = "pt-go";

  const statePill = make("span", "pt-state");
  statePill.innerHTML = `<i aria-hidden="true"></i><b></b><small></small>`;
  const stateText = statePill.querySelector("b")!;
  const stateNote = statePill.querySelector("small")!;

  const verb = (
    className: string,
    label: string,
    glyph: Parameters<typeof icon>[0] | null,
    title: string,
    action: () => void,
  ): HTMLButtonElement => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `pt-verb ${className}`;
    button.title = title;
    button.innerHTML = `${glyph ? icon(glyph) : ""}<span>${label}</span>`;
    button.addEventListener("click", action);
    return button;
  };

  const reloadButton = verb("pt-reload", "Reload", "reload", "Hot reload — injects the change and keeps state", () =>
    events.nudge(false),
  );
  const restartButton = verb("pt-restart", "Restart", "rebuild", "Hot restart — rebuilds and reattaches", () =>
    events.nudge(true),
  );
  const focusButton = verb("pt-focus", "Show device", null, "Bring the device window forward", () =>
    events.focusSimulator(),
  );
  const logButton = verb("pt-logbtn", "Output", "log", "Show the run output — build errors live here", () => {
    if (!projectId) return;
    if (logOpen.has(projectId)) logOpen.delete(projectId);
    else logOpen.add(projectId);
    paint();
  });
  const runsButton = verb("pt-runs", "All runs", null, "Open the portfolio-wide Runs screen here", () =>
    events.openRuns(),
  );

  goButton.addEventListener("click", () => {
    const current = view;
    if (!current || current.busy) return;
    if (current.live) events.stop();
    else events.run(false);
  });

  runRow.append(runLabel, targetSlot, goButton, statePill, reloadButton, restartButton, focusButton, logButton, runsButton);

  /* --------------------------------------------------------------- sessions */

  const newRow = make("div", "pt-row pt-new");
  const newLabel = make("span", "pt-key");
  newLabel.textContent = "NEW";
  newRow.append(newLabel);

  for (const engine of ENGINES) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `pt-engine is-${engine.kind}`;
    chip.title = `New ${engine.name} terminal on this project`;
    chip.innerHTML = `${icon(engine.glyph)}<span>${engine.name}</span>`;
    if (engine.sub) {
      const tag = document.createElement("small");
      tag.className = "pt-engine-sub";
      tag.textContent = engine.sub;
      chip.append(tag);
    }
    chip.addEventListener("click", () => events.openSession(engine.kind));
    newRow.append(chip);
  }

  const countNote = make("small", "pt-count");
  newRow.append(countNote);

  /* ------------------------------------------------------ notices and log */

  const notice = make("p", "pt-notice");
  notice.hidden = true;

  const capacity = make("div", "pt-capacity");
  capacity.hidden = true;
  const capacityText = make("span", "pt-capacity-text");
  const capacityGo = document.createElement("button");
  capacityGo.type = "button";
  capacityGo.className = "pt-verb pt-capacity-go";
  capacityGo.textContent = "Open another anyway";
  capacityGo.addEventListener("click", () => events.run(true));
  capacity.append(capacityText, capacityGo);

  const logOut = document.createElement("pre");
  logOut.className = "pt-log";
  logOut.hidden = true;

  host.replaceChildren(runRow, newRow, capacity, notice, logOut);

  /* ------------------------------------------------------------------ paint */

  let sessions: Session[] = [];
  let dead: ReadonlySet<string> = new Set();
  let view: ProjectRunView | null = null;

  const paint = (): void => {
    const live = sessions.filter((session) => !dead.has(session.id)).length;
    // With none open, the terminal area says so once (#terminalEmpty); this note only counts.
    countNote.textContent = sessions.length ? `${live} live · ${sessions.length} open` : "";

    if (!view) {
      // Not a launchable app (no pubspec, no iOS target) — or Panel does not know yet. An
      // absent control beats a Run button whose only possible outcome is an error.
      runRow.hidden = true;
      capacity.hidden = true;
      notice.hidden = true;
      logOut.hidden = true;
      return;
    }
    runRow.hidden = false;

    const { text, tone } = stateLabel(view);
    statePill.className = `pt-state ${tone}`;
    stateText.textContent = view.busy ? "working…" : text;
    const build = view.ms ? `${(view.ms / 1000).toFixed(1)}s build` : "";
    stateNote.textContent = [view.device, build].filter(Boolean).join(" · ");

    goButton.disabled = view.busy;
    goButton.classList.toggle("is-stop", view.live);
    goButton.innerHTML = view.live
      ? `${icon("stop")}<span>Stop</span>`
      : `${icon("play")}<span>Run app</span>`;
    goButton.title = view.live
      ? `Stop this run and release its device — ${chordText("app.stopApp")}`
      : `Build and launch on the selected device — ${chordText("app.runApp")}`;

    // Only flutter has hot reload, and only a simulator target has a window to bring forward —
    // godot runs on the desktop. Same rules the Runs card follows.
    const flutterLive = view.live && view.kind === "flutter";
    reloadButton.hidden = !flutterLive;
    restartButton.hidden = !flutterLive;
    focusButton.hidden = !view.live || !view.canFocus;

    logButton.hidden = !view.hasLog;
    const showLog = view.hasLog && !!projectId && logOpen.has(projectId);
    logButton.classList.toggle("is-active", showLog);
    logOut.hidden = !showLog;
    if (showLog) {
      // Follow the tail unless the human has scrolled up to read something.
      const pinned = logOut.scrollTop + logOut.clientHeight >= logOut.scrollHeight - 24;
      logOut.textContent = view.log();
      if (pinned) logOut.scrollTop = logOut.scrollHeight;
    }

    capacity.hidden = !view.capacity;
    if (view.capacity) {
      capacityText.textContent = `${view.capacity.booted} simulators already open (ceiling ${view.capacity.cap}).`;
    }

    const message = view.queued ? "Queued — starts as soon as a simulator slot frees up." : view.error;
    notice.hidden = !message;
    notice.classList.toggle("is-error", !!view.error && !view.queued);
    if (message) notice.textContent = message;
  };

  return {
    setProject(next) {
      if (projectId !== next) {
        targetSlot.replaceChildren(...(next ? [events.targetPicker(next)] : []));
      }
      projectId = next;
    },
    sync(nextSessions, exited, run) {
      sessions = nextSessions;
      dead = exited;
      view = run;
      // A failed or dead-on-arrival run should explain itself without making the human find the
      // Output button, exactly as the Runs card does.
      if (projectId && run && (run.state === "error" || run.error)) logOpen.add(projectId);
      paint();
    },
  };
}
