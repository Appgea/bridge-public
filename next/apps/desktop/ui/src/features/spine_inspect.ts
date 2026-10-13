/**
 * The screen detail page of the Product Spine.
 *
 * One screen, every look it has, every control on it, and what each control does. The
 * facts come from the probe the app's own shot test ran (`spine_probe.dart`): a control is
 * a real widget with a real tap handler, its box is where it rendered, and its effect is
 * what the tap did — pushed a screen, opened a dialog, changed the picture, or nothing.
 * Nothing here is guessed from source; the static address map only lends a file:line.
 *
 * States sit in a strip on top (←/→ walks them). Controls are hotspots on the picture and
 * rows on the side, one list, two views. Filters hide the noise: what does nothing is off
 * by default. A control that pushes a screen the map knows opens that screen in place;
 * Backspace walks back.
 */

import type { MapPin } from "./spine_map";
import "./spine_inspect.css";

export type RuntimeElement = {
  id: string;
  key: string | null;
  label: string | null;
  type: string;
  rect: [number, number, number, number];
  effect: "screen" | "dialog" | "state" | "back" | "none" | "error" | "covered" | "input" | "skipped" | "repeat";
  /** For a repeat: the id of the first control with the same type and label. */
  like: string | null;
  to: string | null;
  state: string | null;
  error: string | null;
  /** Below the fold at rest: no hotspot on the picture, scrolled into view for the tap. */
  offscreen: boolean;
  ref: string | null;
  file: string | null;
  line: number | null;
};

export type RuntimeState = { id: string; via: string | null; label: string | null; shot: string };

export type Runtime = {
  size: [number, number] | null;
  elements: RuntimeElement[];
  states: RuntimeState[];
};

type Filter = "nav" | "state" | "dialog" | "none" | "error";

const FILTERS: { id: Filter; label: string; title: string }[] = [
  { id: "nav", label: "→ navigates", title: "pushes a screen, or pops one" },
  { id: "state", label: "↻ changes look", title: "same screen, different picture" },
  { id: "dialog", label: "▢ opens dialog", title: "a sheet, dialog or menu" },
  { id: "none", label: "· does nothing", title: "no visible change, covered, input, or skipped" },
  { id: "error", label: "⚠ throws", title: "the tap threw" },
];

const DEFAULT_ON: Filter[] = ["nav", "state", "dialog", "error"];
const STORE = "spine.inspect.show";

function filterOf(e: RuntimeElement): Filter {
  switch (e.effect) {
    case "screen":
    case "back":
      return "nav";
    case "state":
      return "state";
    case "dialog":
      return "dialog";
    case "error":
      return "error";
    default:
      return "none";
  }
}

function effectText(e: RuntimeElement): string {
  switch (e.effect) {
    case "screen":
      return `→ ${e.to ?? "a screen"}`;
    case "back":
      return "← back";
    case "state":
      return "↻ changes look";
    case "dialog":
      return "▢ opens dialog";
    case "error":
      return `⚠ ${e.error ?? "throws"}`;
    case "covered":
      return e.error ? `· covered, ${e.error}` : "· covered";
    case "input":
      return "▢ text input";
    case "skipped":
      return "· not tapped";
    default:
      return "· nothing";
  }
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/** The line an agent needs to find this control: screen, id, key, source, effect. */
export function addressOf(screen: string, e: RuntimeElement): string {
  const parts = [`${screen} › ${e.id}`];
  if (e.key) parts.push(`key: ${e.key}`);
  else if (e.label) parts.push(`label: "${e.label}"`);
  parts.push(e.type);
  if (e.file) parts.push(`${e.file}:${e.line ?? ""}`);
  if (e.offscreen) parts.push("below the fold");
  if (e.effect === "screen" && e.to) parts.push(`→ ${e.to}`);
  return parts.join("  ·  ");
}

export type InspectorHandle = {
  open(pin: MapPin, bust: string): void;
  close(): void;
  back(): boolean;
  isOpen(): boolean;
};

export function mountInspector(
  host: HTMLElement,
  api: {
    origin: string;
    /** Resolve a screen name to its pin, or null when the map does not draw it. */
    pinOf(name: string): MapPin | null;
    copy(text: string): void;
    toast(msg: string): void;
  },
): InspectorHandle {
  let show = new Set<Filter>(DEFAULT_ON);
  try {
    const saved = localStorage.getItem(STORE);
    if (saved) show = new Set(JSON.parse(saved) as Filter[]);
  } catch {
    /* no storage — defaults */
  }
  let hotspots = true;
  const history: MapPin[] = [];
  let pin: MapPin | null = null;
  let bust = "";
  let stateIx = 0;
  let hoverId: string | null = null;

  function persist(): void {
    try {
      localStorage.setItem(STORE, JSON.stringify([...show]));
    } catch {
      /* fine */
    }
  }

  function visible(e: RuntimeElement): boolean {
    return show.has(filterOf(e));
  }

  function render(): void {
    if (!pin) return;
    const rt = pin.runtime;
    const states = rt?.states.length ? rt.states : pin.shot ? [{ id: "base", via: null, label: null, shot: pin.shot }] : [];
    stateIx = Math.min(stateIx, Math.max(0, states.length - 1));
    const cur = states[stateIx];
    const shotUrl = (s: string) => `${api.origin}${s}?v=${encodeURIComponent(bust)}`;
    const size = rt?.size ?? null;
    const all = rt?.elements ?? [];
    // Forty identical tiles are one row: the first carries the count.
    const alike = new Map<string, number>();
    for (const e of all) if (e.effect === "repeat" && e.like) alike.set(e.like, (alike.get(e.like) ?? 0) + 1);
    const elements = all.filter((e) => e.effect !== "repeat");
    const shown = elements.filter(visible);
    const counts = new Map<Filter, number>();
    for (const e of elements) counts.set(filterOf(e), (counts.get(filterOf(e)) ?? 0) + 1);
    const unkeyed = elements.filter((e) => !e.key && e.effect !== "none" && e.effect !== "covered").length;

    // A thumb says what made it: ▢ a dialog over the screen, ↻ the screen itself changed.
    const glyphFor = (s: RuntimeState): string => {
      const by = s.via ? all.find((e) => e.id === s.via) : null;
      return by?.effect === "dialog" ? "▢ " : by ? "↻ " : "";
    };
    const stateStrip = states.length > 1
      ? `<div class="si-states">${states
          .map(
            (s, i) =>
              `<button type="button" class="si-state${i === stateIx ? " on" : ""}" data-ix="${i}" title="${esc(
                s.via ? `after tapping ${s.via}` : "as staged",
              )}"><img src="${esc(shotUrl(s.shot))}" alt=""><span>${esc(
                i === 0 ? "as staged" : glyphFor(s) + (s.label ?? s.id),
              )}</span></button>`,
          )
          .join("")}<span class="si-states-hint">←/→</span></div>`
      : "";

    // One number per shown control: the badge on the picture and the badge on the row match.
    const numberOf = new Map<string, number>();
    shown.forEach((e, i) => numberOf.set(e.id, i + 1));

    const spots = hotspots && stateIx === 0 && size
      ? shown
          .filter((e) => e.rect && !e.offscreen)
          .map((e) => {
            const [x, y, w, h] = e.rect;
            const st = `left:${(x / size[0]) * 100}%;top:${(y / size[1]) * 100}%;width:${(w / size[0]) * 100}%;height:${(h / size[1]) * 100}%`;
            return `<i class="si-spot ${filterOf(e)}${e.id === hoverId ? " on" : ""}" data-id="${esc(e.id)}" style="${st}" title="${esc(
              `${e.id} — ${effectText(e)}`,
            )}"><b>${numberOf.get(e.id)}</b></i>`;
          })
          .join("")
      : "";

    const rows = shown
      .map(
        (e) =>
          `<li class="si-row ${filterOf(e)}${e.id === hoverId ? " on" : ""}" data-id="${esc(e.id)}" title="${esc(
            addressOf(pin!.name, e),
          )}">` +
          `<b class="si-n ${filterOf(e)}">${numberOf.get(e.id)}</b>` +
          `<span class="si-id" title="${e.key ? "has a Key" : "no Key on this widget — an agent cannot target it reliably"}">${
            e.key ? "" : '<i class="nokey">○</i>'
          }${esc(e.id)}</span>` +
          `<span class="si-label">${esc(e.label && e.label !== e.key ? e.label : e.type)}${
            alike.get(e.id) ? `<em>+${alike.get(e.id)} alike</em>` : ""
          }</span>` +
          `<span class="si-fx">${esc(effectText(e))}${e.offscreen ? " ↓" : ""}</span>` +
          `<button type="button" class="si-copy" title="copy the address">⧉</button></li>`,
      )
      .join("");

    const chips = FILTERS.filter((f) => counts.get(f.id)).map(
      (f) =>
        `<button type="button" class="si-chip ${f.id}${show.has(f.id) ? " on" : ""}" data-f="${f.id}" title="${esc(
          f.title,
        )}">${f.label}<b>${counts.get(f.id) ?? 0}</b></button>`,
    ).join("");

    const staticRows = !rt && pin.addresses.length
      ? `<p class="si-hint">No probe yet — retake shots to map the controls. Static addresses:</p><ul class="si-static">${pin.addresses
          .map(
            (a) =>
              `<li data-copy="${esc(`${a.ref}\n  ${a.file}:${a.line}`)}"><span class="k">${esc(a.kind)}</span><span class="l">${esc(
                a.label ?? a.ref.split(" › ").pop() ?? "",
              )}</span>${a.action ? `<span class="a">→ ${esc(a.action)}</span>` : ""}</li>`,
          )
          .join("")}</ul>`
      : "";

    host.innerHTML = `
      <div class="si-card">
        <header>
          ${history.length ? '<button type="button" class="si-back" title="back (Backspace)">←</button>' : ""}
          <h2>${esc(pin.title)}</h2>
          <span class="src">${esc(pin.file ?? "")}${pin.line ? ":" + pin.line : ""}</span>
          <span class="si-meta">${states.length} ${states.length === 1 ? "look" : "looks"} · ${elements.length} controls${
            unkeyed ? ` · <em title="widgets with no Key">○ ${unkeyed} without key</em>` : ""
          }</span>
          <button type="button" class="si-brief-btn" title="copy the brief for a prompt">⧉ brief</button>
          <button type="button" class="x" title="close (Esc)">×</button>
        </header>
        ${stateStrip}
        <div class="si-main">
          <div class="si-stage">
            ${cur ? `<img src="${esc(shotUrl(cur.shot))}" alt="${esc(pin.name)}">${spots}` : `<div class="noshot">${esc(pin.shotNote || "no shot")}</div>`}
            ${stateIx > 0 ? '<span class="si-stage-note">controls are mapped on the staged look</span>' : ""}
          </div>
          <aside class="si-side">
            <div class="si-filters">${chips}<button type="button" class="si-chip spots${hotspots ? " on" : ""}" data-f="spots" title="draw the controls over the picture">⌖ hotspots</button></div>
            ${rt ? `<ul class="si-list">${rows || '<li class="si-empty">nothing to show with these filters</li>'}</ul>` : staticRows}
          </aside>
        </div>
      </div>`;
    wire();
  }

  function wire(): void {
    host.querySelector(".x")?.addEventListener("click", close);
    host.querySelector(".si-back")?.addEventListener("click", () => back());
    host.querySelector(".si-brief-btn")?.addEventListener("click", () => {
      api.copy(pin?.packet ?? pin?.name ?? "");
      api.toast("copied the brief");
    });
    host.querySelectorAll<HTMLElement>(".si-state").forEach((b) =>
      b.addEventListener("click", () => {
        stateIx = Number(b.dataset.ix);
        render();
      }),
    );
    host.querySelectorAll<HTMLElement>(".si-chip").forEach((b) =>
      b.addEventListener("click", () => {
        const f = b.dataset.f as Filter | "spots";
        if (f === "spots") hotspots = !hotspots;
        else {
          if (show.has(f)) show.delete(f);
          else show.add(f);
          persist();
        }
        render();
      }),
    );
    host.querySelectorAll<HTMLElement>(".si-static li").forEach((li) =>
      li.addEventListener("click", () => {
        api.copy(li.dataset.copy ?? "");
        api.toast(`copied\n${li.dataset.copy ?? ""}`);
      }),
    );
    const sync = (id: string | null) => {
      if (id === hoverId) return;
      hoverId = id;
      host.querySelectorAll<HTMLElement>("[data-id]").forEach((el) => el.classList.toggle("on", el.dataset.id === id));
    };
    host.querySelectorAll<HTMLElement>("[data-id]").forEach((el) => {
      el.addEventListener("pointerenter", () => sync(el.dataset.id ?? null));
      el.addEventListener("pointerleave", () => sync(null));
      el.addEventListener("click", (ev) => {
        const e = pin?.runtime?.elements.find((x) => x.id === el.dataset.id);
        if (!e || !pin) return;
        const wantCopy = (ev.target as HTMLElement).closest(".si-copy") || ev.metaKey || ev.shiftKey;
        if (wantCopy) {
          const text = addressOf(pin.name, e);
          api.copy(text);
          api.toast(`copied\n${text}`);
          return;
        }
        act(e);
      });
    });
  }

  /** What a click on a control does: follow it, or show what it did. */
  function act(e: RuntimeElement): void {
    if (!pin) return;
    if (e.effect === "screen" && e.to) {
      const next = api.pinOf(e.to);
      if (!next) {
        api.toast(`${e.to} has no shot yet — it is not on the map`);
        return;
      }
      history.push(pin);
      pin = next;
      stateIx = 0;
      hoverId = null;
      render();
      return;
    }
    if (e.state && pin.runtime) {
      const ix = pin.runtime.states.findIndex((s) => s.id === e.state);
      if (ix >= 0) {
        stateIx = ix;
        render();
        return;
      }
    }
    const text = addressOf(pin.name, e);
    api.copy(text);
    api.toast(`copied\n${text}`);
  }

  function open(p: MapPin, b: string): void {
    history.length = 0;
    pin = p;
    bust = b;
    stateIx = 0;
    hoverId = null;
    host.hidden = false;
    render();
  }

  function close(): void {
    host.hidden = true;
    host.innerHTML = "";
    pin = null;
    history.length = 0;
  }

  function back(): boolean {
    const prev = history.pop();
    if (!prev) return false;
    pin = prev;
    stateIx = 0;
    hoverId = null;
    render();
    return true;
  }

  host.addEventListener("click", (ev) => {
    if (ev.target === host) close();
  });

  document.addEventListener("keydown", (ev) => {
    if (host.hidden || !pin) return;
    if ((ev.target as HTMLElement | null)?.closest("input, textarea")) return;
    const n = pin.runtime?.states.length ?? 1;
    if (ev.key === "ArrowRight" && n > 1) {
      stateIx = (stateIx + 1) % n;
      render();
    } else if (ev.key === "ArrowLeft" && n > 1) {
      stateIx = (stateIx - 1 + n) % n;
      render();
    } else if (ev.key === "Backspace") {
      if (back()) ev.preventDefault();
    }
  });

  return {
    open,
    close,
    back,
    isOpen: () => !host.hidden,
  };
}
