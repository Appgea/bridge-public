/**
 * `card` — the generic primitive, and the fallback for every type we have no renderer for.
 *
 * Two jobs, one body of code:
 *   - DISPLAY view: blocks render, the `input` block renders INERT (nothing to answer to).
 *   - ASK widget:   the same blocks, but the `input` block is LIVE and wired to the socket.
 * The only difference is whether `onInput` is null. Forking these would guarantee they drift.
 *
 * It is also the catch-all, so it must survive a payload it has never seen: no `blocks` at all,
 * a block with an unknown kind, a `rows` that is an object. Nothing here throws; the worst case
 * is a key/value dump of whatever the agent actually sent.
 */

import type { Payload, RenderCtx } from "../types";
import { arr, disable, el, looksLikeRef, num, obj, prose, refButton, scalar, str, tone } from "./dom";
import { renderInput } from "./inputs";

export type OnInput = (id: string, value: unknown) => void;

const HEAD_KEYS = new Set(["title", "icon", "ref", "blocks", "type", "kind"]);

export function renderCard(
  payload: Payload,
  ctx: RenderCtx,
  onInput: OnInput | null = null,
): HTMLElement {
  const root = el("article", "v v-card");

  const title = str(payload.title);
  const icon = str(payload.icon);
  const ref = str(payload.ref);
  if (title || icon || ref) root.append(head(icon, title, ref, ctx));

  // One answer per card. The first input block that fires wins and the whole card goes quiet.
  let spent = false;
  const commit: OnInput | null = onInput
    ? (id, value) => {
        if (spent) return;
        spent = true;
        root.classList.add("is-answered");
        disable(root);
        onInput(id, value);
      }
    : null;

  const body = el("div", "v-body");
  const blocks = arr(payload.blocks);
  let index = 0;
  for (const raw of blocks) {
    const node = renderBlock(obj(raw), ctx, commit);
    if (!node) continue;
    node.classList.add("v-blk");
    node.style.setProperty("--i", String(index++));
    body.append(node);
  }

  // No blocks: we are almost certainly the fallback for a type nobody registered. Show the
  // payload as facts rather than dropping the agent's message on the floor.
  if (index === 0) {
    const rows = Object.entries(payload)
      .filter(([key]) => !HEAD_KEYS.has(key))
      .map(([key, value]) => ({ k: key, v: scalar(value) }));
    if (rows.length) body.append(kv({ rows }));
    else if (!title) body.append(el("p", "v-empty", "empty payload"));
  }

  root.append(body);
  return root;
}

function head(icon: string, title: string, ref: string, ctx: RenderCtx): HTMLElement {
  const node = el("header", "v-head");
  if (icon) node.append(el("i", "v-icon", icon));
  node.append(el("h3", "v-title", title || "card"));
  if (ref) {
    node.append(
      looksLikeRef(ref) ? refButton(ref, ctx) : el("span", "v-slug", ref),
    );
  }
  return node;
}

/* ----------------------------------------------------------------- blocks */

function renderBlock(block: Payload, ctx: RenderCtx, commit: OnInput | null): HTMLElement | null {
  switch (str(block.kind)) {
    case "heading":
      return heading(block);
    case "text":
      return prose(str(block.md), "v-text");
    case "kv":
      return kv(block);
    case "meter":
      return meter(block);
    case "badges":
      return badges(block);
    case "steps":
      return steps(block);
    case "callout":
      return callout(block);
    case "coderef":
      return coderef(block, ctx);
    case "table":
      return table(block);
    case "divider":
      return el("hr", "v-rule");
    case "input":
      return input(block, commit);
    default:
      return unknown(block);
  }
}

function heading(block: Payload): HTMLElement {
  const node = el("div", "v-heading");
  node.append(el("b", undefined, str(block.text)));
  const sub = str(block.sub);
  if (sub) node.append(el("small", undefined, sub));
  return node;
}

function kv(block: Payload): HTMLElement {
  const node = el("dl", "v-kv");
  for (const raw of arr(block.rows)) {
    const row = obj(raw);
    node.append(el("dt", undefined, str(row.k)));
    const value = el("dd", `t-${tone(row.tone) || "none"}`, scalar(row.v));
    node.append(value);
  }
  return node;
}

/**
 * The fill is `transform: scaleX()` off a transform-origin of left — never an animated width.
 * A width animation relayouts the whole card every frame; a scale is one composite.
 */
function meter(block: Payload): HTMLElement {
  const max = num(block.max, 100) || 100;
  const value = num(block.value, 0);
  const ratio = Math.max(0, Math.min(1, value / max));

  const node = el("div", `v-meter t-${tone(block.tone) || "none"}`);
  const top = el("div", "v-meter-top");
  top.append(el("span", undefined, str(block.label)));
  top.append(el("b", undefined, max === 100 ? `${Math.round(ratio * 100)}%` : `${value} / ${max}`));
  node.append(top);

  const track = el("div", "v-track");
  const fill = el("i", "v-fill");
  fill.style.setProperty("--v", String(ratio));
  track.append(fill);
  node.append(track);

  const note = str(block.note);
  if (note) node.append(el("small", "v-meter-note", note));
  return node;
}

function badges(block: Payload): HTMLElement {
  const node = el("div", "v-badges");
  for (const raw of arr(block.items)) {
    if (typeof raw === "string") {
      node.append(el("span", "v-badge t-none", raw));
      continue;
    }
    const item = obj(raw);
    node.append(el("span", `v-badge t-${tone(item.tone) || "none"}`, str(item.text)));
  }
  return node;
}

const STEP_STATES = new Set(["done", "active", "pending", "fail"]);

function steps(block: Payload): HTMLElement {
  const node = el("ol", "v-steps");
  arr(block.items).forEach((raw, index) => {
    const item = obj(raw);
    const state = STEP_STATES.has(str(item.state)) ? str(item.state) : "pending";
    const row = el("li", `v-step s-${state}`);
    row.style.setProperty("--i", String(index));
    row.append(el("i", "v-dot"));
    const body = el("div", "v-step-body");
    body.append(el("b", undefined, str(item.label)));
    const note = str(item.note);
    if (note) body.append(el("small", undefined, note));
    row.append(body);
    node.append(row);
  });
  return node;
}

function callout(block: Payload): HTMLElement {
  const node = el("div", `v-callout t-${tone(block.tone) || "info"}`);
  node.append(el("i", "v-callout-bar"));
  node.append(prose(str(block.text)));
  return node;
}

function coderef(block: Payload, ctx: RenderCtx): HTMLElement {
  const file = str(block.file);
  const lines = str(block.lines);
  const ref = lines ? `${file}:${lines}` : file;

  const node = el("div", "v-coderef");
  node.append(refButton(ref, ctx, ref));
  const note = str(block.note);
  if (note) node.append(el("small", undefined, note));
  return node;
}

function table(block: Payload): HTMLElement {
  const cols = arr(block.cols).slice(0, 4).map((col) => scalar(col));
  const wrap = el("div", "v-table-wrap");
  const node = el("table", "v-table");

  if (cols.length) {
    const head = el("thead");
    const row = el("tr");
    for (const col of cols) row.append(el("th", undefined, col));
    head.append(row);
    node.append(head);
  }

  const body = el("tbody");
  for (const raw of arr(block.rows)) {
    const cells = Array.isArray(raw) ? raw : [raw];
    const row = el("tr");
    for (const cell of cells.slice(0, Math.max(cols.length, cells.length))) {
      row.append(el("td", undefined, scalar(cell)));
    }
    body.append(row);
  }
  node.append(body);
  wrap.append(node);
  return wrap;
}

function input(block: Payload, commit: OnInput | null): HTMLElement {
  const spec = obj(block.input);
  const id = str(spec.id, "value");
  return renderInput(spec, commit ? (value) => commit(id, value) : null);
}

/** An unknown block kind is still the agent talking. Show it, flagged, rather than eating it. */
function unknown(block: Payload): HTMLElement | null {
  const kind = str(block.kind);
  if (!kind) return null;
  const node = el("div", "v-unknown");
  node.append(el("i", undefined, kind));
  node.append(el("span", undefined, scalar(block)));
  return node;
}
