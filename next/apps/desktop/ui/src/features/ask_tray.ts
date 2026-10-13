/**
 * The ask tray — where an agent's blocking question is answered.
 *
 * `ask_user` parks the agent's tool call on a socket until a human answers. The question can
 * come from any project while you are looking at any screen, so it cannot live inside one tab:
 * the tray floats over every screen, bottom right, and leaves the moment nothing is open.
 *
 * It never takes focus. A question that grabbed the keyboard would eat the next keystroke you
 * meant for a terminal. You click into it when you choose to.
 *
 * The tray is the one record of which questions are open. main.ts asks it, rather than keeping
 * a second list that could disagree.
 */

import type { AskSpec, RenderCtx } from "../types";
import { renderAsk } from "../registry";
import "./ask_tray.css";

export type AskTrayEvents = {
  projectName(project: string): string;
  sessionName(session: string): string;
  ctx(project: string): RenderCtx;
  /** Hand the answer to the parked agent. */
  answer(qid: string, value: unknown): void;
  openSession(project: string, session: string): void;
  /** The set of open questions changed. */
  changed(): void;
};

export type AskTrayHandle = {
  open(project: string, session: string, qid: string, spec: AskSpec): void;
  /** The ingress closed it: answered, timed out, or cancelled. */
  close(qid: string): void;
  /** The agent's terminal exited. Its questions have nobody left to answer to. */
  closeSession(session: string): void;
  sessionAsking(session: string): boolean;
  /** Project ids with at least one open question. */
  projects(): Set<string>;
  /** Latest open question text for this project, for the rail and Home. */
  headline(project: string): string | null;
};

type Open = { project: string; session: string; spec: AskSpec; card: HTMLElement };

const headlineOf = (spec: AskSpec): string =>
  String(spec.title ?? spec.prompt ?? spec.ask ?? "needs your answer");

export function mountAskTray(events: AskTrayEvents): AskTrayHandle {
  const tray = document.createElement("section");
  tray.className = "ask-tray";
  tray.setAttribute("aria-label", "Agent questions");
  tray.setAttribute("aria-live", "polite");
  tray.hidden = true;
  document.body.append(tray);

  const open = new Map<string, Open>();

  const settle = (): void => {
    tray.hidden = open.size === 0;
    events.changed();
  };

  const remove = (qid: string): void => {
    const item = open.get(qid);
    if (!item) return;
    open.delete(qid);
    item.card.remove();
    settle();
  };

  return {
    open(project, session, qid, spec) {
      if (open.has(qid)) return;
      const card = document.createElement("article");
      card.className = "ask-card";
      card.dataset.qid = qid;

      const head = document.createElement("header");
      head.className = "ask-card-head";
      const who = document.createElement("span");
      who.className = "ask-card-who";
      who.textContent = `${events.projectName(project)} · ${events.sessionName(session)}`;
      const go = document.createElement("button");
      go.type = "button";
      go.className = "ghost ask-card-go";
      go.textContent = "Open agent";
      go.title = "Go to the terminal that asked";
      go.addEventListener("click", () => events.openSession(project, session));
      head.append(who, go);

      // `answer` fires once per widget. The card stays until the ingress confirms, so a slow
      // round-trip shows as a locked card rather than a vanished one.
      const body = renderAsk(spec, (value) => {
        card.classList.add("is-answered");
        events.answer(qid, value);
      }, events.ctx(project));

      const foot = document.createElement("footer");
      foot.className = "ask-card-foot";
      const skip = document.createElement("button");
      skip.type = "button";
      skip.className = "ghost ask-card-skip";
      skip.textContent = "Skip";
      skip.title = "Tell the agent you chose not to answer";
      skip.addEventListener("click", () => {
        card.classList.add("is-answered");
        events.answer(qid, { skipped: true });
      });
      foot.append(skip);

      card.append(head, body, foot);
      tray.append(card);
      open.set(qid, { project, session, spec, card });
      settle();
    },
    close: remove,
    closeSession(session) {
      for (const [qid, item] of open) {
        if (item.session === session) remove(qid);
      }
    },
    sessionAsking: (session) => [...open.values()].some((item) => item.session === session),
    projects: () => new Set([...open.values()].map((item) => item.project)),
    headline(project) {
      let latest: Open | null = null;
      for (const item of open.values()) if (item.project === project) latest = item;
      return latest ? headlineOf(latest.spec) : null;
    },
  };
}
