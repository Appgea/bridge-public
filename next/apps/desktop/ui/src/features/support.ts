/** Support — every support form in the portfolio, read into one screen.
 *
 * Portfolio-wide on purpose, like Servers. Eleven apps publish a Google Form as their support
 * channel, on store listings, privacy pages and settings screens. A per-project tab would put
 * the same inbox on eleven screens and split one queue into eleven queues.
 *
 * It sits next to Inbox because it is the same act: reading what came in. Inbox is what the
 * agents said, Support is what the people who use the apps said. The second one had no screen at
 * all until now, and messages were landing in spreadsheets nobody opened.
 *
 * It does not poll. Fetching walks eleven Google Forms, so it happens when you ask, and the
 * stored log is what the screen paints in the meantime.
 */

import { moduleGet, modulePost } from "./modules";
import { errorText } from "../errors";
import "./support.css";

const M = "/m/support";

export type SupportHandle = {
  open(): void;
  clear(): void;
  /** Unread count for the sidebar badge, from the last load. */
  unread(): number;
};

export type SupportEvents = {
  /** Unread changed — repaint the badge. */
  onUnread(count: number): void;
};

type Field = { question: string; answer: string };

type Message = {
  id: string;
  form_id: string;
  form_title: string;
  apps: string[];
  submitted_at: string;
  email: string;
  fields: Field[];
  text: string;
  lead: string;
  read: boolean;
};

type Inbox = { total: number; unread: number; messages: Message[] };

type Gap = { url: string; apps: string[]; reason: string };

type Setup = {
  stage: "no_key" | "no_access" | "partial" | "ready";
  credentials: { email: string; source: string; kind: string }[];
  grant_email: string;
  secrets_dir: string;
  forms_total: number;
  forms_readable: number;
  gaps: Gap[];
  scanned_at: string;
};

type FetchReport = {
  fetched_at: string;
  forms_linked: number;
  forms_unreachable: string[];
  responses_seen: number;
  new: number;
  errors: { url: string; error: string }[];
};

const el = <T extends HTMLElement>(tag: string, cls?: string, text?: string): T => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node as T;
};

function when(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(then).toLocaleDateString();
}

/** The first field with real prose in it. A form's own title says which app, not what happened. */
function subjectOf(message: Message): string {
  const answered = message.fields.filter((f) => f.answer.trim());
  const longest = answered.reduce<Field | null>(
    (best, f) => (!best || f.answer.length > best.answer.length ? f : best),
    null,
  );
  return (longest?.answer || message.lead || "(empty response)").replace(/\s+/g, " ").trim();
}

export function mountSupport(host: HTMLElement, events: SupportEvents): SupportHandle {
  let busy = false;
  let inbox: Inbox | null = null;
  let setup: Setup | null = null;
  let unreadOnly = false;
  let appFilter = "";
  const expanded = new Set<string>();
  /* What was unread when this visit began. Opening the screen is the read: the badge clears on
     the way in, and the log is marked in one call. The dots stay for the visit so the eye can
     still find what is new; they go the next time the screen opens. */
  const fresh = new Set<string>();

  const tally = el("span", "sup-tally");
  const stamp = el("span", "sup-stamp");

  const unreadToggle = el<HTMLButtonElement>("button", "sup-chip", "Unread only");
  unreadToggle.type = "button";
  unreadToggle.addEventListener("click", () => {
    unreadOnly = !unreadOnly;
    unreadToggle.classList.toggle("is-on", unreadOnly);
    void load();
  });

  const apps = el<HTMLSelectElement>("select", "sup-apps");
  apps.addEventListener("change", () => {
    appFilter = apps.value;
    void load();
  });

  const markAll = el<HTMLButtonElement>("button", "sup-chip", "Mark all read");
  markAll.type = "button";
  markAll.addEventListener("click", () => void mark({ all: true }));

  const fetchNow = el<HTMLButtonElement>("button", "sup-fetch", "Fetch");
  fetchNow.type = "button";
  fetchNow.title = "Pull every form's responses from Google";
  fetchNow.addEventListener("click", () => void pull());

  // Every other inbox screen names itself; without this the toolbar was a row of controls about
  // nothing in particular.
  const title = el("b", "sup-title", "Support");
  const bar = el("div", "sup-bar");
  bar.append(title, tally, stamp, apps, unreadToggle, markAll, fetchNow);

  const notice = el("div", "sup-notice");
  notice.hidden = true;
  const list = el("div", "sup-list");
  host.replaceChildren(bar, notice, list);

  /* ---------------------------------------------------------------- rendering */

  function row(message: Message): HTMLElement {
    const item = el("article", `sup-row${message.read && !fresh.has(message.id) ? "" : " is-unread"}`);
    const open = expanded.has(message.id);

    const head = el<HTMLButtonElement>("button", "sup-head");
    head.type = "button";
    head.setAttribute("aria-expanded", String(open));
    head.addEventListener("click", () => {
      if (expanded.has(message.id)) expanded.delete(message.id);
      else {
        expanded.add(message.id);
        fresh.delete(message.id);
        if (!message.read) void mark({ ids: [message.id] });
      }
      paint();
    });

    const dot = el("span", "sup-dot");
    dot.title = message.read && !fresh.has(message.id) ? "read" : "new since last visit";

    const meta = el("div", "sup-meta");
    const who = el("div", "sup-who");
    for (const app of message.apps.length ? message.apps : ["unfiled"]) {
      who.append(el("span", "sup-app", app));
    }
    if (message.email) who.append(el("span", "sup-email", message.email));
    meta.append(who, el("div", "sup-subject", subjectOf(message)));

    const stampCell = el("div", "sup-when", when(message.submitted_at));
    stampCell.title = message.submitted_at;

    head.append(dot, meta, stampCell);
    item.append(head);

    if (open) {
      const body = el("div", "sup-body");
      const answered = message.fields.filter((f) => f.answer.trim());
      if (!answered.length) body.append(el("div", "sup-muted", "The response carried no answers."));
      for (const field of answered) {
        const pair = el("div", "sup-field");
        pair.append(el("div", "sup-q", field.question), el("div", "sup-a", field.answer));
        body.append(pair);
      }
      const foot = el("div", "sup-rowfoot");
      foot.append(el("span", "sup-muted", message.form_title));
      if (message.email) {
        const reply = el<HTMLAnchorElement>("a", "sup-reply", "Reply by email");
        reply.href = `mailto:${message.email}?subject=${encodeURIComponent(
          `Re: your message about ${message.apps[0] ?? "the app"}`,
        )}`;
        foot.append(reply);
      }
      body.append(foot);
      item.append(body);
    }
    return item;
  }

  /** Nothing readable yet. This screen's whole job at that point is to say what is missing. */
  function setupNotice(state: Setup): HTMLElement {
    const box = el("div", "sup-setup");
    const steps = el("ol", "sup-steps");
    const step = (text: string) => steps.append(el("li", undefined, text));

    if (state.stage === "no_key") {
      box.append(el("div", "sup-setup-head", "No Google identity yet."));
      step("Ask an agent to run the support module's autodiscover. It registers a key already in the repos.");
      step(`Or drop a service-account JSON as *.sa.json into ${state.secrets_dir}`);
    } else {
      box.append(
        el(
          "div",
          "sup-setup-head",
          state.stage === "no_access"
            ? `${state.forms_total} support forms found. None of them is shared with Panel yet.`
            : `${state.forms_readable} of ${state.forms_total} support forms are readable.`,
        ),
      );
      step(`Share each form below with ${state.grant_email} as an Editor. Viewer cannot read responses.`);
      step("Enable the Drive API and the Forms API in that identity's Google Cloud project.");
      step("Then press Fetch.");
    }
    box.append(steps);

    if (state.gaps.length) {
      const gaps = el("div", "sup-gaps");
      for (const gap of state.gaps.slice(0, 12)) {
        const line = el("div", "sup-gap");
        line.append(el("span", "sup-app", gap.apps[0] ?? "?"));
        const link = el<HTMLAnchorElement>("a", "sup-gap-url", gap.url);
        link.href = gap.url;
        link.target = "_blank";
        link.rel = "noreferrer";
        line.append(link, el("span", "sup-muted", gap.reason));
        gaps.append(line);
      }
      box.append(gaps);
    }
    return box;
  }

  function paint(): void {
    if (setup && setup.stage !== "ready" && !(inbox?.total ?? 0)) {
      notice.hidden = false;
      notice.replaceChildren(setupNotice(setup));
    } else if (setup && setup.stage === "partial") {
      notice.hidden = false;
      notice.replaceChildren(
        el(
          "div",
          "sup-thin",
          `${setup.forms_total - setup.forms_readable} of ${setup.forms_total} forms are still not shared with ${setup.grant_email}.`,
        ),
      );
    } else {
      notice.hidden = true;
      notice.replaceChildren();
    }

    if (!inbox) {
      list.replaceChildren(el("div", "sup-muted", "Reading the log…"));
      return;
    }

    tally.textContent = inbox.unread
      ? `${inbox.unread} unread · ${inbox.total} total`
      : `${inbox.total} messages`;
    tally.classList.toggle("sup-hot", inbox.unread > 0);
    markAll.hidden = inbox.unread === 0;

    if (!inbox.messages.length) {
      list.replaceChildren(
        el(
          "div",
          "sup-empty",
          unreadOnly || appFilter
            ? "Nothing matches that filter."
            : "No support messages stored yet. Press Fetch.",
        ),
      );
      return;
    }
    list.replaceChildren(...inbox.messages.map(row));
  }

  /* ------------------------------------------------------------------- calls */

  function paintApps(messages: Message[]): void {
    const names = new Set<string>();
    for (const message of messages) for (const app of message.apps) names.add(app);
    const wanted = ["", ...[...names].sort()];
    if (wanted.length === apps.options.length) return;
    apps.replaceChildren(
      ...wanted.map((name) => {
        const option = el<HTMLOptionElement>("option", undefined, name || "All apps");
        option.value = name;
        return option;
      }),
    );
    apps.value = appFilter;
  }

  async function load(): Promise<void> {
    const query = new URLSearchParams();
    if (unreadOnly) query.set("unread", "1");
    if (appFilter) query.set("app", appFilter);
    query.set("limit", "300");
    try {
      inbox = await moduleGet<Inbox>(`${M}/inbox?${query.toString()}`);
      // The filtered call cannot name the apps it filtered out, so the picker is built from the
      // unfiltered read. Cheap: the log is a local file.
      if (unreadOnly || appFilter) {
        paintApps((await moduleGet<Inbox>(`${M}/inbox?limit=1000`)).messages);
      } else {
        paintApps(inbox.messages);
      }
      events.onUnread(inbox.unread);
    } catch (error) {
      list.replaceChildren(el("div", "sup-error", errorText(error, "The support inbox could not be read. Try Fetch again.")));
      return;
    }
    paint();
  }

  async function loadSetup(): Promise<void> {
    try {
      setup = await moduleGet<Setup>(`${M}/setup`);
    } catch {
      setup = null;
    }
    paint();
  }

  async function mark(body: { ids?: string[]; all?: boolean }): Promise<void> {
    try {
      await modulePost(`${M}/read`, body);
    } catch {
      // A failed mark is cosmetic. The message is still there; do not lose the screen over it.
    }
    await load();
  }

  async function pull(): Promise<void> {
    if (busy) return;
    busy = true;
    fetchNow.disabled = true;
    fetchNow.textContent = "Fetching…";
    try {
      const report = await modulePost<FetchReport>(`${M}/fetch`, {});
      stamp.textContent = report.new
        ? `${report.new} new · ${when(report.fetched_at)}`
        : `nothing new · ${when(report.fetched_at)}`;
    } catch (error) {
      stamp.textContent = "";
      notice.hidden = false;
      notice.replaceChildren(el("div", "sup-error", String(error)));
    } finally {
      busy = false;
      fetchNow.disabled = false;
      fetchNow.textContent = "Fetch";
    }
    await loadSetup();
    await load();
  }

  /** One look is the read. Everything unread on the way in is marked, the badge goes to zero,
   *  and the rows keep their dot until the visit ends. */
  async function settle(): Promise<void> {
    await load();
    if (!inbox?.unread) return;
    fresh.clear();
    for (const message of inbox.messages) if (!message.read) fresh.add(message.id);
    try {
      await modulePost(`${M}/read`, { all: true });
    } catch {
      return; // the badge stays true to the log
    }
    inbox.unread = 0;
    for (const message of inbox.messages) message.read = true;
    events.onUnread(0);
    paint();
  }

  return {
    open() {
      void loadSetup();
      void settle();
    },
    clear() {
      expanded.clear();
      fresh.clear();
    },
    unread() {
      return inbox?.unread ?? 0;
    },
  };
}
