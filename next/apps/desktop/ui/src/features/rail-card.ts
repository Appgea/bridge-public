/**
 * The project card: what a sidebar row knows, one hover away.
 *
 * A row has room for a name and one line. The card has room for the rest: the next move, the
 * last report, git, two weeks of commits, where the app stands, and the three things you most
 * often go into a project to do. A parked agent's question shows here too, with the terminal's
 * last lines, so you can see what you are allowing before you allow it.
 *
 * It opens after a short dwell, never on a pass-through, and stays while the pointer travels
 * into it. It takes no focus unless it is pinned open from the row's Answer button.
 */

import "./rail-card.css";

export type CardAction = { label: string; run: () => void; primary?: boolean; danger?: boolean };

export type CardModel = {
  name: string;
  lane: string;
  laneTone: string;
  status: string;
  notes: string;
  move: { title: string; detail: string } | null;
  report: { title: string; age: string; open: () => void } | null;
  git: string;
  activity: { spark: string; caption: string } | null;
  signals: string[];
  /** A parked agent: its question, and for a terminal prompt the screen lines it is asking about. */
  ask: { headline: string; screen: string[]; actions: CardAction[] } | null;
  actions: CardAction[];
};

export type RailCardHandle = {
  /** Show for this row after the dwell. `build` runs at show time so the facts are fresh. */
  hover(row: HTMLElement, build: () => CardModel): void;
  /** Open now and keep it open until the pointer leaves the card, focusing its first button. */
  pin(row: HTMLElement, build: () => CardModel): void;
  leave(): void;
  /**
   * The rail repainted and its rows are new nodes. Follow the card's project to its new row while
   * the pointer is on it or on the card, else close: a card must never speak for a row nobody is
   * pointing at.
   */
  repainted(find: (project: string) => HTMLElement | null): void;
  hide(): void;
  isOpen(): boolean;
};

const DWELL_MS = 420;
const GRACE_MS = 160;

const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

export function mountRailCard(): RailCardHandle {
  const card = make("aside", "rail-card");
  card.hidden = true;
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "Project details");
  document.body.append(card);

  let dwell = 0;
  let grace = 0;
  let anchor: HTMLElement | null = null;

  const clear = (): void => {
    window.clearTimeout(dwell);
    window.clearTimeout(grace);
  };

  const hide = (): void => {
    clear();
    card.hidden = true;
    card.replaceChildren();
    anchor?.classList.remove("is-carded");
    anchor = null;
  };

  const button = (action: CardAction): HTMLButtonElement => {
    const node = make("button", "rail-card-do", action.label);
    node.type = "button";
    node.classList.toggle("is-primary", Boolean(action.primary));
    node.classList.toggle("is-danger", Boolean(action.danger));
    node.addEventListener("click", (event) => {
      event.stopPropagation();
      hide();
      action.run();
    });
    return node;
  };

  const render = (model: CardModel): void => {
    const head = make("header", "rail-card-head");
    const title = make("b", "", model.name);
    const lane = make("span", `rail-card-lane t-${model.laneTone}`, model.lane);
    head.append(title, lane);
    const nodes: HTMLElement[] = [head];
    if (model.status || model.notes) {
      const standing = make("p", "rail-card-standing");
      if (model.status) standing.append(make("span", "rail-card-status", model.status));
      if (model.notes) standing.append(make("span", "rail-card-notes", model.notes));
      nodes.push(standing);
    }
    if (model.ask) {
      const ask = make("section", "rail-card-ask");
      ask.append(make("label", "", "Waiting on you"), make("strong", "", model.ask.headline));
      if (model.ask.screen.length) {
        const screen = make("pre", "rail-card-screen");
        screen.textContent = model.ask.screen.join("\n");
        ask.append(screen);
      }
      const row = make("div", "rail-card-row");
      row.append(...model.ask.actions.map(button));
      ask.append(row);
      nodes.push(ask);
    }
    if (model.move) {
      const move = make("section", "rail-card-move");
      move.append(make("label", "", "Next move"), make("strong", "", model.move.title), make("p", "", model.move.detail));
      nodes.push(move);
    }
    if (model.report) {
      const report = make("button", "rail-card-report");
      report.type = "button";
      const report_ = model.report;
      report.append(make("label", "", `Last report · ${report_.age}`), make("span", "", report_.title));
      report.addEventListener("click", () => {
        hide();
        report_.open();
      });
      nodes.push(report);
    }
    const facts = make("dl", "rail-card-facts");
    const fact = (term: string, value: string): void => {
      if (!value) return;
      facts.append(make("dt", "", term), make("dd", "", value));
    };
    fact("Git", model.git);
    for (const signal of model.signals) fact("Signal", signal);
    if (facts.childElementCount) nodes.push(facts);
    if (model.activity) {
      const activity = make("div", "rail-card-activity");
      activity.innerHTML = model.activity.spark;
      activity.append(make("span", "", model.activity.caption));
      nodes.push(activity);
    }
    if (model.actions.length) {
      const row = make("div", "rail-card-row rail-card-actions");
      row.append(...model.actions.map(button));
      nodes.push(row);
    }
    card.replaceChildren(...nodes);
  };

  const place = (row: HTMLElement): void => {
    const rail = row.closest(".sidebar") ?? row.parentElement!;
    const edge = rail.getBoundingClientRect().right;
    const box = row.getBoundingClientRect();
    card.style.left = `${Math.round(edge + 8)}px`;
    card.style.top = "0px";
    const height = card.getBoundingClientRect().height;
    const top = Math.max(8, Math.min(box.top - 6, innerHeight - height - 8));
    card.style.top = `${Math.round(top)}px`;
  };

  const open = (row: HTMLElement, build: () => CardModel): void => {
    clear();
    if (!row.isConnected) return;
    anchor?.classList.remove("is-carded");
    anchor = row;
    row.classList.add("is-carded");
    render(build());
    card.hidden = false;
    place(row);
  };

  card.addEventListener("mouseenter", () => window.clearTimeout(grace));
  card.addEventListener("mouseleave", () => {
    grace = window.setTimeout(hide, GRACE_MS);
  });
  card.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const back = anchor;
    hide();
    back?.focus();
  });
  addEventListener("blur", hide);
  addEventListener("resize", hide);

  return {
    hover(row, build) {
      clear();
      if (!card.hidden && anchor === row) return;
      dwell = window.setTimeout(() => open(row, build), card.hidden ? DWELL_MS : 60);
    },
    pin(row, build) {
      open(row, build);
      card.querySelector<HTMLButtonElement>("button")?.focus();
    },
    leave() {
      window.clearTimeout(dwell);
      if (!card.hidden) grace = window.setTimeout(hide, GRACE_MS);
    },
    repainted(find) {
      if (card.hidden || !anchor || anchor.isConnected) return;
      const project = anchor.dataset.projectId ?? "";
      const fresh = project ? find(project) : null;
      if (fresh && (fresh.matches(":hover") || card.matches(":hover"))) {
        anchor = fresh;
        fresh.classList.add("is-carded");
        return;
      }
      if (!card.matches(":hover")) hide();
    },
    hide,
    isOpen: () => !card.hidden,
  };
}
