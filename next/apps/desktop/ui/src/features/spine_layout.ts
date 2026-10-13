/**
 * Placement for the Product Spine map. Pure: pins in, rectangles out, no DOM.
 *
 * The module's `map.json` says which flow each screen belongs to and which hop
 * put it there. This file decides where things sit, with one hard rule: no two
 * cards ever overlap, whatever the app's size.
 *
 *   · the hub sits at the centre
 *   · the way in (boot, splash, consent) stands above it
 *   · every flow is a block: collapsed, it is one group card; expanded, its
 *     screens are laid out by depth, left to right, like a small tree
 *   · blocks are packed around the hub on a ring wide enough for all of them,
 *     then each is pulled inward as far as it goes without touching a neighbour
 *
 * The ring packing uses each block's bounding circle, so blocks are disjoint by
 * construction; the pull-in step only ever moves a block while it stays clear of
 * everything already placed. Deterministic: the same packet gives the same map.
 */

export type Rect = { x: number; y: number; w: number; h: number };

/** The slice of a map pin the layout needs. `MapPin` satisfies it. */
export type LayoutPin = {
  name: string;
  kind: "boot" | "hub" | "screen" | "group";
  x: number;
  y: number;
  row: number;
  ghost: boolean;
  leaf: boolean;
  uncharted: boolean;
  enter: { label: string | null; ref: string | null } | null;
  shot: string | null;
};

export type Hop = { from: string; to: string; row: number };

export type Card<P extends LayoutPin = LayoutPin> = {
  pin: P;
  rect: Rect;
  head: Rect;
  enter: Rect | null;
  shotBox: Rect | null;
  compact: boolean;
  /** Index into `blocks`, or -1 for the hub. */
  block: number;
};

export type GroupCard<P extends LayoutPin = LayoutPin> = {
  block: number;
  label: string;
  rect: Rect;
  head: Rect;
  thumb: Rect | null;
  members: P[];
  sample: P | null;
};

export type Block = {
  index: number;
  kind: "entry" | "flow" | "uncharted";
  label: string;
  rect: Rect;
  expanded: boolean;
  /** Names of the screens inside, ghosts included. */
  names: Set<string>;
};

export type Layout<P extends LayoutPin = LayoutPin> = {
  cards: Card<P>[];
  groups: GroupCard<P>[];
  blocks: Block[];
  hub: Card<P> | null;
  width: number;
  height: number;
};

export const W = { hub: 340, screen: 300, leaf: 200, ghost: 180, boot: 220, group: 220 } as const;
const GAP = 64; // clear air between blocks
const COL_GAP = 72; // between depth columns inside a flow
const ROW_GAP = 26; // between stacked cards inside a column
const PAD = 160; // world margin
const THUMB_H = 150;

export type CardSize = { w: number; h: number; pad: number; headH: number; enterH: number; badgesH: number; shotH: number };

export function cardSize(pin: LayoutPin, aspect: number): CardSize {
  const w = pin.kind === "hub" ? W.hub : pin.kind === "boot" ? W.boot : pin.ghost ? W.ghost : pin.leaf ? W.leaf : W.screen;
  const compact = pin.leaf || pin.ghost;
  const headH = compact ? 24 : 30;
  const enterH = pin.enter ? (compact ? 18 : 22) : 0;
  const badgesH = pin.kind === "boot" || pin.ghost ? 0 : compact ? 16 : 20;
  const pad = compact ? 8 : 10;
  const shotW = w - pad * 2;
  const shotH = pin.kind === "boot" || !pin.shot ? 0 : Math.round(shotW * aspect);
  const h = pad + enterH + headH + badgesH + shotH + pad + (pin.kind === "boot" ? 30 : 0);
  return { w, h, pad, headH, enterH, badgesH, shotH };
}

function place<P extends LayoutPin>(pin: P, x: number, y: number, aspect: number, block: number): Card<P> {
  const s = cardSize(pin, aspect);
  const rect = { x, y, w: s.w, h: s.h };
  let yy = rect.y + s.pad;
  const shotW = s.w - s.pad * 2;
  const enter = pin.enter ? { x: rect.x + s.pad, y: yy, w: shotW, h: s.enterH - 4 } : null;
  yy += s.enterH;
  const head = { x: rect.x + s.pad, y: yy, w: shotW, h: s.headH };
  yy += s.headH + s.badgesH;
  const shotBox = s.shotH ? { x: rect.x + s.pad, y: yy, w: shotW, h: s.shotH } : null;
  return { pin, rect, head, enter, shotBox, compact: pin.leaf || pin.ghost, block };
}

function shift(r: Rect, dx: number, dy: number): Rect {
  return { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h };
}

function moveCard<P extends LayoutPin>(c: Card<P>, dx: number, dy: number): void {
  c.rect = shift(c.rect, dx, dy);
  c.head = shift(c.head, dx, dy);
  if (c.enter) c.enter = shift(c.enter, dx, dy);
  if (c.shotBox) c.shotBox = shift(c.shotBox, dx, dy);
}

export function overlaps(a: Rect, b: Rect, gap = 0): boolean {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}

/** depth of every pin in one row, walking the row's hops from its roots */
function depths(names: Set<string>, hops: Hop[], row: number, roots: string[]): Map<string, number> {
  const adj = new Map<string, string[]>();
  for (const h of hops) {
    if (h.row !== row) continue;
    const l = adj.get(h.from) ?? [];
    l.push(h.to);
    adj.set(h.from, l);
  }
  const d = new Map<string, number>();
  const q: string[] = [];
  for (const r of roots) {
    d.set(r, 0);
    q.push(r);
  }
  while (q.length) {
    const c = q.shift()!;
    for (const t of adj.get(c) ?? []) {
      if (!d.has(t)) {
        d.set(t, d.get(c)! + 1);
        q.push(t);
      }
    }
  }
  for (const n of names) if (!d.has(n)) d.set(n, 1);
  return d;
}

/** columns of cards, left to right by depth, each column stacked and centred */
function treeBlock<P extends LayoutPin>(pins: P[], depth: Map<string, number>, aspect: number, block: number, minDepth: number): { cards: Card<P>[]; w: number; h: number } {
  const cols = new Map<number, P[]>();
  for (const p of pins) {
    const d = Math.max(minDepth, depth.get(p.name) ?? minDepth);
    const l = cols.get(d) ?? [];
    l.push(p);
    cols.set(d, l);
  }
  const keys = [...cols.keys()].sort((a, b) => a - b);
  const colW = keys.map((k) => Math.max(...cols.get(k)!.map((p) => cardSize(p, aspect).w)));
  const colH = keys.map((k) => cols.get(k)!.reduce((s, p) => s + cardSize(p, aspect).h, 0) + ROW_GAP * (cols.get(k)!.length - 1));
  const h = Math.max(...colH, 0);
  const cards: Card<P>[] = [];
  let x = 0;
  keys.forEach((k, i) => {
    let y = (h - colH[i]) / 2;
    for (const p of cols.get(k)!) {
      const s = cardSize(p, aspect);
      cards.push(place(p, x + (colW[i] - s.w) / 2, y, aspect, block));
      y += s.h + ROW_GAP;
    }
    x += colW[i] + COL_GAP;
  });
  return { cards, w: x - COL_GAP, h };
}

/** rows of cards, top to bottom by depth (the way in reads downward into the hub) */
function stackBlock<P extends LayoutPin>(pins: P[], depth: Map<string, number>, aspect: number, block: number): { cards: Card<P>[]; w: number; h: number } {
  const rows = new Map<number, P[]>();
  for (const p of pins) {
    const d = depth.get(p.name) ?? 0;
    const l = rows.get(d) ?? [];
    l.push(p);
    rows.set(d, l);
  }
  const keys = [...rows.keys()].sort((a, b) => a - b);
  const rowW = keys.map((k) => rows.get(k)!.reduce((s, p) => s + cardSize(p, aspect).w, 0) + COL_GAP * (rows.get(k)!.length - 1));
  const rowH = keys.map((k) => Math.max(...rows.get(k)!.map((p) => cardSize(p, aspect).h)));
  const w = Math.max(...rowW, 0);
  const cards: Card<P>[] = [];
  let y = 0;
  keys.forEach((k, i) => {
    let x = (w - rowW[i]) / 2;
    for (const p of rows.get(k)!) {
      const s = cardSize(p, aspect);
      cards.push(place(p, x, y + (rowH[i] - s.h) / 2, aspect, block));
      x += s.w + COL_GAP;
    }
    y += rowH[i] + ROW_GAP;
  });
  return { cards, w, h: y - ROW_GAP };
}

/** a grid, `perRow` wide */
function gridBlock<P extends LayoutPin>(pins: P[], aspect: number, block: number, perRow: number): { cards: Card<P>[]; w: number; h: number } {
  const cards: Card<P>[] = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  let w = 0;
  pins.forEach((p, i) => {
    const s = cardSize(p, aspect);
    if (i && i % perRow === 0) {
      y += rowH + ROW_GAP;
      x = 0;
      rowH = 0;
    }
    cards.push(place(p, x, y, aspect, block));
    x += s.w + COL_GAP;
    rowH = Math.max(rowH, s.h);
    w = Math.max(w, x - COL_GAP);
  });
  return { cards, w, h: y + rowH };
}

export type LayoutInput<P extends LayoutPin> = {
  pins: P[];
  hops: Hop[];
  flows: { label: string }[];
  orientation: "portrait" | "landscape";
  /** Which flow labels are open. A flow with one screen is always open. */
  expanded: (label: string) => boolean;
};

export function computeLayout<P extends LayoutPin>(input: LayoutInput<P>): Layout<P> {
  const { pins, hops, flows } = input;
  const aspect = input.orientation === "landscape" ? 402 / 874 : 874 / 402;
  const hubPin = pins.find((p) => p.kind === "hub") ?? null;
  const hubName = hubPin?.name ?? "";

  // ── group pins into blocks ───────────────────────────────────────────────
  type Raw = { kind: Block["kind"]; label: string; pins: P[]; row: number };
  const entry: Raw = { kind: "entry", label: "Start", pins: [], row: 0 };
  const byFlow = new Map<number, Raw>();
  const unch: Raw = { kind: "uncharted", label: "Uncharted", pins: [], row: -1 };
  for (const p of pins) {
    if (p.kind === "hub") continue;
    if (p.uncharted) {
      unch.pins.push(p);
      unch.row = p.row;
    } else if (p.row === 0) {
      entry.pins.push(p);
    } else {
      const fi = p.row - 1;
      const label = flows[fi]?.label ?? `Flow ${fi + 1}`;
      const r = byFlow.get(fi) ?? { kind: "flow", label, pins: [], row: p.row };
      r.pins.push(p);
      byFlow.set(fi, r);
    }
  }
  const raws: Raw[] = [];
  if (entry.pins.length) raws.push(entry);
  for (const fi of [...byFlow.keys()].sort((a, b) => a - b)) raws.push(byFlow.get(fi)!);
  if (unch.pins.length) raws.push(unch);

  // ── lay each block out on its own, origin at (0,0) ───────────────────────
  const blocks: Block[] = [];
  const cardsOf: Card<P>[][] = [];
  const groupOf: (GroupCard<P> | null)[] = [];
  raws.forEach((r, bi) => {
    const names = new Set(r.pins.map((p) => p.name));
    const single = r.pins.length === 1;
    const expanded = r.kind === "entry" || single || input.expanded(r.label);
    let w: number;
    let h: number;
    let cards: Card<P>[] = [];
    let group: GroupCard<P> | null = null;
    if (!expanded) {
      const sample = r.pins.find((p) => p.shot && !p.ghost) ?? r.pins[0];
      const thumb = sample?.shot ? THUMB_H : 0;
      w = W.group;
      h = 8 + 24 + 16 + (thumb ? thumb + 6 : 0) + 8;
      group = {
        block: bi,
        label: r.label,
        rect: { x: 0, y: 0, w, h },
        head: { x: 8, y: 8, w: w - 16, h: 24 },
        thumb: thumb ? { x: 8, y: 8 + 24 + 16 + 6, w: w - 16, h: thumb } : null,
        members: r.pins,
        sample: sample ?? null,
      };
    } else if (r.kind === "entry") {
      const boots = r.pins.filter((p) => p.kind === "boot").map((p) => p.name);
      const d = depths(names, hops, 0, boots.length ? boots : [r.pins[0].name]);
      ({ cards, w, h } = stackBlock(r.pins, d, aspect, bi));
    } else if (r.kind === "flow") {
      const d = depths(names, hops, r.row, [hubName]);
      ({ cards, w, h } = treeBlock(r.pins, d, aspect, bi, 1));
    } else {
      ({ cards, w, h } = gridBlock(r.pins, aspect, bi, 4));
    }
    blocks.push({ index: bi, kind: r.kind, label: r.label, rect: { x: 0, y: 0, w, h }, expanded, names });
    cardsOf.push(cards);
    groupOf.push(group);
  });

  // ── the hub at the origin ─────────────────────────────────────────────────
  let hub: Card<P> | null = null;
  if (hubPin) {
    const s = cardSize(hubPin, aspect);
    hub = place(hubPin, -s.w / 2, -s.h / 2, aspect, -1);
  }
  const hubRect = hub?.rect ?? { x: -1, y: -1, w: 2, h: 2 };
  const hubR = Math.hypot(hubRect.w, hubRect.h) / 2;

  // ── pack the blocks on a ring: bounding circles never meet ───────────────
  const radii = blocks.map((b) => Math.hypot(b.rect.w, b.rect.h) / 2 + GAP / 2);
  const entryIx = blocks.findIndex((b) => b.kind === "entry");
  let R = Math.max(hubR + GAP + Math.max(...radii, 0), 200);
  const need = (r: number) => radii.reduce((s, ri) => s + 2 * Math.asin(Math.min(1, ri / r)), 0);
  while (need(R) > Math.PI * 2 && R < 1e6) R += 24;
  const spare = blocks.length ? (Math.PI * 2 - need(R)) / blocks.length : 0;
  const slots = radii.map((ri) => 2 * Math.asin(Math.min(1, ri / R)) + spare);
  // the entry block is centred at 12 o'clock; the rest follow clockwise
  const order = entryIx >= 0 ? [entryIx, ...blocks.map((_b, i) => i).filter((i) => i !== entryIx)] : blocks.map((_b, i) => i);
  let ang = -Math.PI / 2 - (entryIx >= 0 ? slots[entryIx] / 2 : 0);
  for (const i of order) {
    const mid = ang + slots[i] / 2;
    const cx = R * Math.cos(mid);
    const cy = R * Math.sin(mid);
    blocks[i].rect = { ...blocks[i].rect, x: cx - blocks[i].rect.w / 2, y: cy - blocks[i].rect.h / 2 };
    ang += slots[i];
  }

  // ── pull each block toward the hub while it stays clear of everything ─────
  const clear = (i: number, r: Rect): boolean => {
    if (overlaps(r, hubRect, GAP)) return false;
    for (let j = 0; j < blocks.length; j++) {
      if (j !== i && overlaps(r, blocks[j].rect, GAP)) return false;
    }
    return true;
  };
  for (let pass = 0; pass < 3; pass++) {
    for (const i of order) {
      const b = blocks[i];
      for (let step = 0; step < 400; step++) {
        const cx = b.rect.x + b.rect.w / 2;
        const cy = b.rect.y + b.rect.h / 2;
        const len = Math.hypot(cx, cy);
        if (len < 24) break;
        const dx = (-cx / len) * 24;
        const dy = (-cy / len) * 24;
        const next = shift(b.rect, dx, dy);
        if (!clear(i, next)) break;
        b.rect = next;
      }
    }
  }

  // ── absolute positions, then shift the world into positive space ──────────
  const cards: Card<P>[] = [];
  const groups: GroupCard<P>[] = [];
  blocks.forEach((b, bi) => {
    for (const c of cardsOf[bi]) {
      moveCard(c, b.rect.x, b.rect.y);
      cards.push(c);
    }
    const g = groupOf[bi];
    if (g) {
      g.rect = shift(g.rect, b.rect.x, b.rect.y);
      g.head = shift(g.head, b.rect.x, b.rect.y);
      if (g.thumb) g.thumb = shift(g.thumb, b.rect.x, b.rect.y);
      groups.push(g);
    }
  });
  if (hub) cards.push(hub);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const all: Rect[] = [...cards.map((c) => c.rect), ...groups.map((g) => g.rect), ...blocks.map((b) => b.rect)];
  for (const r of all) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  if (!Number.isFinite(minX)) return { cards: [], groups: [], blocks: [], hub: null, width: 800, height: 600 };
  const dx = PAD - minX;
  const dy = PAD - minY;
  for (const c of cards) {
    moveCard(c, dx, dy);
    c.pin.x = c.rect.x + c.rect.w / 2;
    c.pin.y = c.rect.y + c.rect.h / 2;
  }
  for (const g of groups) {
    g.rect = shift(g.rect, dx, dy);
    g.head = shift(g.head, dx, dy);
    if (g.thumb) g.thumb = shift(g.thumb, dx, dy);
  }
  for (const b of blocks) b.rect = shift(b.rect, dx, dy);
  return { cards, groups, blocks, hub, width: maxX - minX + PAD * 2, height: maxY - minY + PAD * 2 };
}

/** Every pair of drawn rectangles that touch. Empty when the layout is sound. */
export function collisions(l: Layout): [string, string][] {
  const items: { name: string; rect: Rect }[] = [
    ...l.cards.map((c) => ({ name: c.pin.name + (c.pin.ghost ? "↪" : ""), rect: c.rect })),
    ...l.groups.map((g) => ({ name: "⊞" + g.label, rect: g.rect })),
  ];
  const out: [string, string][] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (overlaps(items[i].rect, items[j].rect)) out.push([items[i].name, items[j].name]);
    }
  }
  return out;
}
