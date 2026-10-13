/**
 * The living workshop.
 *
 * This is deliberately not a second transcript and not a task manager. It observes facts Panel
 * already has and turns them into one calm scene: agents at the bench, one station per edited
 * file, and one checkpoint for verification / git. Repeated events mutate those objects; they do
 * not append noise.
 *
 * Every interaction is optional. A file station opens the real editor. Nothing here prompts an
 * agent, marks work reviewed, awards points, or invents progress the hooks did not prove.
 */

import type { ChangeStep, Project, WorkFile } from "../types";
import "./workshop.css";

export type WorkshopPhase = "idle" | "working" | "asking" | "done" | "error";

export type WorkshopHandle = {
  root: HTMLElement;
  begin(prompt?: string | null): void;
  setPhase(phase: WorkshopPhase, detail?: string | null): void;
  setAgents(labels: string[]): void;
  fileChanged(path: string): void;
  setRelevant(list: WorkFile[]): void;
  addRelevant(file: WorkFile): void;
  checkpoint(kind: string, label?: string | null, ok?: boolean | null): void;
};

type FileStation = {
  root: HTMLButtonElement;
  count: HTMLElement;
  timer: number;
  edits: number;
};

const base = (path: string): string => path.split("/").pop() || path;

function robot(label: string, index: number): HTMLElement {
  const node = document.createElement("div");
  node.className = "ws-robot";
  node.style.setProperty("--seat", String(index));
  node.innerHTML = `
    <span class="ws-robot-body" aria-hidden="true">
      <i class="ws-antenna"></i>
      <i class="ws-eye e-one"></i><i class="ws-eye e-two"></i>
      <i class="ws-arm"></i>
    </span>
    <small></small>`;
  node.querySelector("small")!.textContent = label;
  return node;
}

export function createWorkshop(
  project: Project,
  open: (path: string) => void,
  loadChanges: (path: string) => Promise<ChangeStep[]>,
): WorkshopHandle {
  const root = document.createElement("section");
  root.className = "workshop is-idle";
  root.innerHTML = `
    <header class="ws-head">
      <span><i></i> LIVE WORKSHOP</span>
      <b>at rest</b>
    </header>
    <div class="ws-scene">
      <div class="ws-bay" aria-label="active agents"></div>
      <div class="ws-floor">
        <div class="ws-empty">
          <i aria-hidden="true">✦</i>
          <b>The bench is clear</b>
          <small>Edited files will become working stations here.</small>
        </div>
        <div class="ws-files"></div>
      </div>
      <div class="ws-checkpoint is-empty">
        <i aria-hidden="true"></i><span><b>No checkpoint yet</b><small>Tests, builds and Git land here.</small></span>
      </div>
      <section class="ws-replay" hidden>
        <header><span><b></b><small></small></span><button class="ws-replay-close" type="button" aria-label="Close replay">×</button></header>
        <nav><button class="ws-replay-prev" type="button">← Previous</button><span></span><button class="ws-replay-next" type="button">Next →</button><button class="ws-replay-open" type="button">Open editor</button></nav>
        <div class="ws-diff" aria-label="Change replay"></div>
      </section>
    </div>`;

  const phase = root.querySelector<HTMLElement>(".ws-head b")!;
  const bay = root.querySelector<HTMLElement>(".ws-bay")!;
  const empty = root.querySelector<HTMLElement>(".ws-empty")!;
  const files = root.querySelector<HTMLElement>(".ws-files")!;
  const checkpointNode = root.querySelector<HTMLElement>(".ws-checkpoint")!;
  const checkpointTitle = checkpointNode.querySelector<HTMLElement>("b")!;
  const checkpointDetail = checkpointNode.querySelector<HTMLElement>("small")!;
  const replay = root.querySelector<HTMLElement>(".ws-replay")!;
  const replayName = replay.querySelector<HTMLElement>("header b")!;
  const replayPath = replay.querySelector<HTMLElement>("header small")!;
  const replayPosition = replay.querySelector<HTMLElement>("nav span")!;
  const replayPrev = replay.querySelector<HTMLButtonElement>(".ws-replay-prev")!;
  const replayNext = replay.querySelector<HTMLButtonElement>(".ws-replay-next")!;
  const replayOpen = replay.querySelector<HTMLButtonElement>(".ws-replay-open")!;
  const replayDiff = replay.querySelector<HTMLElement>(".ws-diff")!;
  const stations = new Map<string, FileStation>();
  let relevant = new Set<string>();
  let agentLabels: string[] = [];
  let current: WorkshopPhase = "idle";
  let replaySteps: ChangeStep[] = [];
  let replayIndex = 0;
  let replayFile = "";

  const local = (path: string): string => {
    const clean = path.trim();
    const root = project.path.replace(/\/$/, "");
    return clean.startsWith(`${root}/`) ? clean.slice(root.length + 1) : clean;
  };

  const setPhase = (next: WorkshopPhase, detail?: string | null): void => {
    current = next;
    for (const name of ["idle", "working", "asking", "done", "error"]) {
      root.classList.toggle(`is-${name}`, name === next);
    }
    const fallback: Record<WorkshopPhase, string> = {
      idle: "at rest",
      working: "working",
      asking: "waiting for you",
      done: "complete",
      error: "stopped",
    };
    phase.textContent = detail?.trim() || fallback[next];
    phase.title = detail?.trim() || "";
  };

  const setAgents = (labels: string[]): void => {
    const next = labels.slice(0, 4);
    if (next.length === agentLabels.length && next.every((label, i) => label === agentLabels[i])) {
      return;
    }
    agentLabels = next;
    bay.replaceChildren(...next.map(robot));
    bay.hidden = next.length === 0;
    if (next.length && current === "idle") setPhase("working");
  };

  const ensureStation = (path: string, note: string): FileStation => {
    const key = local(path);
    const found = stations.get(key);
    if (found) return found;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ws-file enter";
    button.innerHTML = `
      <span class="ws-file-top"><i aria-hidden="true"></i><b></b></span>
      <small></small>
      <span class="ws-edit-count"></span>`;
    button.querySelector("b")!.textContent = base(key);
    button.querySelector("small")!.textContent = key;
    button.title = `Open ${key}`;
    button.addEventListener("click", () => void showReplay(key, button));
    files.prepend(button);
    const station = {
      root: button,
      count: button.querySelector<HTMLElement>(".ws-edit-count")!,
      timer: 0,
      edits: 0,
    };
    station.count.textContent = note;
    stations.set(key, station);
    empty.hidden = true;
    return station;
  };

  type DiffRow = { kind: "same" | "add" | "del" | "gap"; old: string; next: string; text: string };

  const diffRows = (step: ChangeStep): DiffRow[] => {
    const before = step.before.split("\n");
    const after = step.after.split("\n");
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
    let suffix = 0;
    while (
      suffix < before.length - prefix && suffix < after.length - prefix &&
      before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
    ) suffix += 1;
    const rows: DiffRow[] = [];
    const contextStart = Math.max(0, prefix - 3);
    if (contextStart > 0) rows.push({ kind: "gap", old: "", next: "", text: "⋯" });
    for (let i = contextStart; i < prefix; i += 1) {
      rows.push({ kind: "same", old: String(i + 1), next: String(i + 1), text: before[i] });
    }
    const removed = before.slice(prefix, before.length - suffix);
    const added = after.slice(prefix, after.length - suffix);
    removed.slice(0, 80).forEach((text, i) => rows.push({
      kind: "del", old: String(prefix + i + 1), next: "", text,
    }));
    if (removed.length > 80) rows.push({ kind: "gap", old: "", next: "", text: `… ${removed.length - 80} removed lines` });
    added.slice(0, 80).forEach((text, i) => rows.push({
      kind: "add", old: "", next: String(prefix + i + 1), text,
    }));
    if (added.length > 80) rows.push({ kind: "gap", old: "", next: "", text: `… ${added.length - 80} added lines` });
    const suffixCount = Math.min(3, suffix);
    for (let i = 0; i < suffixCount; i += 1) {
      const oldIndex = before.length - suffix + i;
      const newIndex = after.length - suffix + i;
      rows.push({ kind: "same", old: String(oldIndex + 1), next: String(newIndex + 1), text: before[oldIndex] });
    }
    if (suffix > suffixCount) rows.push({ kind: "gap", old: "", next: "", text: "⋯" });
    return rows;
  };

  const paintReplay = (): void => {
    const step = replaySteps[replayIndex];
    if (!step) return;
    replayPosition.textContent = `Edit ${replayIndex + 1} of ${replaySteps.length} · ${step.tool}`;
    replayPrev.disabled = replayIndex === 0;
    replayNext.disabled = replayIndex === replaySteps.length - 1;
    const frag = document.createDocumentFragment();
    for (const row of diffRows(step)) {
      const line = document.createElement("div");
      line.className = `ws-diff-line is-${row.kind}`;
      const old = document.createElement("i");
      const next = document.createElement("i");
      const mark = document.createElement("b");
      const code = document.createElement("code");
      old.textContent = row.old;
      next.textContent = row.next;
      mark.textContent = row.kind === "add" ? "+" : row.kind === "del" ? "−" : "";
      code.textContent = row.text || " ";
      line.append(old, next, mark, code);
      frag.append(line);
    }
    replayDiff.replaceChildren(frag);
    replayDiff.scrollTop = 0;
  };

  const showReplay = async (path: string, station: HTMLButtonElement): Promise<void> => {
    station.classList.add("is-loading");
    try {
      const steps = await loadChanges(path);
      if (!steps.length) {
        open(path);
        return;
      }
      replayFile = path;
      replaySteps = steps;
      replayIndex = steps.length - 1;
      replayName.textContent = base(path);
      replayPath.textContent = path;
      replay.hidden = false;
      paintReplay();
    } finally {
      station.classList.remove("is-loading");
    }
  };

  replay.querySelector(".ws-replay-close")!.addEventListener("click", () => {
    replay.hidden = true;
  });
  replayPrev.addEventListener("click", () => { replayIndex = Math.max(0, replayIndex - 1); paintReplay(); });
  replayNext.addEventListener("click", () => { replayIndex = Math.min(replaySteps.length - 1, replayIndex + 1); paintReplay(); });
  replayOpen.addEventListener("click", () => open(replayFile));

  const fileChanged = (path: string): void => {
    const key = local(path);
    if (!key) return;
    const station = ensureStation(key, "changed");
    station.edits += 1;
    station.root.dataset.edits = String(station.edits);
    station.count.textContent = `${station.edits} ${station.edits === 1 ? "change" : "changes"}`;
    station.root.classList.add("is-edited");
    files.prepend(station.root);
    window.clearTimeout(station.timer);
    station.root.classList.remove("is-writing");
    void station.root.offsetWidth;
    station.root.classList.add("is-writing");
    station.timer = window.setTimeout(() => station?.root.classList.remove("is-writing"), 1300);
    setPhase("working", `editing ${base(key)}`);
  };

  const setRelevant = (list: WorkFile[]): void => {
    const next = new Set(list.slice(0, 6).map((file) => local(file.path)).filter(Boolean));
    for (const key of relevant) {
      if (next.has(key)) continue;
      const station = stations.get(key);
      station?.root.classList.remove("is-relevant");
      if (station && station.edits === 0) {
        window.clearTimeout(station.timer);
        station.root.remove();
        stations.delete(key);
      }
    }
    for (const file of list.slice(0, 6)) {
      const key = local(file.path);
      if (!key) continue;
      const station = ensureStation(key, file.why?.trim() || "possibly relevant");
      station.root.classList.add("is-relevant");
      if (station.edits === 0) station.count.textContent = file.why?.trim() || "possibly relevant";
    }
    relevant = next;
    empty.hidden = stations.size > 0;
  };

  const addRelevant = (file: WorkFile): void => {
    const key = local(file.path);
    if (!key) return;
    relevant.add(key);
    const station = ensureStation(key, file.why?.trim() || "needs your input");
    station.root.classList.add("is-relevant");
    if (station.edits === 0) station.count.textContent = file.why?.trim() || "needs your input";
  };

  const checkpoint = (kind: string, label?: string | null, ok?: boolean | null): void => {
    checkpointNode.classList.remove("is-empty", "is-ok", "is-risk", "is-live", "is-push");
    const normalized = kind.toLowerCase();
    checkpointNode.classList.toggle("is-push", normalized === "push");
    checkpointNode.classList.add(ok === false ? "is-risk" : ok === true ? "is-ok" : "is-live");
    checkpointTitle.textContent =
      normalized === "push" ? "Changes reached the remote" :
      normalized === "commit" ? "Work committed" :
      normalized === "test" ? (ok === false ? "Checks failed" : "Checks passed") :
      normalized === "build" ? (ok === false ? "Build failed" : "Build completed") :
      label?.trim() || kind;
    checkpointDetail.textContent = label?.trim() || `${project.name} · ${normalized}`;
  };

  return {
    root,
    begin(prompt) {
      // One prompt, one scene. History lives inside the replay for that prompt; it must not turn
      // the workshop into a permanent file/activity ledger.
      for (const station of stations.values()) window.clearTimeout(station.timer);
      stations.clear();
      relevant.clear();
      files.replaceChildren();
      empty.hidden = false;
      replay.hidden = true;
      replaySteps = [];
      setPhase("working", prompt?.trim() || "new task");
      checkpointNode.className = "ws-checkpoint is-empty";
      checkpointTitle.textContent = "No checkpoint yet";
      checkpointDetail.textContent = "Tests, builds and Git land here.";
    },
    setPhase,
    setAgents,
    fileChanged,
    setRelevant,
    addRelevant,
    checkpoint,
  };
}
