/** The Servers board, as a card on the Settings screen.
 *
 * It is portfolio-wide on purpose. A server belongs to the estate, not to a repo — the box
 * serving a static site is usually not described anywhere in that site's source — so binding
 * this to a project would put the tab on the wrong screens and hide it from the right ones.
 *
 * Two things it deliberately does not do. It does not poll on a timer: the motion budget bans
 * repaint loops, and the launchd sweep keeps the stored file fresh whether or not Panel is even
 * open. And it does not probe on mount — the stored answer is shown first with its own age next
 * to it, so opening Settings costs nothing and a live check is something you asked for.
 */

import { moduleGet, modulePost } from "./modules";
import { errorText } from "../errors";
import "./server_health.css";

const M = "/m/server-health";

export type ServerHealthHandle = {
  /** Repaint from the stored file. Cheap — no network. */
  refresh(): void;
};

type Check = { kind: string; ok: boolean; detail: string; severity: string };
type Result = {
  id: string;
  label: string;
  url: string;
  state: "up" | "degraded" | "down" | "skipped";
  checks: Check[];
  failed: string[];
  latency_ms: number | null;
  status?: number | null;
  confirmed?: boolean;
  note?: string | null;
};
type Summary = {
  up: number;
  degraded: number;
  down: number;
  skipped: number;
  checked_at: string | null;
};
type Portfolio = {
  summary: Summary;
  results: Result[];
  checked_at: string | null;
  targets_path?: string;
};

const ORDER: Record<string, number> = { down: 0, degraded: 1, up: 2, skipped: 3 };

const el = <T extends HTMLElement>(tag: string, cls?: string, text?: string): T => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node as T;
};

function ageOf(iso: string | null | undefined): string {
  if (!iso) return "never checked";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "checked";
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 2) return "checked just now";
  if (mins < 90) return `checked ${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `checked ${hours} h ago`;
  return `checked ${Math.round(hours / 24)} d ago`;
}

export function mountServerHealth(host: HTMLElement): ServerHealthHandle {
  let busy = false;
  let last: Portfolio | null = null;

  const tally = el("span", "sh-tally");
  const stamp = el("span", "sh-stamp");
  const checkAll = el<HTMLButtonElement>("button", "sh-refresh", "Check now");
  checkAll.type = "button";
  checkAll.addEventListener("click", () => void sweep());

  const bar = el("div", "sh-bar");
  bar.append(tally, stamp, checkAll);

  const list = el("div", "sh-list");
  const foot = el("div", "sh-foot");
  host.append(bar, list, foot);

  function row(r: Result): HTMLElement {
    const item = el("div", `sh-row sh-${r.state}`);
    const dot = el("span", "sh-dot");
    dot.title = r.state;

    const name = el("div", "sh-name");
    name.append(el("div", "sh-label", r.label), el("div", "sh-url", r.url));

    const detail = el("div", "sh-detail");
    if (r.state === "skipped") {
      detail.append(el("div", "sh-muted", r.note || "not watched"));
    } else if (r.failed.length) {
      for (const f of r.failed) detail.append(el("div", "sh-fail", f));
      // A single miss is weather. Say so, rather than letting the red dot overstate it.
      if (r.state === "down" && !r.confirmed) {
        detail.append(el("div", "sh-muted", "first miss — one more before it counts as down"));
      }
    } else {
      const cert = r.checks.find((c) => c.kind === "tls");
      detail.append(
        el(
          "div",
          "sh-muted",
          [
            r.status ? `HTTP ${r.status}` : "",
            r.latency_ms != null ? `${r.latency_ms}ms` : "",
            cert?.ok ? `cert ${cert.detail}` : "",
          ]
            .filter(Boolean)
            .join(" · "),
        ),
      );
    }

    const one = el<HTMLButtonElement>("button", "sh-one", "Check");
    one.type = "button";
    one.disabled = r.state === "skipped";
    one.addEventListener("click", () => void sweep(r.id));

    item.append(dot, name, detail, one);
    return item;
  }

  /** Nothing configured. The only screen most people see first, so it has to teach. */
  function empty(): HTMLElement {
    const box = el("div", "sh-empty");
    box.append(
      el("div", "sh-empty-line", "No servers yet."),
      el(
        "div",
        "sh-empty-hint",
        "Panel does not know what you run, and a list seeded with someone else's servers is " +
          "noise you would have to clear first. Ask an agent to set it up — it reads the " +
          "module's AGENT.md, finds your hosts in your own deploy scripts, checks each one is " +
          "real, and writes the list.",
      ),
      el("code", "sh-empty-cmd", "set up the server health check"),
    );
    return box;
  }

  function render(p: Portfolio) {
    last = p;
    const s = p.summary;
    if (!p.results.length) {
      tally.textContent = "";
      stamp.textContent = "";
      checkAll.hidden = true;
      list.replaceChildren(empty());
      foot.replaceChildren();
      return;
    }
    checkAll.hidden = false;

    const parts = [`${s.up} up`];
    if (s.degraded) parts.push(`${s.degraded} degraded`);
    if (s.down) parts.push(`${s.down} down`);
    if (s.skipped) parts.push(`${s.skipped} not watched`);
    tally.textContent = parts.join(" · ");
    tally.className = `sh-tally ${s.down ? "sh-bad" : s.degraded ? "sh-warn" : "sh-ok"}`;
    stamp.textContent = ageOf(p.checked_at);

    const sorted = [...p.results].sort(
      (a, b) => (ORDER[a.state] ?? 9) - (ORDER[b.state] ?? 9) || a.label.localeCompare(b.label),
    );
    list.replaceChildren(...sorted.map(row));
    foot.replaceChildren(el("span", "sh-path", p.targets_path ?? ""));
  }

  async function load() {
    try {
      render(await moduleGet<Portfolio>(`${M}/portfolio`));
    } catch (e) {
      list.replaceChildren(el("div", "sh-error", errorText(e, "Server status could not be read. Press Check now to try again.")));
    }
  }

  async function sweep(id?: string) {
    if (busy) return;
    busy = true;
    checkAll.disabled = true;
    checkAll.textContent = "Checking…";
    try {
      render(await modulePost<Portfolio>(`${M}/check`, id ? { id } : {}));
    } catch (e) {
      if (!last) list.replaceChildren(el("div", "sh-error", errorText(e, "The check did not finish. Try again.")));
    } finally {
      busy = false;
      checkAll.disabled = false;
      checkAll.textContent = "Check now";
    }
  }

  void load();

  return {
    refresh() {
      void load();
    },
  };
}
