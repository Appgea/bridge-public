/**
 * Quick open — ⌘⇧O, Xcode's move. A host may pick another chord (the Work tab puts the
 * project-wide file list on ⌘P).
 *
 * A pane hands over a list of places worth jumping to and what to do when one is chosen; this
 * owns the overlay, the fuzzy filter, the keyboard, and the shortcut itself. The Work tab
 * offers the files related to the open one. Same panel, same keys, same look — the list differs because
 * the context does, which is the only thing that should.
 *
 * Several can be mounted at once. Each only answers the shortcut while ITS host is on screen,
 * and swallows the event so a hidden sibling never opens a second panel behind the first.
 */

import { fileVisual } from "./file_icons";
import "./quick_open.css";

export type QuickOpenTarget = {
  /** Shown, and handed back on choose. Project-relative for files. */
  path: string;
  /** 1-indexed, when the target is a place inside the file rather than the file. */
  line?: number;
  /** Why this is on the list — the sentence that makes the row worth reading. */
  detail?: string;
  /** What the row prints and filters on, when it is not the path's last segment. */
  name?: string;
  /** Markup for the glyph slot, when the target is not a file. Replaces the file-type icon. */
  icon?: string;
  /** The right-hand tag, when the target is not a file. Replaces the file-type label. */
  label?: string;
};

export type QuickOpenList = {
  /** What this particular list IS, in a few words. Shown above the filter. */
  title: string;
  /** Everything the host already knows. The panel paints these in the same frame. */
  targets: QuickOpenTarget[];
  /**
   * The rest, if the host has to fetch it. The panel opens on `targets` immediately and swaps
   * this in when it lands — the human is already typing by then. Never make them wait on a
   * round-trip to see a panel.
   */
  pending?: Promise<QuickOpenTarget[]>;
};

export type QuickOpenOptions = {
  /**
   * The pane the overlay covers. Must be positioned. Its visibility is also the gate: the
   * shortcut is ignored while this element is hidden or has no box.
   */
  host: HTMLElement;
  /** Gather the list for this moment. Async — hosts may have to fetch. */
  load(): Promise<QuickOpenList> | QuickOpenList;
  /** The human chose a row. */
  onChoose(target: QuickOpenTarget): void;
  /** Nothing to offer. The host says so in its own voice (a toast, usually). */
  onEmpty?(): void;
  /** Where focus belongs once the panel closes. Usually the editor. */
  restoreFocus?(): void;
  placeholder?: string;
  emptyText?: string;
  /** The chord that opens it. ⌘⇧O unless the host says otherwise. Always ⌘, never ⌃ or ⌥.
   *  `late` listens in the bubble phase: every pane on screen gets first refusal, and this one
   *  answers only when none of them swallowed the chord — the portfolio picker's place. */
  shortcut?: { key: string; shift: boolean; late?: boolean };
};

/** Rows painted per render. A project list is thousands long; nobody scrolls past this —
 *  they type another letter. */
const MAX_ROWS = 120;

export type QuickOpen = {
  /** Open it now, asking `load` for the list — for a menu item or button, not just the shortcut. */
  open(): Promise<void>;
  /** Open on a list the caller already has (an ambiguous ⌘-click, say). Skips `load`. */
  openWith(list: QuickOpenList): void;
  close(): void;
  destroy(): void;
};

const basename = (path: string): string => path.split("/").pop() || path;

/**
 * How well a row answers the query. Zero is "not at all". The order is what a hand would do:
 * the file whose NAME starts with what you typed, then a name containing it, then a folder
 * containing it, then letters-in-order — `prodsp` still finds `product_spine`. Ties go to the
 * shorter path, because `main.ts` is more often meant than `vendor/x/y/main.ts`.
 */
function score(target: QuickOpenTarget, needle: string): number {
  if (!needle) return 1;
  const name = (target.name ?? basename(target.path)).toLocaleLowerCase();
  const path = target.path.toLocaleLowerCase();
  if (name.startsWith(needle)) return 400 - Math.min(99, name.length);
  if (name.includes(needle)) return 300 - Math.min(99, name.length);
  if (path.includes(needle)) return 200 - Math.min(99, path.length);
  if (target.detail?.toLocaleLowerCase().includes(needle)) return 150;
  let cursor = 0;
  for (const character of path) {
    if (character === needle[cursor]) cursor += 1;
    if (cursor === needle.length) return 100 - Math.min(99, path.length);
  }
  return 0;
}

/** The name with the typed part marked, so the eye lands on WHY this row is here. */
function nameNode(name: string, needle: string): HTMLElement {
  const node = document.createElement("b");
  const at = needle ? name.toLocaleLowerCase().indexOf(needle) : -1;
  if (at < 0) {
    node.textContent = name;
    return node;
  }
  const mark = document.createElement("mark");
  mark.textContent = name.slice(at, at + needle.length);
  node.append(name.slice(0, at), mark, name.slice(at + needle.length));
  return node;
}

function dirname(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "" : path.slice(0, cut);
}

export function mountQuickOpen(options: QuickOpenOptions): QuickOpen {
  const root = document.createElement("div");
  root.className = "nav-picker";
  root.hidden = true;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");

  const panel = document.createElement("section");
  const title = document.createElement("b");
  title.className = "nav-picker-title";
  const input = document.createElement("input");
  input.className = "nav-picker-input";
  input.type = "search";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.placeholder = options.placeholder ?? "Filter by file, folder, or relationship";
  const list = document.createElement("div");
  list.className = "nav-picker-list";
  list.setAttribute("role", "listbox");
  const hint = document.createElement("small");
  hint.textContent = "↑↓ choose  ·  return open  ·  esc close";
  panel.append(title, input, list, hint);
  root.append(panel);
  options.host.append(root);

  let targets: QuickOpenTarget[] = [];
  let visible: QuickOpenTarget[] = [];
  let index = 0;
  /** Bumped on every open and close, so a slow fetch can tell it has been outlived. */
  let generation = 0;
  let awaiting = false;

  function close(): void {
    generation += 1;
    awaiting = false;
    root.hidden = true;
    targets = [];
    visible = [];
    input.value = "";
    options.restoreFocus?.();
  }

  function choose(target: QuickOpenTarget): void {
    close();
    options.onChoose(target);
  }

  function render(): void {
    const query = input.value.trim().toLocaleLowerCase();
    visible = query
      ? targets
          .map((target, at) => ({ target, at, score: score(target, query) }))
          .filter((row) => row.score > 0)
          .sort((a, b) => b.score - a.score || a.at - b.at)
          .map((row) => row.target)
      : targets;
    index = Math.max(0, Math.min(index, visible.length - 1, MAX_ROWS - 1));
    const frag = document.createDocumentFragment();
    visible.slice(0, MAX_ROWS).forEach((target, position) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "nav-picker-row";
      row.classList.toggle("is-selected", position === index);
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(position === index));

      const identity = fileVisual({ name: basename(target.path) });
      const icon = document.createElement("span");
      icon.className = target.icon ? "qo-icon" : `ft-glyph ${identity.className}`;
      icon.innerHTML = target.icon ?? identity.svg;
      const body = document.createElement("span");
      const name = nameNode(target.name ?? basename(target.path), query);
      const detail = document.createElement("small");
      detail.textContent = `${dirname(target.path)}${target.detail ? ` · ${target.detail}` : ""}`;
      body.append(name, detail);
      const line = document.createElement("i");
      line.textContent = target.line ? `:${target.line}` : (target.label ?? identity.label);
      row.append(icon, body, line);
      row.addEventListener("mouseenter", () => {
        if (index !== position) {
          index = position;
          render();
        }
      });
      row.addEventListener("click", () => choose(target));
      frag.append(row);
    });
    if (!visible.length) {
      const none = document.createElement("p");
      none.className = "nav-picker-empty";
      /* Mid-fetch there is nothing to report yet — saying "no matches" would be a lie that
         corrects itself a moment later, which reads as a bug. */
      none.textContent = awaiting ? "Looking…" : (options.emptyText ?? "Nothing matches.");
      frag.append(none);
    }
    list.replaceChildren(frag);
    list.querySelector(".is-selected")?.scrollIntoView({ block: "nearest" });
  }

  function openWith(next: QuickOpenList): void {
    if (!next.targets.length && !next.pending) {
      options.onEmpty?.();
      return;
    }
    const mine = ++generation;
    targets = next.targets;
    awaiting = !!next.pending;
    index = 0;
    title.textContent = next.title;
    input.value = "";
    root.hidden = false;
    render();
    requestAnimationFrame(() => input.focus());

    /* The rest arrives late. Keep whatever they have typed and whatever row they had landed
       on — a list that reshuffles under the cursor is worse than one that arrives slowly. */
    void next.pending?.then((arrived) => {
      if (mine !== generation) return;
      const held = visible[index]?.path;
      targets = arrived;
      awaiting = false;
      render();
      const restored = visible.findIndex((target) => target.path === held);
      if (restored > 0) {
        index = restored;
        render();
      }
      if (!targets.length) {
        close();
        options.onEmpty?.();
      }
    }).catch(() => {
      if (mine !== generation) return;
      awaiting = false;
      render();
    });
  }

  const open = async (): Promise<void> => openWith(await options.load());

  input.addEventListener("input", () => {
    index = 0;
    render();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      index = Math.max(
        0,
        Math.min(visible.length - 1, MAX_ROWS - 1, index + (event.key === "ArrowDown" ? 1 : -1)),
      );
      render();
    } else if (event.key === "Enter") {
      const target = visible[index];
      if (target) choose(target);
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  });
  root.addEventListener("mousedown", (event) => {
    if (event.target === root) close();
  });

  const shortcut = options.shortcut ?? { key: "o", shift: true };
  const onShortcut = (event: KeyboardEvent): void => {
    if (
      event.key.toLowerCase() !== shortcut.key ||
      !event.metaKey ||
      event.shiftKey !== shortcut.shift ||
      event.ctrlKey ||
      event.altKey ||
      event.repeat ||
      options.host.closest("[hidden]") ||
      options.host.getClientRects().length === 0
    ) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void open();
  };
  window.addEventListener("keydown", onShortcut, !shortcut.late);

  return {
    open,
    openWith,
    close,
    destroy() {
      window.removeEventListener("keydown", onShortcut, !shortcut.late);
      root.remove();
    },
  };
}
