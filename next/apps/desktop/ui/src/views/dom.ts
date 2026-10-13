/**
 * The primitives every renderer shares: safe reads off an untrusted payload, a two-rule
 * inline formatter, and the ref button.
 *
 * A payload comes off a socket from an agent. It is `Record<string, unknown>` and it MEANS it:
 * fields go missing, numbers arrive as strings, arrays arrive as objects. Every accessor here
 * is total — it always returns something renderable — because a half-drawn card beats a thrown
 * renderer, and a thrown renderer looks to the human like the agent said nothing at all.
 */

import type { Payload, RenderCtx } from "../types";

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/* ------------------------------------------------------------------ reads */

export function str(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return fallback;
}

export function num(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function bool(value: unknown): boolean {
  return value === true || value === "true";
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function obj(value: unknown): Payload {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Payload)
    : {};
}

/** Anything -> one line a human can read. Used only where the agent gave us a shapeless value. */
export function scalar(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

const TONES = new Set(["info", "ok", "warn", "risk"]);

/** Tones are a closed set. An unknown tone is neutral, never a broken class name. */
export function tone(value: unknown): string {
  const name = str(value);
  return TONES.has(name) ? name : "";
}

/* ----------------------------------------------------------------- inline */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The ONLY place a payload string becomes markup. Escape first, then apply exactly two rules —
 * `**bold**` and `` `code` ``. Nothing else is markup: an agent-authored `<script>` is text.
 */
export function inline(text: string): string {
  return escapeHtml(text).replace(
    /`([^`]+)`|\*\*([\s\S]+?)\*\*/g,
    (_match: string, code: string | undefined, bold: string | undefined) =>
      code !== undefined ? `<code>${code}</code>` : `<b>${bold}</b>`,
  );
}

/** A block of prose with the two inline rules applied. Safe: `inline` escaped it. */
export function prose(text: string, className?: string): HTMLElement {
  const node = el("p", className);
  node.innerHTML = inline(text);
  return node;
}

const FENCE = /^\s*```(\w*)\s*$/;
const HEADING = /^(#{1,4})\s+(.*)$/;
const BULLET = /^\s*[-*•]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;

/**
 * The same text, given its shape back. An agent writes lists, steps and code fences; `prose` put
 * all of it in one <p> with `white-space: pre-wrap`, which is why a report read as a wall — the
 * structure was in the string and nowhere in the layout.
 *
 * Block level only, and the same security property as `inline`: every leaf run goes through
 * `inline`, which escapes before it promotes anything, so agent-authored `<script>` is still text.
 * Bare URLs are deliberately NOT linked here — openable things belong in the action rail, not
 * scattered mid-sentence.
 */
export function richProse(text: string, className?: string): HTMLElement {
  const root = el("div", className ? `v-prose ${className}` : "v-prose");
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let paragraph: string[] = [];
  // The open list/quote a following line can join instead of starting its own.
  let block: HTMLElement | null = null;

  const flushParagraph = (): void => {
    if (!paragraph.length) return;
    const node = el("p");
    node.innerHTML = inline(paragraph.join("\n"));
    root.append(node);
    paragraph = [];
  };
  const flush = (): void => {
    flushParagraph();
    block = null;
  };
  /** Append `html` as a row of an open `tag` block, opening one if the run just started. */
  const row = (tag: "ul" | "ol" | "blockquote", html: string): void => {
    flushParagraph();
    if (!block || block.localName !== tag) {
      block = el(tag, `v-prose-${tag === "blockquote" ? "quote" : "list"}`);
      root.append(block);
    }
    const item = el(tag === "blockquote" ? "p" : "li");
    item.innerHTML = html;
    block.append(item);
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      const pre = el("pre", "v-prose-code");
      if (fence[1]) pre.dataset.lang = fence[1];
      pre.append(el("code", undefined, body.join("\n")));
      root.append(pre);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      const node = el("h4", "v-prose-h");
      node.innerHTML = inline(heading[2]);
      root.append(node);
      continue;
    }
    const quote = QUOTE.exec(line);
    if (quote) {
      row("blockquote", inline(quote[1]));
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet) {
      row("ul", inline(bullet[1]));
      continue;
    }
    const ordered = ORDERED.exec(line);
    if (ordered) {
      row("ol", inline(ordered[1]));
      continue;
    }
    // A plain line after a list belongs to the prose again, not to the last bullet.
    block = null;
    paragraph.push(line);
  }
  flush();
  return root;
}

/* ------------------------------------------------------------------- refs */

/** A location in code. Clicking it is how a view jumps the editor to what it is talking about. */
export function refButton(ref: string, ctx: RenderCtx, label?: string): HTMLButtonElement {
  const node = el("button", "v-ref", label ?? ref);
  node.type = "button";
  node.title = `open ${ref}`;
  node.addEventListener("click", () => ctx.openRef(ref));
  return node;
}

/** A ref is a path, maybe with a line. A card `ref` like "auth-refactor" is a topic, not a file. */
export function looksLikeRef(value: string): boolean {
  return /[/\\]/.test(value) || /\.\w+(:\d+)?$/.test(value);
}

/* ------------------------------------------------------------------- lock */

/** Kill every control under `root`. An answered question must not be answerable twice. */
export function disable(root: HTMLElement): void {
  const controls = root.querySelectorAll<
    HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
  >("button, input, textarea, select");
  for (const control of controls) control.disabled = true;
}
