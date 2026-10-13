/**
 * The replay theater.
 *
 * A change notification is only worth tapping if what opens is watchable. This overlay takes the
 * exact before/after images the edit hooks captured (`ChangeStep`) and performs them: a robot at
 * the desk, deleted lines struck and collapsed, added lines typed in character by character.
 * You watch the edit happen instead of reading a static diff.
 *
 * It is a player, not an editor: nothing here writes, and "Open editor" is the only exit into
 * the real file. Pause, speed and skip exist because attention is the resource being spent.
 */

import type { ChangeStep } from "../types";
import "./robot_replay.css";

export type ReplayFile = { path: string; steps: ChangeStep[] };

export type RobotReplayHandle = {
  root: HTMLElement;
  /** Perform the given files in order. Any running show is cancelled first. */
  play(files: ReplayFile[]): void;
  visible(): boolean;
  close(): void;
};

type Deps = {
  /** Open the real file in the editor (project-relative or absolute path). */
  open(path: string): void;
  /** Fired once per show, when it finishes or is closed. */
  onDone?(): void;
};

const SPEEDS = [1, 2, 4] as const;
const base = (path: string): string => path.split("/").pop() || path;

type Region = { prefix: number; removed: string[]; added: string[]; before: string[]; after: string[] };
type InlineChange = { prefix: string; removed: string; added: string; suffix: string };
type InlineRow = { row: HTMLElement; oldPart: HTMLElement; newPart: HTMLElement };

/** Trim the common prefix/suffix so the show is only the lines that actually moved. */
function region(step: ChangeStep): Region {
  const before = step.before.split("\n");
  const after = step.after.split("\n");
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix && suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix += 1;
  return {
    prefix,
    removed: before.slice(prefix, before.length - suffix),
    added: after.slice(prefix, after.length - suffix),
    before,
    after,
  };
}

/**
 * Find the stable text around a single-line revision. Whitespace-only overlap does not count:
 * two unrelated indented lines should still read as a real remove/add, not a misleading morph.
 */
function inlineChange(before: string, after: string): InlineChange | null {
  if (before === after) return null;
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix += 1;

  const stable = `${before.slice(0, prefix)}${suffix ? before.slice(-suffix) : ""}`.replace(/\s/g, "");
  const longest = Math.max(before.replace(/\s/g, "").length, after.replace(/\s/g, "").length, 1);
  if (stable.length < 2 || stable.length / longest < 0.18) return null;
  return {
    prefix: before.slice(0, prefix),
    removed: before.slice(prefix, before.length - suffix),
    added: after.slice(prefix, after.length - suffix),
    suffix: suffix ? before.slice(-suffix) : "",
  };
}

/** Equal line counts with recognizable anchors can be revised in place. Structural edits cannot. */
function inlineRegion(r: Region): Array<InlineChange | null> | null {
  if (!r.removed.length || r.removed.length !== r.added.length || r.removed.length > 12) return null;
  const edits = r.removed.map((before, index) =>
    before === r.added[index] ? null : inlineChange(before, r.added[index]),
  );
  return edits.some(Boolean) && edits.every((edit, index) => edit !== null || r.removed[index] === r.added[index])
    ? edits
    : null;
}

/** Lines typed in full; past this the rest of the step lands instantly so long edits stay short. */
const TYPED_LINES = 24;
const SHOWN_LINES = 60;

export function mountRobotReplay(host: HTMLElement, deps: Deps): RobotReplayHandle {
  const root = document.createElement("div");
  root.className = "rr-overlay";
  root.hidden = true;
  root.innerHTML = `
    <div class="rr-stage" role="dialog" aria-label="Edit replay" tabindex="-1">
      <header class="rr-head">
        <div class="rr-bot" aria-hidden="true">
          <span class="rr-bot-body">
            <i class="rr-antenna"></i>
            <i class="rr-eye e-one"></i><i class="rr-eye e-two"></i>
            <i class="rr-mouth"></i>
            <i class="rr-arm a-one"></i><i class="rr-arm a-two"></i>
          </span>
        </div>
        <div class="rr-meta">
          <b></b>
          <small></small>
        </div>
        <div class="rr-controls">
          <button class="rr-speed" type="button" title="Playback speed">1×</button>
          <button class="rr-pause" type="button" title="Pause">❚❚</button>
          <button class="rr-skip" type="button" title="Skip to next file">⇥</button>
          <button class="rr-open" type="button">Open editor</button>
          <button class="rr-close" type="button" aria-label="Close replay">×</button>
        </div>
      </header>
      <div class="rr-code"><div class="rr-lines"></div></div>
      <footer class="rr-foot">
        <span class="rr-say"></span>
        <span class="rr-track"><i></i></span>
      </footer>
    </div>`;
  host.append(root);

  const name = root.querySelector<HTMLElement>(".rr-meta b")!;
  const detail = root.querySelector<HTMLElement>(".rr-meta small")!;
  const lines = root.querySelector<HTMLElement>(".rr-lines")!;
  const code = root.querySelector<HTMLElement>(".rr-code")!;
  const say = root.querySelector<HTMLElement>(".rr-say")!;
  const track = root.querySelector<HTMLElement>(".rr-track i")!;
  const bot = root.querySelector<HTMLElement>(".rr-bot")!;
  const speedBtn = root.querySelector<HTMLButtonElement>(".rr-speed")!;
  const pauseBtn = root.querySelector<HTMLButtonElement>(".rr-pause")!;
  const skipBtn = root.querySelector<HTMLButtonElement>(".rr-skip")!;
  const openBtn = root.querySelector<HTMLButtonElement>(".rr-open")!;

  let generation = 0;
  let speed: number = SPEEDS[0];
  let paused = false;
  let resume: (() => void) | null = null;
  let skipFile = false;
  let currentPath = "";
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  const stopped = (gen: number): boolean => gen !== generation;

  /** Sleeps in small slices so pause and speed changes bite immediately. */
  const wait = async (ms: number, gen: number): Promise<void> => {
    let left = ms / speed;
    while (left > 0 && !stopped(gen)) {
      if (paused) {
        await new Promise<void>((r) => { resume = r; });
        continue;
      }
      const slice = Math.min(40, left);
      await new Promise((r) => setTimeout(r, slice));
      left -= slice * speed; // re-read speed each slice: bumping to 4× shortens the remainder
    }
  };

  const setPaused = (next: boolean): void => {
    paused = next;
    pauseBtn.textContent = next ? "▶" : "❚❚";
    pauseBtn.title = next ? "Resume" : "Pause";
    bot.classList.toggle("is-paused", next);
    if (!next) { resume?.(); resume = null; }
  };

  const line = (kind: "same" | "del" | "add" | "gap", num: string, text: string): HTMLElement => {
    const row = document.createElement("div");
    row.className = `rr-line is-${kind}`;
    const gutter = document.createElement("i");
    gutter.textContent = num;
    const mark = document.createElement("b");
    mark.textContent = kind === "add" ? "+" : kind === "del" ? "−" : "";
    const body = document.createElement("code");
    body.textContent = text || " ";
    row.append(gutter, mark, body);
    lines.append(row);
    return row;
  };

  const inlineLine = (num: string, edit: InlineChange): InlineRow => {
    const row = document.createElement("div");
    row.className = "rr-line is-edit";
    const gutter = document.createElement("i");
    gutter.textContent = num;
    const mark = document.createElement("b");
    mark.textContent = "~";
    const body = document.createElement("code");
    const stableBefore = document.createElement("span");
    const oldPart = document.createElement("span");
    const newPart = document.createElement("span");
    const stableAfter = document.createElement("span");
    stableBefore.textContent = edit.prefix;
    oldPart.className = "rr-inline-old";
    oldPart.textContent = edit.removed;
    newPart.className = "rr-inline-new";
    stableAfter.textContent = edit.suffix;
    body.append(stableBefore, oldPart, newPart, stableAfter);
    row.append(gutter, mark, body);
    lines.append(row);
    // A fixed starting width lets the old fragment physically make room for the replacement.
    oldPart.style.width = `${Math.ceil(oldPart.getBoundingClientRect().width)}px`;
    return { row, oldPart, newPart };
  };

  const follow = (): void => { code.scrollTop = code.scrollHeight; };

  const playStep = async (step: ChangeStep, gen: number): Promise<void> => {
    const r = region(step);
    const inline = inlineRegion(r);
    lines.replaceChildren();

    // Set the scene: up to three lines of untouched context above the edit.
    const contextStart = Math.max(0, r.prefix - 3);
    if (contextStart > 0) line("gap", "", "⋯");
    for (let i = contextStart; i < r.prefix; i += 1) line("same", String(i + 1), r.before[i]);

    if (inline) {
      const rows = inline.map((edit, index) =>
        edit
          ? inlineLine(String(r.prefix + index + 1), edit)
          : { row: line("same", String(r.prefix + index + 1), r.added[index]) },
      );
      const afterStart = r.prefix + r.added.length;
      const afterEnd = Math.min(r.after.length, afterStart + 3);
      for (let i = afterStart; i < afterEnd; i += 1) line("same", String(i + 1), r.after[i]);
      if (afterEnd < r.after.length) line("gap", "", "⋯");

      bot.classList.add("is-scanning");
      say.textContent = `revising ${inline.filter(Boolean).length} line${inline.filter(Boolean).length === 1 ? "" : "s"} in place…`;
      await wait(reducedMotion.matches ? 0 : 420, gen);
      bot.classList.remove("is-scanning");

      for (let index = 0; index < inline.length; index += 1) {
        const edit = inline[index];
        if (!edit || stopped(gen) || skipFile) continue;
        const { row, oldPart, newPart } = rows[index] as InlineRow;
        row.classList.add("is-focus");
        follow();

        if (edit.removed) {
          oldPart.classList.add("is-marked");
          await wait(reducedMotion.matches ? 0 : 260, gen);
          oldPart.classList.add("is-cut");
          await wait(reducedMotion.matches ? 0 : 220, gen);
          oldPart.classList.add("is-gone");
          await wait(reducedMotion.matches ? 0 : 230, gen);
        }
        if (stopped(gen) || skipFile) break;

        bot.classList.add("is-typing");
        newPart.classList.add("is-caret");
        const chunk = Math.max(1, Math.ceil(edit.added.length / 30));
        for (let at = 0; at < edit.added.length; at += chunk) {
          if (stopped(gen) || skipFile) break;
          newPart.textContent = edit.added.slice(0, at + chunk);
          if (!reducedMotion.matches) await wait(18, gen);
        }
        newPart.textContent = edit.added;
        newPart.classList.remove("is-caret");
        bot.classList.remove("is-typing");
        row.classList.remove("is-focus");
        row.classList.add("is-settled");
        await wait(reducedMotion.matches ? 0 : 180, gen);
      }
      say.textContent = "inline revision complete";
      return;
    }

    // The robot reads before it cuts.
    bot.classList.add("is-scanning");
    say.textContent = r.removed.length ? "removing the old version…" : "writing new code…";
    await wait(reducedMotion.matches ? 0 : 450, gen);
    bot.classList.remove("is-scanning");
    if (stopped(gen)) return;

    // Deletions: strike, hold, collapse.
    const shownDel = r.removed.slice(0, SHOWN_LINES);
    const delRows = shownDel.map((text, i) => line("del", String(r.prefix + i + 1), text));
    if (r.removed.length > SHOWN_LINES) line("gap", "", `… ${r.removed.length - SHOWN_LINES} more removed lines`);
    if (delRows.length) {
      follow();
      await wait(reducedMotion.matches ? 0 : Math.min(1400, 250 + delRows.length * 90), gen);
      if (stopped(gen)) return;
      for (const row of delRows) row.classList.add("is-going");
      await wait(reducedMotion.matches ? 0 : 420, gen);
      if (stopped(gen)) return;
      for (const row of delRows) row.classList.add("is-gone");
      await wait(reducedMotion.matches ? 0 : 260, gen);
      if (stopped(gen)) return;
    }

    // Additions: typed, with the robot at the keys.
    if (r.added.length) {
      bot.classList.add("is-typing");
      say.textContent = `typing ${r.added.length} line${r.added.length === 1 ? "" : "s"}…`;
    }
    const shownAdd = r.added.slice(0, SHOWN_LINES);
    for (let i = 0; i < shownAdd.length; i += 1) {
      if (stopped(gen) || skipFile) break;
      const text = shownAdd[i];
      const row = line("add", String(r.prefix + i + 1), "");
      const body = row.querySelector("code")!;
      row.classList.add("is-caret");
      follow();
      if (i < TYPED_LINES && !reducedMotion.matches) {
        // Chunk size caps any line at ~30 ticks so minified lines don't stall the show.
        const chunk = Math.max(1, Math.ceil(text.length / 30));
        for (let at = 0; at < text.length; at += chunk) {
          if (stopped(gen) || skipFile) break;
          body.textContent = text.slice(0, at + chunk);
          await wait(16, gen);
        }
      }
      body.textContent = text || " ";
      row.classList.remove("is-caret");
    }
    if (r.added.length > SHOWN_LINES) line("gap", "", `… ${r.added.length - SHOWN_LINES} more added lines`);
    bot.classList.remove("is-typing");
    follow();
  };

  const show = async (files: ReplayFile[]): Promise<void> => {
    generation += 1;
    const gen = generation;
    const total = files.reduce((sum, file) => sum + file.steps.length, 0) || 1;
    let done = 0;
    root.hidden = false;
    setPaused(false);

    for (const file of files) {
      if (stopped(gen)) return;
      skipFile = false;
      currentPath = file.path;
      name.textContent = base(file.path);
      for (let i = 0; i < file.steps.length; i += 1) {
        if (stopped(gen) || skipFile) break;
        const step = file.steps[i];
        detail.textContent = `${file.path} · edit ${i + 1} of ${file.steps.length} · ${step.tool}`;
        await playStep(step, gen);
        done += 1;
        track.style.width = `${Math.round((done / total) * 100)}%`;
        if (stopped(gen)) return;
        if (!skipFile) await wait(700, gen);
      }
      done = Math.max(done, files.slice(0, files.indexOf(file) + 1).reduce((s, f) => s + f.steps.length, 0));
      track.style.width = `${Math.round((done / total) * 100)}%`;
    }
    if (stopped(gen)) return;
    say.textContent = "that's everything — all changes replayed";
    bot.classList.add("is-bowing");
    await wait(1600, gen);
    if (stopped(gen)) return;
    close();
  };

  const close = (): void => {
    generation += 1;
    resume?.();
    resume = null;
    paused = false;
    if (root.hidden) return;
    root.hidden = true;
    bot.className = "rr-bot";
    track.style.width = "0%";
    deps.onDone?.();
  };

  speedBtn.addEventListener("click", () => {
    speed = SPEEDS[(SPEEDS.indexOf(speed as (typeof SPEEDS)[number]) + 1) % SPEEDS.length];
    speedBtn.textContent = `${speed}×`;
  });
  pauseBtn.addEventListener("click", () => setPaused(!paused));
  skipBtn.addEventListener("click", () => { skipFile = true; resume?.(); resume = null; if (paused) setPaused(false); });
  openBtn.addEventListener("click", () => { const path = currentPath; close(); deps.open(path); });
  root.querySelector(".rr-close")!.addEventListener("click", close);
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
    if (event.key === " ") { event.preventDefault(); setPaused(!paused); }
  });

  return {
    root,
    play(files) {
      const nonEmpty = files.filter((file) => file.steps.length > 0);
      if (!nonEmpty.length) return;
      void show(nonEmpty);
      root.querySelector<HTMLElement>(".rr-stage")?.focus?.();
    },
    visible: () => !root.hidden,
    close,
  };
}
