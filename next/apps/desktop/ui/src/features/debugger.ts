/**
 * Project debugger.
 *
 * Rust owns adapter processes and DAP framing. This screen owns only debugger state humans act
 * on: profiles, controls, call stacks, variables, output and persisted breakpoints.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  announceBreakpoints,
  announceDebugPhase,
  BREAKPOINTS_EVENT,
  type BreakpointsChanged,
  type DebugCommand,
} from "./debug_events";
import "./debugger.css";

type DebugProfile = {
  id: string;
  name: string;
  adapter: string;
  targeted: boolean;
  automatic: boolean;
};

type DebugTarget = {
  id: string;
  name: string;
  runtime: string;
  booted: boolean;
  heldBy: string | null;
  heldKind: string | null;
  owns: boolean;
};

type DapMessage = {
  type: "event" | "response" | "request";
  event?: string;
  command?: string;
  success?: boolean;
  message?: string;
  body?: Record<string, unknown>;
};

type DebugEnvelope = { project: string; message: DapMessage };
type Phase = "idle" | "starting" | "running" | "paused" | "ended" | "error";
type BackendStatus = { active: boolean; phase: string; threadId: number | null };

type StackFrame = {
  id: number;
  name: string;
  line: number;
  column: number;
  source?: { name?: string; path?: string };
};

type Scope = { name: string; variablesReference: number; expensive?: boolean };
type Variable = {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
};

type ProjectDebug = {
  phase: Phase;
  profile: string;
  target: string;
  profiles: DebugProfile[];
  targets: DebugTarget[];
  breakpoints: Map<string, number[]>;
  output: string[];
  threadId: number | null;
  frameId: number | null;
  frames: StackFrame[];
  error: string;
};

export type DebuggerHandle = {
  setProject(project: string, path: string): Promise<void>;
  start(): void;
  /**
   * Drive the session from another surface. Work's debug bar sends exactly the commands this
   * screen's own toolbar sends, through here — one implementation, two sets of buttons.
   */
  command(command: DebugCommand): void;
  /**
   * Evaluate one expression in the selected frame. Null when there is no frame to ask in, or
   * when the adapter cannot resolve it — a hover has nothing to say about a keyword, and saying
   * so with an error popup would make reading paused code unbearable.
   */
  evaluate(expression: string): Promise<string | null>;
};

export type DebuggerEvents = {
  open(path: string, line: number): void;
};

const make = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const text = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const basename = (path: string): string => path.split("/").pop() || path;

function fresh(): ProjectDebug {
  return {
    phase: "idle",
    profile: "",
    target: "",
    profiles: [],
    targets: [],
    breakpoints: new Map(),
    output: [],
    threadId: null,
    frameId: null,
    frames: [],
    error: "",
  };
}

export function mountDebugger(host: HTMLElement, events: DebuggerEvents): DebuggerHandle {
  host.classList.add("dbg-root");
  host.replaceChildren();

  const toolbar = make("header", "dbg-toolbar");
  const status = make("span", "dbg-status");
  const statusDot = make("i");
  const statusText = make("b", undefined, "Ready");
  status.append(statusDot, statusText);

  const profileSelect = make("select", "dbg-select");
  profileSelect.setAttribute("aria-label", "Debug profile");
  const targetSelect = make("select", "dbg-select dbg-target");
  targetSelect.setAttribute("aria-label", "Debug target");

  const start = make("button", "dbg-primary", "Start");
  start.type = "button";
  const controls = make("div", "dbg-controls");
  const action = (label: string, title: string, command: string): HTMLButtonElement => {
    const button = make("button", "dbg-action", label);
    button.type = "button";
    button.title = title;
    button.dataset.command = command;
    controls.append(button);
    return button;
  };
  const resume = action("▶", "Continue", "continue");
  const pause = action("Ⅱ", "Pause", "pause");
  const stepOver = action("↷", "Step over", "next");
  const stepIn = action("↓", "Step into", "stepIn");
  const stepOut = action("↑", "Step out", "stepOut");
  action("■", "Stop", "stop");
  toolbar.append(status, profileSelect, targetSelect, start, controls);

  const body = make("div", "dbg-body");
  const stackPanel = make("section", "dbg-panel dbg-stack-panel");
  const stackHead = make("header", "dbg-panel-head", "Call stack");
  const stack = make("div", "dbg-list dbg-stack");
  const breakpointHead = make("header", "dbg-panel-head dbg-breakpoint-head", "Breakpoints");
  const breakpointHint = make("small", "dbg-hint", "Click beside a line number in Work.");
  const breakpointList = make("div", "dbg-list dbg-breakpoints");
  stackPanel.append(stackHead, stack, breakpointHead, breakpointHint, breakpointList);

  const variablesPanel = make("section", "dbg-panel dbg-vars-panel");
  variablesPanel.append(make("header", "dbg-panel-head", "Variables"));
  const variables = make("div", "dbg-vars");
  variablesPanel.append(variables);

  const consolePanel = make("section", "dbg-panel dbg-console-panel");
  const consoleHead = make("header", "dbg-panel-head", "Debug console");
  const output = make("pre", "dbg-output");
  const repl = make("form", "dbg-repl");
  const prompt = make("span", undefined, ">");
  const expression = make("input");
  expression.type = "text";
  expression.placeholder = "Evaluate expression";
  expression.autocomplete = "off";
  expression.spellcheck = false;
  repl.append(prompt, expression);
  consolePanel.append(consoleHead, output, repl);
  body.append(stackPanel, variablesPanel, consolePanel);

  const empty = make("div", "dbg-empty");
  host.append(toolbar, body, empty);

  const states = new Map<string, ProjectDebug>();
  const roots = new Map<string, string>();
  let project: string | null = null;

  const current = (): ProjectDebug | null => (project ? states.get(project) ?? null : null);

  const projectPath = (owner: string, path: string): string => {
    const root = roots.get(owner)?.replace(/\/$/, "");
    return root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  };

  function phaseLabel(state: ProjectDebug): string {
    if (state.error) return state.error;
    switch (state.phase) {
      case "starting": return "Starting";
      case "running": return "Running";
      case "paused": return "Paused";
      case "ended": return "Stopped";
      case "error": return "Debug failed";
      default: return "Ready";
    }
  }

  /**
   * Say where this session is, once per real change.
   *
   * `paint()` runs on every DAP frame, and Work reacts to this by OPENING a file — so a naive
   * re-announce would yank the editor around several times a second. The key collapses a repaint
   * into silence and lets only an actual move through.
   */
  let announced = "";
  function announce(owner: string, state: ProjectDebug): void {
    const frame = state.phase === "paused" ? state.frames[0] : undefined;
    const source = text(frame?.source?.path, text(frame?.source?.name));
    const at = frame && source ? { path: projectPath(owner, source), line: frame.line } : null;
    const detail = {
      project: owner,
      phase: state.phase,
      canStart: state.profiles.length > 0,
      at,
      error: state.error,
    };
    const key = JSON.stringify(detail);
    if (key === announced) return;
    announced = key;
    announceDebugPhase(detail);
  }

  function paint(): void {
    const state = current();
    if (!state) return;
    if (project) announce(project, state);
    host.dataset.phase = state.phase;
    statusText.textContent = phaseLabel(state);
    const live = state.phase === "starting" || state.phase === "running" || state.phase === "paused";
    start.hidden = live;
    profileSelect.disabled = live;
    targetSelect.disabled = live;
    controls.hidden = !live;
    resume.disabled = state.phase !== "paused";
    pause.disabled = state.phase !== "running";
    stepOver.disabled = state.phase !== "paused";
    stepIn.disabled = state.phase !== "paused";
    stepOut.disabled = state.phase !== "paused";
    empty.hidden = state.profiles.length > 0;
    body.hidden = state.profiles.length === 0;
    toolbar.hidden = state.profiles.length === 0;
    if (!state.profiles.length) {
      empty.replaceChildren(
        make("b", undefined, "Nothing to debug here yet"),
        make("p", undefined, "Flutter, Dart and native iOS apps are found on their own."),
        make("p", undefined, "For anything else, add .panel/debug.json naming its adapter."),
      );
      return;
    }
    paintProfiles(state);
    paintTargets(state);
    paintStack(state);
    paintBreakpoints(state);
    output.textContent = state.output.join("");
    output.scrollTop = output.scrollHeight;
  }

  function paintProfiles(state: ProjectDebug): void {
    const key = state.profiles.map((profile) => `${profile.id}:${profile.name}`).join("|");
    if (profileSelect.dataset.key !== key) {
      profileSelect.dataset.key = key;
      profileSelect.replaceChildren();
      for (const profile of state.profiles) {
        const option = document.createElement("option");
        option.value = profile.id;
        option.textContent = profile.automatic ? profile.name : `${profile.name} · project`;
        profileSelect.append(option);
      }
    }
    if (!state.profile || !state.profiles.some(({ id }) => id === state.profile)) {
      state.profile = state.profiles[0]?.id ?? "";
    }
    profileSelect.value = state.profile;
  }

  function paintTargets(state: ProjectDebug): void {
    const selected = state.profiles.find(({ id }) => id === state.profile);
    targetSelect.hidden = !selected?.targeted;
    if (!selected?.targeted) return;
    const key = state.targets
      .map((target) => `${target.id}:${target.booted}:${target.heldBy ?? ""}:${target.owns}`)
      .join("|");
    if (targetSelect.dataset.key !== key) {
      targetSelect.dataset.key = key;
      const automatic = document.createElement("option");
      automatic.value = "";
      automatic.textContent = "Auto target";
      targetSelect.replaceChildren(automatic);
      for (const target of state.targets) {
        const option = document.createElement("option");
        option.value = target.id;
        option.disabled = target.heldBy !== null;
        const suffix = target.heldBy
          ? ` · ${target.heldBy} is ${target.heldKind === "capture" ? "capturing" : target.heldKind === "debug" ? "debugging" : "running"}`
          : target.owns
            ? " · its device"
            : target.runtime
              ? ` · ${target.runtime}`
              : "";
        option.textContent = `${target.name}${suffix}`;
        targetSelect.append(option);
      }
    }
    if (state.target && !state.targets.some(({ id }) => id === state.target)) state.target = "";
    targetSelect.value = state.target;
  }

  function paintStack(state: ProjectDebug): void {
    stack.replaceChildren();
    if (state.phase !== "paused") {
      stack.append(make("p", "dbg-muted", state.phase === "running" ? "Program is running." : "No paused thread."));
      return;
    }
    for (const frame of state.frames) {
      const button = make("button", "dbg-stack-row");
      button.type = "button";
      button.classList.toggle("is-selected", frame.id === state.frameId);
      const title = make("b", undefined, frame.name);
      const source = text(frame.source?.path, text(frame.source?.name));
      const detail = make("small", undefined, source ? `${basename(source)}:${frame.line}` : "runtime frame");
      button.append(title, detail);
      button.addEventListener("click", () => void selectFrame(state, frame, true));
      stack.append(button);
    }
    if (!state.frames.length) stack.append(make("p", "dbg-muted", "No frames reported."));
  }

  function paintBreakpoints(state: ProjectDebug): void {
    breakpointList.replaceChildren();
    for (const [path, lines] of [...state.breakpoints].sort(([a], [b]) => a.localeCompare(b))) {
      for (const line of lines) {
        const row = make("div", "dbg-breakpoint-row");
        const open = make("button");
        open.type = "button";
        open.append(make("i"), make("span", undefined, `${path}:${line}`));
        open.addEventListener("click", () => events.open(path, line));
        const remove = make("button", "dbg-remove", "×");
        remove.type = "button";
        remove.title = "Remove breakpoint";
        remove.addEventListener("click", () => void removeBreakpoint(state, path, line));
        row.append(open, remove);
        breakpointList.append(row);
      }
    }
    if (!state.breakpoints.size) breakpointList.append(make("p", "dbg-muted", "No breakpoints."));
  }

  async function removeBreakpoint(state: ProjectDebug, path: string, line: number): Promise<void> {
    if (!project) return;
    const owner = project;
    const lines = (state.breakpoints.get(path) ?? []).filter((candidate) => candidate !== line);
    if (lines.length) state.breakpoints.set(path, lines);
    else state.breakpoints.delete(path);
    announceBreakpoints({ project: owner, path, lines });
    paint();
    try {
      await invoke("debug_set_breakpoints", { project: owner, path, lines });
    } catch (error) {
      state.error = String(error);
      await loadBreakpoints(owner, state);
      announceBreakpoints({ project: owner, path, lines: state.breakpoints.get(path) ?? [] });
      paint();
    }
  }

  async function loadBreakpoints(owner: string, state: ProjectDebug): Promise<void> {
    const stored = await invoke<Record<string, number[]>>("debug_breakpoints", { project: owner });
    state.breakpoints = new Map(Object.entries(stored));
  }

  async function dap<T = Record<string, unknown>>(
    owner: string,
    command: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    return invoke<T>("debug_request", { project: owner, command, arguments: args });
  }

  async function refreshStopped(owner: string, state: ProjectDebug, threadId: number | null): Promise<void> {
    try {
      let chosen = threadId;
      if (chosen === null) {
        const body = await dap<{ threads?: Array<{ id: number }> }>(owner, "threads");
        chosen = body.threads?.[0]?.id ?? null;
      }
      if (project !== owner || state.phase !== "paused") return;
      state.threadId = chosen;
      if (chosen === null) {
        state.frames = [];
        paint();
        return;
      }
      const body = await dap<{ stackFrames?: StackFrame[] }>(owner, "stackTrace", {
        threadId: chosen,
        startFrame: 0,
        levels: 50,
      });
      if (project !== owner || state.phase !== "paused") return;
      state.frames = body.stackFrames ?? [];
      const first = state.frames[0];
      state.frameId = first?.id ?? null;
      paint();
      if (first) await selectFrame(state, first, false);
    } catch (error) {
      state.error = String(error);
      state.phase = "error";
      paint();
    }
  }

  async function selectFrame(state: ProjectDebug, frame: StackFrame, openSource: boolean): Promise<void> {
    if (!project) return;
    const owner = project;
    state.frameId = frame.id;
    paintStack(state);
    if (openSource && frame.source?.path) {
      events.open(projectPath(owner, frame.source.path), frame.line);
    }
    variables.replaceChildren(make("p", "dbg-muted", "Loading variables…"));
    try {
      const body = await dap<{ scopes?: Scope[] }>(owner, "scopes", { frameId: frame.id });
      if (project !== owner || state.frameId !== frame.id) return;
      variables.replaceChildren();
      for (const scope of body.scopes ?? []) {
        const group = make("section", "dbg-scope");
        group.append(make("header", undefined, scope.name));
        const list = make("div", "dbg-variable-list");
        group.append(list);
        variables.append(group);
        void loadVariables(owner, scope.variablesReference, list);
      }
      if (!body.scopes?.length) variables.append(make("p", "dbg-muted", "No variables reported."));
    } catch (error) {
      variables.replaceChildren(make("p", "dbg-error", String(error)));
    }
  }

  async function loadVariables(owner: string, reference: number, host: HTMLElement): Promise<void> {
    try {
      const body = await dap<{ variables?: Variable[] }>(owner, "variables", {
        variablesReference: reference,
      });
      if (project !== owner) return;
      host.replaceChildren();
      for (const variable of body.variables ?? []) {
        const row = make("div", "dbg-variable");
        const line: HTMLButtonElement | HTMLDivElement = variable.variablesReference
          ? make("button", "dbg-variable-line")
          : make("div", "dbg-variable-line");
        if (line instanceof HTMLButtonElement) line.type = "button";
        const name = make("b", undefined, variable.name);
        const value = make("span", undefined, variable.value);
        if (variable.type) value.title = variable.type;
        line.append(name, value);
        row.append(line);
        if (variable.variablesReference) {
          const children = make("div", "dbg-variable-children");
          children.hidden = true;
          let loaded = false;
          line.addEventListener("click", () => {
            children.hidden = !children.hidden;
            row.classList.toggle("is-open", !children.hidden);
            if (!loaded) {
              loaded = true;
              children.append(make("p", "dbg-muted", "Loading…"));
              void loadVariables(owner, variable.variablesReference, children);
            }
          });
          row.append(children);
        }
        host.append(row);
      }
      if (!body.variables?.length) host.append(make("p", "dbg-muted", "Empty."));
    } catch (error) {
      host.replaceChildren(make("p", "dbg-error", String(error)));
    }
  }

  function appendOutput(state: ProjectDebug, value: string): void {
    if (!value) return;
    state.output.push(value);
    while (state.output.length > 700) state.output.shift();
  }

  async function onMessage(envelope: DebugEnvelope): Promise<void> {
    const state = states.get(envelope.project) ?? fresh();
    states.set(envelope.project, state);
    const message = envelope.message;
    if (message.type === "event") {
      switch (message.event) {
        case "panelSession":
          state.phase = "starting";
          state.error = "";
          break;
        case "initialized":
        case "process":
        case "continued":
          state.phase = "running";
          state.error = "";
          state.frames = [];
          state.frameId = null;
          break;
        case "stopped": {
          state.phase = "paused";
          state.error = "";
          const threadId = number(message.body?.threadId);
          state.threadId = threadId;
          if (project === envelope.project) void refreshStopped(envelope.project, state, threadId);
          break;
        }
        case "output":
          appendOutput(state, text(message.body?.output));
          break;
        case "exited":
        case "terminated":
          state.phase = "ended";
          state.threadId = null;
          state.frameId = null;
          state.frames = [];
          break;
      }
    } else if (message.type === "response" && message.success === false) {
      state.error = message.message ?? "Debugger request failed";
      appendOutput(state, `${state.error}\n`);
    }
    if (project === envelope.project) paint();
  }

  void listen<DebugEnvelope>("panel-debug-event", ({ payload }) => void onMessage(payload));
  window.addEventListener(BREAKPOINTS_EVENT, (event) => {
    const detail = (event as CustomEvent<BreakpointsChanged>).detail;
    if (!detail) return;
    const state = states.get(detail.project);
    if (!state) return;
    if (detail.lines.length) state.breakpoints.set(detail.path, detail.lines);
    else state.breakpoints.delete(detail.path);
    if (project === detail.project) paintBreakpoints(state);
  });

  profileSelect.addEventListener("change", () => {
    const state = current();
    if (!state) return;
    state.profile = profileSelect.value;
    state.target = "";
    paint();
  });
  targetSelect.addEventListener("change", () => {
    const state = current();
    if (state) state.target = targetSelect.value;
  });

  function startDebug(): void {
    const state = current();
    if (!state || !project || !state.profile) return;
    const owner = project;
    state.phase = "starting";
    state.error = "";
    state.output = [];
    state.frames = [];
    variables.replaceChildren(make("p", "dbg-muted", "Waiting for a breakpoint."));
    paint();
    void invoke("debug_start", {
      project: owner,
      profile: state.profile,
      target: state.target || null,
    }).catch((error) => {
      state.phase = "error";
      state.error = String(error);
      appendOutput(state, `${String(error)}\n`);
      if (project === owner) paint();
    });
  }

  start.addEventListener("click", startDebug);

  controls.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-command]");
    if (button) runCommand(button.dataset.command as DebugCommand);
  });

  /** The one implementation behind both toolbars — this screen's, and Work's debug bar. */
  function runCommand(command: DebugCommand): void {
    const state = current();
    if (!state || !project) return;
    const owner = project;
    if (command === "stop") {
      state.phase = "ended";
      paint();
      void invoke("debug_stop", { project: owner }).catch((error) => {
        state.error = String(error);
        if (project === owner) paint();
      });
      return;
    }
    if (command === "continue" || command === "next" || command === "stepIn" || command === "stepOut") {
      state.phase = "running";
      state.frames = [];
      paint();
    }
    void (async () => {
      let threadId = state.threadId;
      if (threadId === null) {
        const body = await dap<{ threads?: Array<{ id: number }> }>(owner, "threads");
        threadId = body.threads?.[0]?.id ?? null;
      }
      if (threadId === null) throw new Error("The debugger reported no active thread.");
      await dap(owner, command, { threadId });
    })().catch((error) => {
      state.error = String(error);
      if (project === owner) paint();
    });
  }

  repl.addEventListener("submit", (event) => {
    event.preventDefault();
    const state = current();
    const value = expression.value.trim();
    if (!state || !project || !value || state.frameId === null) return;
    const owner = project;
    expression.value = "";
    appendOutput(state, `> ${value}\n`);
    paint();
    void dap<{ result?: string }>(owner, "evaluate", {
      expression: value,
      frameId: state.frameId,
      context: "repl",
    })
      .then((body) => {
        appendOutput(state, `${body.result ?? ""}\n`);
        if (project === owner) paint();
      })
      .catch((error) => {
        appendOutput(state, `${String(error)}\n`);
        if (project === owner) paint();
      });
  });

  return {
    async setProject(owner, path) {
      project = owner;
      roots.set(owner, path);
      // The key dedupes repaints, not projects. Coming back to an app must re-announce, or Work
      // sits with a blank debug bar until the session happens to move.
      announced = "";
      const state = states.get(owner) ?? fresh();
      states.set(owner, state);
      state.error = "";
      paint();
      try {
        const [profiles, targets, stored, live] = await Promise.all([
          invoke<DebugProfile[]>("debug_profiles", { project: owner }),
          invoke<DebugTarget[]>("debug_targets", { project: owner }).catch(() => []),
          invoke<Record<string, number[]>>("debug_breakpoints", { project: owner }),
          invoke<BackendStatus>("debug_status", { project: owner }),
        ]);
        if (project !== owner) return;
        state.profiles = profiles;
        state.targets = targets;
        state.breakpoints = new Map(Object.entries(stored));
        if (live.active) {
          state.phase = live.phase === "paused" ? "paused" : live.phase === "starting" ? "starting" : "running";
          state.threadId = live.threadId;
        } else if (state.phase !== "error") {
          state.phase = "idle";
          state.threadId = null;
        }
        if (!state.profile || !profiles.some(({ id }) => id === state.profile)) {
          state.profile = profiles[0]?.id ?? "";
        }
        if (state.phase === "paused") {
          void refreshStopped(owner, state, state.threadId);
        }
      } catch (error) {
        state.error = String(error);
        state.phase = "error";
      }
      if (project === owner) paint();
    },
    start: startDebug,
    command: runCommand,
    async evaluate(expression) {
      const state = current();
      if (!state || !project || state.phase !== "paused" || state.frameId === null) return null;
      const owner = project;
      try {
        const body = await dap<{ result?: string }>(owner, "evaluate", {
          expression,
          frameId: state.frameId,
          context: "hover",
        });
        const value = body.result ?? "";
        return value === "" ? null : value;
      } catch {
        return null; // not a variable here — stay silent rather than shout
      }
    },
  };
}
