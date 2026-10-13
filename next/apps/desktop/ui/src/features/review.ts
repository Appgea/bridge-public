/**
 * Review: what the agents made. Pictures, sounds and videos that appeared in a project while a
 * session was open there, collected in one place so reviewing them is not a trip through Finder.
 *
 * Rust watches each project with an open session and sends `panel-made` once a file has
 * settled (see made.rs). Files land in batches: whatever one project produced within a few
 * minutes of itself is one piece of work, and is reviewed, revealed or dismissed as one.
 *
 * The queue is kept in localStorage: it is this window's to-do list, and a file that disappears
 * from disk simply shows as missing.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { projectAssetUrl } from "../project-assets";
import { openReviewDeck, type DeckItem } from "./review_deck";
import "./review.css";

type Kind = "image" | "audio" | "video";

type Made = {
  project: string;
  path: string;
  kind: Kind;
  size: number;
  modified: number;
};

type Item = Made & { seen: boolean };

export type ReviewEvents = {
  projectName(id: string): string;
  projectPath(id: string): string | null;
  openProject(id: string): void;
  /** Batches with something unseen: a batch is one piece of work, however many files it wrote. */
  onCount(unseen: number): void;
  /** The agent a review's feedback goes to, by display name, or null when none is open. */
  agentName(project: string): string | null;
  /** Type the feedback into that agent's prompt and submit it. */
  send(project: string, text: string): Promise<boolean>;
  /** True while the Review screen or another full-screen surface makes a peek pointless. */
  busy(): boolean;
};

export type ReviewHandle = {
  open(): void;
  clear(): void;
};

const STORE = "panel-review";
const CAP = 400;
/** Files from one project this close together are one batch of work. */
const BATCH_GAP = 3 * 60_000;
/** Tiles a batch shows before the rest fold into one "+N more" tile. Twelve fills 2, 3, 4 or 6 columns. */
const SHOWN = 12;
/** A folder that wrote this many files in one batch is a pipeline step: one tile for all of it. */
const FOLD = 8;

const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

const fileName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** Names the way Finder sorts them: shot_2 before shot_10. */
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function ago(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(at).toLocaleDateString();
}

function count(items: Item[]): string {
  const of = (kind: Kind, one: string, many: string): string => {
    const n = items.filter((item) => item.kind === kind).length;
    return n ? `${n} ${n === 1 ? one : many}` : "";
  };
  return [of("image", "image", "images"), of("audio", "sound", "sounds"), of("video", "video", "videos")]
    .filter(Boolean)
    .join(" · ");
}

function load(): Map<string, Item> {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? "[]") as Item[];
    return new Map(saved.map((item) => [item.path, item]));
  } catch {
    return new Map();
  }
}

export function mountReview(screen: HTMLElement, events: ReviewEvents): ReviewHandle {
  const items = load();
  let openState = false;
  /** The batch just marked reviewed, kept for one Undo. */
  let undo: { items: Item[]; timer: number } | null = null;

  const save = (): void => {
    const newest = [...items.values()].sort((a, b) => b.modified - a.modified).slice(0, CAP);
    items.clear();
    for (const item of newest) items.set(item.path, item);
    try {
      localStorage.setItem(STORE, JSON.stringify(newest));
    } catch {
      // Storage full or blocked: the queue still works for this run.
    }
  };
  const announce = (): void => events.onCount(batches().filter((batch) => batch.some((item) => !item.seen)).length);

  void listen<Made>("panel-made", ({ payload }) => {
    // A re-render of the same file is news again: it moves up and is unseen.
    items.set(payload.path, { ...payload, seen: openState });
    save();
    announce();
    if (openState) paint();
    else peek(payload.project);
  });
  announce();

  const relative = (item: Item): string => {
    const root = events.projectPath(item.project);
    return root && item.path.startsWith(`${root}/`) ? item.path.slice(root.length + 1) : item.path;
  };
  const folderOf = (item: Item): string => relative(item).split("/").slice(0, -1).join("/") || ".";

  /**
   * A batch in the order it is shown and reviewed: folder by folder, in the order each folder
   * first wrote, and by name inside a folder. Renders and takes finish out of order when made in
   * parallel, so 01, 02, 03 is the order the agent meant, not the order the files landed.
   */
  function inOrder(newestFirst: Item[]): Item[] {
    const rank = new Map<string, number>();
    for (let at = newestFirst.length - 1; at >= 0; at--) {
      const folder = folderOf(newestFirst[at]);
      if (!rank.has(folder)) rank.set(folder, rank.size);
    }
    return newestFirst.sort(
      (a, b) => rank.get(folderOf(a))! - rank.get(folderOf(b))! || byName.compare(fileName(a.path), fileName(b.path)),
    );
  }

  /** Newest batch first. Time decides where a batch ends; inOrder decides the order inside it. */
  function batches(): Item[][] {
    const sorted = [...items.values()].sort((a, b) => b.modified - a.modified);
    const out: Item[][] = [];
    const current = new Map<string, Item[]>();
    for (const item of sorted) {
      const batch = current.get(item.project);
      if (batch && batch[batch.length - 1].modified - item.modified <= BATCH_GAP) {
        batch.push(item);
        continue;
      }
      const fresh = [item];
      current.set(item.project, fresh);
      out.push(fresh);
    }
    return out.map(inOrder);
  }

  function dismiss(batch: Item[]): void {
    if (undo) window.clearTimeout(undo.timer);
    for (const item of batch) items.delete(item.path);
    undo = { items: batch, timer: window.setTimeout(() => { undo = null; paint(); }, 8000) };
    save();
    announce();
    paint();
  }

  function restore(): void {
    if (!undo) return;
    window.clearTimeout(undo.timer);
    for (const item of undo.items) items.set(item.path, item);
    undo = null;
    save();
    announce();
    paint();
  }

  /** The batch as the deck sees it, and a review of it from any item. */
  function review(batch: Item[], at = 0): void {
    const project = batch[0].project;
    const deckItems: DeckItem[] = batch.map((item) => ({
      project: item.project,
      path: item.path,
      label: relative(item),
      kind: item.kind,
    }));
    for (const item of batch) item.seen = true;
    save();
    announce();
    hidePeek();
    openReviewDeck(deckItems, at, {
      title: `${events.projectName(project)} · ${count(batch)}`,
      agentName: events.agentName(project),
      send: (text) => events.send(project, text),
      copy: async (text) => {
        try {
          await navigator.clipboard.writeText(text);
          return true;
        } catch {
          return false;
        }
      },
      onClose: (_result, finished) => {
        // Reaching the end is the review. Closing halfway leaves the batch where it was.
        if (finished) dismiss(batch);
        else paint();
      },
    });
  }

  function tile(item: Item, batch: Item[], at: number): HTMLElement {
    const node = make("button", `rv-shot is-${item.kind}`);
    node.type = "button";
    node.title = relative(item);
    if (item.kind === "image") {
      const image = make("img");
      image.src = projectAssetUrl(item.project, item.path);
      image.alt = "";
      image.loading = "lazy";
      image.decoding = "async";
      image.addEventListener("error", () => node.classList.add("is-missing"), { once: true });
      node.append(image);
    } else {
      node.append(make("span", "rv-glyph", item.kind === "audio" ? "♪" : "▶"));
    }
    node.append(make("span", "rv-name", fileName(item.path)));
    node.addEventListener("click", () => review(batch, at));
    return node;
  }

  /** A batch by folder. The batch is already folder by folder, so this keeps its order. */
  function folderGroups(batch: Item[]): { folder: string; items: Item[] }[] {
    const groups = new Map<string, Item[]>();
    for (const item of batch) {
      const folder = folderOf(item);
      groups.set(folder, [...(groups.get(folder) ?? []), item]);
    }
    return [...groups].map(([folder, items]) => ({ folder, items }));
  }

  /** A whole folder as one tile: its last picture, or a sound or video glyph, and the count. */
  function folded(group: { folder: string; items: Item[] }, batch: Item[], start: number): HTMLElement {
    const node = make("button", "rv-shot is-folder");
    node.type = "button";
    node.title = `${group.folder} · ${count(group.items)}`;
    const cover = [...group.items].reverse().find((item) => item.kind === "image");
    if (cover) {
      const image = make("img");
      image.src = projectAssetUrl(cover.project, cover.path);
      image.alt = "";
      image.loading = "lazy";
      image.decoding = "async";
      node.append(image);
    } else {
      node.append(make("span", "rv-glyph", group.items[0].kind === "audio" ? "♪" : "▶"));
    }
    node.append(
      make("span", "rv-stack", String(group.items.length)),
      make("span", "rv-name", `${fileName(group.folder)}/ · ${count(group.items)}`),
    );
    node.addEventListener("click", () => review(batch, start));
    return node;
  }

  function card(batch: Item[]): HTMLElement {
    const project = batch[0].project;
    const box = make("article", "rv-batch");
    if (batch.some((item) => !item.seen)) box.classList.add("is-new");
    const head = make("header", "rv-head");
    const title = make("div", "rv-title");
    title.append(
      make("b", "", events.projectName(project)),
      make("span", "", `${count(batch)} · ${ago(Math.max(...batch.map((item) => item.modified)))}`),
    );
    const groups = folderGroups(batch);
    title.append(make("code", "rv-where", groups.length === 1 ? groups[0].folder : `${groups.length} folders`));
    const actions = make("div", "rv-actions");
    const button = (label: string, hint: string, run: () => void, className = "rv-btn"): void => {
      const node = make("button", className, label);
      node.type = "button";
      node.title = hint;
      node.addEventListener("click", run);
      actions.append(node);
    };
    button("Finder", "Show in Finder", () => {
      void invoke("reveal_entry", { project, path: relative(batch[batch.length - 1]) }).catch(() => undefined);
    }, "rv-btn is-quiet");
    button("Done", "Mark reviewed without going through it", () => dismiss(batch), "rv-btn is-quiet");
    button("Review", "Go through it one by one · G good · C changes", () => review(batch), "rv-btn is-primary");
    head.append(title, actions);
    const grid = make("div", "rv-grid");
    // The deck walks the batch in the order the tiles show it, so a folded folder is one stretch.
    const tiles: { start: number; node: HTMLElement }[] = [];
    for (const group of groups) {
      const start = batch.indexOf(group.items[0]);
      if (group.items.length >= FOLD) tiles.push({ start, node: folded(group, batch, start) });
      else group.items.forEach((item, at) => tiles.push({ start: start + at, node: tile(item, batch, start + at) }));
    }
    const shown = tiles.length > SHOWN ? SHOWN - 1 : tiles.length;
    grid.append(...tiles.slice(0, shown).map(({ node }) => node));
    if (shown < tiles.length) {
      const from = tiles[shown].start;
      const more = make("button", "rv-shot is-more");
      more.type = "button";
      more.title = "Review from here";
      more.append(make("span", "rv-glyph", `+${batch.length - from}`), make("span", "rv-name", "more in this batch"));
      more.addEventListener("click", () => review(batch, from));
      grid.append(more);
    }
    box.append(head, grid);
    return box;
  }

  /* ------------------------------------------------------------------ peek */

  let peekNode: HTMLElement | null = null;
  let peekTimer = 0;

  function hidePeek(): void {
    window.clearTimeout(peekTimer);
    peekNode?.classList.add("is-leaving");
    const leaving = peekNode;
    peekNode = null;
    window.setTimeout(() => leaving?.remove(), 180);
  }

  /**
   * New work, brought to you: a small card in the corner with the pictures themselves, and one
   * button that opens the review right over whatever you were doing. It never takes focus and
   * leaves on its own; the Review row keeps everything for later.
   */
  function peek(project: string): void {
    if (events.busy()) return;
    const batch = batches().find((candidate) => candidate[0].project === project);
    if (!batch) return;
    window.clearTimeout(peekTimer);
    const card = peekNode ?? make("aside", "rv-peek");
    card.setAttribute("role", "status");
    const faces = make("div", "rv-peek-faces");
    for (const item of batch.slice(-3)) {
      const face = make("span", `rv-peek-face is-${item.kind}`);
      if (item.kind === "image") {
        const image = make("img");
        image.src = projectAssetUrl(item.project, item.path);
        image.alt = "";
        face.append(image);
      } else {
        face.textContent = item.kind === "audio" ? "♪" : "▶";
      }
      faces.append(face);
    }
    const text = make("div", "rv-peek-text");
    text.append(make("b", "", events.projectName(project)), make("span", "", `made ${count(batch)}`));
    const open = make("button", "rv-btn is-primary", "Review");
    open.type = "button";
    open.addEventListener("click", () => {
      const latest = batches().find((candidate) => candidate[0].project === project);
      if (latest) review(latest);
    });
    const later = make("button", "rv-peek-close", "×");
    later.type = "button";
    later.setAttribute("aria-label", "Later");
    later.title = "Later — it stays in Review";
    later.addEventListener("click", hidePeek);
    card.replaceChildren(faces, text, open, later);
    if (!peekNode) {
      peekNode = card;
      document.body.append(card);
      card.addEventListener("mouseenter", () => window.clearTimeout(peekTimer));
      card.addEventListener("mouseleave", () => {
        peekTimer = window.setTimeout(hidePeek, 4000);
      });
    }
    peekTimer = window.setTimeout(hidePeek, 9000);
  }

  function paint(): void {
    if (!openState) return;
    const head = make("header", "rv-top");
    const heading = make("div", "rv-heading");
    heading.append(
      make("h1", "", "Review"),
      make("p", "", "What your agents made. Review a batch to flip through it and send them your verdict."),
    );
    head.append(heading);
    if (items.size) {
      const all = make("button", "rv-btn is-quiet", "Mark all reviewed");
      all.type = "button";
      all.addEventListener("click", () => dismiss([...items.values()]));
      head.append(all);
    }
    const body = make("div", "rv-body");
    if (undo) {
      const bar = make("div", "rv-undo");
      bar.append(make("span", "", `Marked ${undo.items.length === 1 ? "1 file" : `${undo.items.length} files`} reviewed.`));
      const again = make("button", "rv-btn", "Undo");
      again.type = "button";
      again.addEventListener("click", restore);
      bar.append(again);
      body.append(bar);
    }
    const list = batches();
    if (!list.length) {
      const empty = make("div", "rv-empty");
      empty.append(
        make("b", "", "Nothing to review"),
        make("p", "", "When an agent saves an image, a sound or a video in its project, it shows up here."),
      );
      body.append(empty);
    } else {
      body.append(...list.map(card));
    }
    screen.replaceChildren(head, body);
  }

  return {
    open() {
      openState = true;
      hidePeek();
      paint();
      // Looking is seeing: the badge clears, the "new" marks stay for this visit.
      let changed = false;
      for (const item of items.values()) {
        if (!item.seen) {
          item.seen = true;
          changed = true;
        }
      }
      if (changed) {
        save();
        announce();
      }
    },
    clear() {
      openState = false;
      for (const player of screen.querySelectorAll<HTMLMediaElement>("audio, video")) player.pause();
      screen.replaceChildren();
    },
  };
}
