/**
 * Xcode's jump bar: where you are, as a row of crumbs you can click.
 *
 * `project › folder › file › Type › method`. Every crumb is a menu. A folder lists what is in it,
 * the file lists its neighbours, and a symbol opens the file's outline (⌃6) with the current
 * item ticked. Type while a menu is open and it filters; ← and → walk to the next crumb's menu,
 * which is how Xcode lets you climb a path without the mouse.
 *
 * The bar is a dumb renderer. The host says what the crumbs are and what each menu holds, and
 * repaints the symbol half on caret moves. Only a changed chain touches the DOM, so resting the
 * caret costs one string compare.
 */

import type { OutlineKind } from "./outline";
import "./jump_bar.css";

export type JumpMenuItem = {
  label: string;
  /** Grey text after the label. */
  detail?: string;
  /** Markup for the glyph slot: a file icon or a symbol badge. */
  icon?: string;
  /** Nesting, for an outline. */
  depth?: number;
  /** A section title (`// MARK:`), drawn bold and still choosable. */
  heading?: boolean;
  /** Draw a rule above this row. */
  rule?: boolean;
  /** The row that is "here". Ticked, and selected when the menu opens. */
  current?: boolean;
  /** Choosing it opens another menu in place instead of closing (a folder). */
  drill?: () => JumpMenuSpec | Promise<JumpMenuSpec>;
  run?(): void;
};

export type JumpMenuSpec = {
  items: JumpMenuItem[];
  /** Said when there is nothing to list. */
  empty?: string;
};

export type JumpCrumb = {
  /** Stable identity. A repaint with the same keys and labels touches nothing. */
  key: string;
  label: string;
  icon?: string;
  title?: string;
  /** "No Selection" and similar: present, but quiet. */
  dim?: boolean;
  menu(): JumpMenuSpec | Promise<JumpMenuSpec>;
};

export type JumpBar = {
  readonly root: HTMLElement;
  /** Buttons before the crumbs (navigator toggle, history, related). */
  readonly lead: HTMLElement;
  /** Buttons after them. */
  readonly trail: HTMLElement;
  /** The file half: project, folders, file. */
  setPath(crumbs: JumpCrumb[]): void;
  /** The symbol half. Cheap to call on every caret move. */
  setSymbols(crumbs: JumpCrumb[]): void;
  /** Open the last crumb's menu (⌃6 with symbols, the file's folder without). */
  openLast(): void;
  /** Open a menu under any element, with the same keys and look. */
  openMenu(anchor: HTMLElement, spec: JumpMenuSpec | Promise<JumpMenuSpec>): void;
  isOpen(): boolean;
  close(): void;
  destroy(): void;
};

/* ------------------------------------------------------------------ badges */

/*
 * Xcode's symbol badges: a letter on a tinted square, coloured by family. Types are purple,
 * extensions orange, code that runs is blue, stored things teal. The letter carries the fact
 * for anyone who does not see the colour.
 */
const BADGES: Record<OutlineKind, { letter: string; tone: string }> = {
  class: { letter: "C", tone: "type" },
  struct: { letter: "S", tone: "type" },
  enum: { letter: "E", tone: "type" },
  protocol: { letter: "Pr", tone: "type" },
  type: { letter: "T", tone: "type" },
  extension: { letter: "Ex", tone: "ext" },
  function: { letter: "ƒ", tone: "func" },
  method: { letter: "M", tone: "func" },
  property: { letter: "P", tone: "prop" },
  constant: { letter: "K", tone: "prop" },
  case: { letter: "e", tone: "prop" },
  mark: { letter: "#", tone: "mark" },
  todo: { letter: "!", tone: "todo" },
  section: { letter: "#", tone: "mark" },
};

export function symbolBadge(kind: OutlineKind): string {
  const badge = BADGES[kind];
  return `<span class="jb-badge is-${badge.tone}" aria-hidden="true">${badge.letter}</span>`;
}

const CHEVRON = '<svg class="jb-sep" viewBox="0 0 6 10" aria-hidden="true"><path d="M1 1l4 4-4 4"/></svg>';

/* ------------------------------------------------------------------- menu */

/** Rows painted at once. An outline past this is filtered, not scrolled. */
const MAX_ROWS = 400;

/** Letters in order, case-blind. Returns the matched indexes, or null. Contiguous runs win. */
function matchIndexes(text: string, needle: string): number[] | null {
  const lower = text.toLocaleLowerCase();
  const at = lower.indexOf(needle);
  if (at >= 0) return Array.from({ length: needle.length }, (_, offset) => at + offset);
  const found: number[] = [];
  let cursor = 0;
  for (let index = 0; index < lower.length && cursor < needle.length; index += 1) {
    if (lower[index] === needle[cursor]) {
      found.push(index);
      cursor += 1;
    }
  }
  return cursor === needle.length ? found : null;
}

function marked(text: string, hits: number[] | null): DocumentFragment {
  const fragment = document.createDocumentFragment();
  if (!hits?.length) {
    fragment.append(text);
    return fragment;
  }
  const hit = new Set(hits);
  let run = "";
  let inHit = false;
  const flush = (): void => {
    if (!run) return;
    if (inHit) {
      const mark = document.createElement("mark");
      mark.textContent = run;
      fragment.append(mark);
    } else {
      fragment.append(run);
    }
    run = "";
  };
  for (let index = 0; index < text.length; index += 1) {
    const now = hit.has(index);
    if (now !== inHit) {
      flush();
      inHit = now;
    }
    run += text[index];
  }
  flush();
  return fragment;
}

type MenuHooks = {
  /** ← / → asked for the neighbouring crumb's menu. */
  sideways?(delta: -1 | 1): void;
  closed?(): void;
};

class JumpMenu {
  readonly root = document.createElement("div");
  private readonly input = document.createElement("input");
  private readonly list = document.createElement("div");
  private items: JumpMenuItem[] = [];
  private visible: { item: JumpMenuItem; hits: number[] | null }[] = [];
  private index = 0;
  private generation = 0;
  private emptyText = "Nothing here.";
  private anchor: HTMLElement | null = null;
  private hooks: MenuHooks = {};
  private readonly onPointer = (event: PointerEvent): void => {
    const target = event.target as Node;
    if (this.root.contains(target) || this.anchor?.contains(target)) return;
    this.close();
  };
  private readonly onBlur = (): void => this.close();

  constructor(container: HTMLElement) {
    this.root.className = "jb-menu";
    this.root.hidden = true;
    this.root.setAttribute("role", "menu");
    this.input.className = "jb-menu-filter";
    this.input.type = "text";
    this.input.spellcheck = false;
    this.input.autocomplete = "off";
    this.input.placeholder = "Filter";
    this.input.setAttribute("aria-label", "Filter");
    this.list.className = "jb-menu-list";
    this.root.append(this.input, this.list);
    container.append(this.root);

    this.input.addEventListener("input", () => {
      this.index = -1;
      this.render();
    });
    this.input.addEventListener("keydown", (event) => this.key(event));
    this.list.addEventListener("mousemove", (event) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>(".jb-row");
      const at = row ? Number(row.dataset.at) : -1;
      if (at >= 0 && at !== this.index) this.select(at, false);
    });
    this.list.addEventListener("click", (event) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>(".jb-row");
      if (row) void this.choose(Number(row.dataset.at));
    });
  }

  get open(): boolean {
    return !this.root.hidden;
  }

  show(anchor: HTMLElement, spec: JumpMenuSpec | Promise<JumpMenuSpec>, hooks: MenuHooks = {}): void {
    const mine = ++this.generation;
    this.anchor?.classList.remove("is-open");
    this.anchor = anchor;
    this.hooks = hooks;
    anchor.classList.add("is-open");
    this.input.value = "";
    this.root.hidden = false;
    if (spec instanceof Promise) {
      this.fill({ items: [], empty: "Looking…" });
      void spec.then((ready) => {
        if (mine === this.generation && this.open) this.fill(ready);
      }).catch(() => {
        if (mine === this.generation && this.open) this.fill({ items: [], empty: "Could not read this." });
      });
    } else {
      this.fill(spec);
    }
    window.addEventListener("pointerdown", this.onPointer, true);
    window.addEventListener("blur", this.onBlur);
    requestAnimationFrame(() => {
      if (mine === this.generation) this.input.focus({ preventScroll: true });
    });
  }

  close(): void {
    if (!this.open) return;
    this.generation += 1;
    this.root.hidden = true;
    this.anchor?.classList.remove("is-open");
    this.anchor = null;
    window.removeEventListener("pointerdown", this.onPointer, true);
    window.removeEventListener("blur", this.onBlur);
    this.list.replaceChildren();
    const closed = this.hooks.closed;
    this.hooks = {};
    closed?.();
  }

  private fill(spec: JumpMenuSpec): void {
    this.items = spec.items;
    this.emptyText = spec.empty ?? "Nothing here.";
    this.index = Math.max(0, this.items.findIndex((item) => item.current));
    this.render();
    this.place();
  }

  /** Under the anchor, left-aligned with it, kept inside the window. */
  private place(): void {
    if (!this.anchor) return;
    const box = this.anchor.getBoundingClientRect();
    const width = this.root.offsetWidth;
    const room = window.innerHeight - box.bottom - 12;
    this.root.style.maxHeight = `${Math.max(180, room)}px`;
    this.root.style.left = `${Math.max(6, Math.min(box.left - 6, window.innerWidth - width - 6))}px`;
    this.root.style.top = `${box.bottom + 3}px`;
  }

  private render(): void {
    const needle = this.input.value.trim().toLocaleLowerCase();
    this.visible = [];
    for (const item of this.items) {
      if (!needle) {
        this.visible.push({ item, hits: null });
        continue;
      }
      const hits = matchIndexes(item.label, needle);
      if (hits) this.visible.push({ item, hits });
    }
    if (needle) {
      // Filtering flattens the outline: a hit is read on its own, and the name that starts with
      // what you typed goes first.
      this.visible.sort((a, b) => (a.hits?.[0] ?? 0) - (b.hits?.[0] ?? 0));
      if (this.index < 0) this.index = 0;
    }
    this.index = Math.max(0, Math.min(this.index, this.visible.length - 1));
    const fragment = document.createDocumentFragment();
    this.visible.slice(0, MAX_ROWS).forEach(({ item, hits }, at) => {
      if (item.rule && !needle && at > 0) {
        const rule = document.createElement("hr");
        fragment.append(rule);
      }
      const row = document.createElement("div");
      row.className = "jb-row";
      row.dataset.at = String(at);
      row.setAttribute("role", "menuitem");
      row.classList.toggle("is-heading", !!item.heading);
      row.classList.toggle("is-current", !!item.current);
      row.classList.toggle("is-selected", at === this.index);
      row.classList.toggle("is-drill", !!item.drill);
      if (!needle && item.depth) row.style.paddingLeft = `${8 + item.depth * 14}px`;
      const tick = document.createElement("span");
      tick.className = "jb-tick";
      tick.textContent = item.current ? "✓" : "";
      const glyph = document.createElement("span");
      glyph.className = "jb-glyph";
      if (item.icon) glyph.innerHTML = item.icon;
      const label = document.createElement("span");
      label.className = "jb-label";
      label.append(marked(item.label, hits));
      row.append(tick, glyph, label);
      if (item.detail) {
        const detail = document.createElement("small");
        detail.textContent = item.detail;
        row.append(detail);
      }
      fragment.append(row);
    });
    if (!this.visible.length) {
      const none = document.createElement("p");
      none.className = "jb-empty";
      none.textContent = needle ? "No match." : this.emptyText;
      fragment.append(none);
    }
    this.list.replaceChildren(fragment);
    this.list.querySelector(".is-selected")?.scrollIntoView({ block: "nearest" });
  }

  private select(at: number, scroll = true): void {
    const rows = this.list.querySelectorAll<HTMLElement>(".jb-row");
    rows[this.index]?.classList.remove("is-selected");
    this.index = Math.max(0, Math.min(at, this.visible.length - 1, MAX_ROWS - 1));
    rows[this.index]?.classList.add("is-selected");
    if (scroll) rows[this.index]?.scrollIntoView({ block: "nearest" });
  }

  private async choose(at: number): Promise<void> {
    const entry = this.visible[at];
    if (!entry) return;
    const { item } = entry;
    if (item.drill && this.anchor) {
      const anchor = this.anchor;
      const hooks = this.hooks;
      this.show(anchor, item.drill(), hooks);
      return;
    }
    this.close();
    item.run?.();
  }

  private key(event: KeyboardEvent): void {
    const page = Math.max(1, Math.floor(this.list.clientHeight / 24) - 1);
    switch (event.key) {
      case "Escape":
        this.close();
        break;
      case "ArrowDown":
        this.select(this.index + 1);
        break;
      case "ArrowUp":
        this.select(this.index - 1);
        break;
      case "PageDown":
        this.select(this.index + page);
        break;
      case "PageUp":
        this.select(this.index - page);
        break;
      case "Home":
        if (this.input.value) return;
        this.select(0);
        break;
      case "End":
        if (this.input.value) return;
        this.select(this.visible.length - 1);
        break;
      case "Enter":
        void this.choose(this.index);
        break;
      case "ArrowLeft":
      case "ArrowRight":
        // Inside a typed filter the arrows edit text. On an empty one they walk the crumbs.
        if (this.input.value || !this.hooks.sideways) return;
        this.hooks.sideways(event.key === "ArrowLeft" ? -1 : 1);
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  destroy(): void {
    this.close();
    this.root.remove();
  }
}

/* -------------------------------------------------------------------- bar */

export function mountJumpBar(options: { container: HTMLElement; restoreFocus?(): void }): JumpBar {
  const root = document.createElement("nav");
  root.className = "jb";
  root.setAttribute("aria-label", "Jump bar");
  const lead = document.createElement("div");
  lead.className = "jb-lead";
  const crumbsEl = document.createElement("div");
  crumbsEl.className = "jb-crumbs";
  const pathEl = document.createElement("div");
  pathEl.className = "jb-path";
  const symbolsEl = document.createElement("div");
  symbolsEl.className = "jb-symbols";
  crumbsEl.append(pathEl, symbolsEl);
  const trail = document.createElement("div");
  trail.className = "jb-trail";
  root.append(lead, crumbsEl, trail);

  const menu = new JumpMenu(options.container);
  let pathCrumbs: JumpCrumb[] = [];
  let symbolCrumbs: JumpCrumb[] = [];
  let pathSignature = "";
  let symbolSignature = "";

  const all = (): { crumb: JumpCrumb; el: HTMLElement }[] => {
    const elements = [...crumbsEl.querySelectorAll<HTMLElement>(".jb-crumb")];
    return [...pathCrumbs, ...symbolCrumbs].map((crumb, index) => ({ crumb, el: elements[index] }));
  };

  function openAt(index: number): void {
    const list = all();
    const target = list[Math.max(0, Math.min(index, list.length - 1))];
    if (!target?.el) return;
    menu.show(target.el, target.crumb.menu(), {
      sideways: (delta) => openAt(list.indexOf(target) + delta),
      closed: () => options.restoreFocus?.(),
    });
  }

  function paint(into: HTMLElement, crumbs: JumpCrumb[], offset: () => number, leadingSeparator: boolean): void {
    const fragment = document.createDocumentFragment();
    crumbs.forEach((crumb, index) => {
      if (index > 0 || leadingSeparator) fragment.append(document.createRange().createContextualFragment(CHEVRON));
      const button = document.createElement("button");
      button.type = "button";
      button.className = "jb-crumb";
      button.classList.toggle("is-dim", !!crumb.dim);
      button.title = crumb.title ?? crumb.label;
      if (crumb.icon) {
        const glyph = document.createElement("span");
        glyph.className = "jb-glyph";
        glyph.innerHTML = crumb.icon;
        button.append(glyph);
      }
      const label = document.createElement("span");
      label.className = "jb-crumb-label";
      label.textContent = crumb.label;
      button.append(label);
      button.addEventListener("mousedown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        if (menu.open && button.classList.contains("is-open")) {
          menu.close();
          return;
        }
        openAt(offset() + index);
      });
      fragment.append(button);
    });
    into.replaceChildren(fragment);
  }

  const signature = (crumbs: JumpCrumb[]): string =>
    crumbs.map((crumb) => `${crumb.key}\u0000${crumb.label}\u0000${crumb.dim ? 1 : 0}`).join("\u0001");

  return {
    root,
    lead,
    trail,
    setPath(crumbs) {
      pathCrumbs = crumbs;
      const next = signature(crumbs);
      if (next === pathSignature) return;
      pathSignature = next;
      menu.close();
      paint(pathEl, crumbs, () => 0, false);
      // The symbol half's leading chevron depends on whether there is a path before it.
      symbolSignature = "";
      paint(symbolsEl, symbolCrumbs, () => pathCrumbs.length, pathCrumbs.length > 0);
      symbolSignature = signature(symbolCrumbs);
    },
    setSymbols(crumbs) {
      symbolCrumbs = crumbs;
      const next = signature(crumbs);
      if (next === symbolSignature) return;
      symbolSignature = next;
      paint(symbolsEl, crumbs, () => pathCrumbs.length, pathCrumbs.length > 0);
    },
    openLast: () => openAt(pathCrumbs.length + symbolCrumbs.length - 1),
    openMenu: (anchor, spec) => menu.show(anchor, spec, { closed: () => options.restoreFocus?.() }),
    isOpen: () => menu.open,
    close: () => menu.close(),
    destroy() {
      menu.destroy();
      root.remove();
    },
  };
}
