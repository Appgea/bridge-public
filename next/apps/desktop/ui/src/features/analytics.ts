/** Analytics — Firebase/GA4 health, per app, inside Panel.
 *
 * The tab is APP-SCOPED and app-scoped ONLY: it follows the selected project and shows that one
 * app through a set of insight presets. The portfolio-wide Kill/Keep board is NOT here — it lives
 * on the Home screen, the single place that speaks about every project at once. Credentials and
 * network calls stay in the one-shot Python module; this surface only ever receives aggregated
 * numbers for the one selected app.
 */

import { moduleGet, modulePost } from "./modules";
import "./analytics.css";

const M = "/m/analytics";
const q = (value: string): string => encodeURIComponent(value);
const WINDOWS = [7, 28, 90] as const;
const num = new Intl.NumberFormat();
const CLIENT_CACHE_KEY = "panel.analytics.app.v2";
const CLIENT_CACHE_MAX_MS = 7 * 24 * 60 * 60 * 1000;

/* ----------------------------------------------------------------- types */

type Tone = "ok" | "warn" | "risk" | "info" | "muted";
type State = { id: string; label: string; action: string; tone: Tone };
type Signal = { value: number | null; grade: "good" | "ok" | "poor" | "unknown" };
type Point = { date: string; active_users: number; new_users: number };

type Preset = {
  id: string;
  title: string;
  tone: Tone;
  verdict: string;
  [key: string]: unknown;
};

/** What an app promised to emit, per role — the vocabulary every lens below reads through. */
type EventContract = {
  app: string;
  declared: boolean;
  category: string;
  activation: string[];
  core_loop: string[];
  monetization: string[];
  retention: string[];
};

type RoleAudit = {
  declared: string[];
  present: string[];
  missing: string[];
  /** Each absent event with WHY: no call site in the code, vs a call site nobody reached. */
  gaps: Array<{ event: string; cause: "not_coded" | "never_reached" | "unknown"; at: string | null }>;
  coded: string[] | null;
  users: number;
  count: number;
  coverage: number | null;
  instrumented: boolean;
};

/** Three-way diff: what the Dart can emit × what a role claims × what GA4 actually saw. */
type Coverage = {
  scanned: boolean;
  coded_total: number;
  triggered: number;
  trigger_rate: number | null;
  live: string[];
  never_fired: Array<{ event: string; at: string | null }>;
  phantom: string[];
  unmapped: Array<{ event: string; at: string | null; users: number; fired: boolean }>;
  files_read: number;
};

type AppBundle = {
  app: string;
  property_id: string | null;
  linked?: boolean;
  score: number | null;
  state: State;
  confident: boolean;
  trend_wow: number | null;
  new_window: number;
  signals: Record<string, Signal>;
  shrunk: Record<string, number | null>;
  wilson_d1: number;
  missing_signals: string[];
  contract: EventContract;
  event_audit: {
    contract: { app: string; category: string; declared: boolean };
    roles: Record<string, RoleAudit>;
    coverage: Coverage;
    undeclared: Array<{ event: string; count: number; users: number }>;
    undeclared_total: number;
    has_ad_signal: boolean;
    has_iap_signal: boolean;
    money_events: string[];
    present_canonical: string[];
    missing_canonical: string[];
  };
  totals: Record<string, number>;
  retention: Record<string, number>;
  series: Point[];
  events: Array<{ event: string; count: number; users: number }>;
  data_through: string;
  generated_at?: number;
  _cache?: { hit: boolean; stored_at: number; age_seconds: number; ttl_seconds: number };
  presets: Record<string, Preset>;
};

type ClientCacheEntry = { savedAt: number; data: AppBundle };
type ClientCache = Record<string, ClientCacheEntry>;

type Setup = {
  has_credential: boolean;
  accounts: Array<{ email: string; source: string }>;
  local_apps: number;
  linked_apps: number;
  unlinked_apps: string[];
  grant_email: string | null;
  stage: "no_key" | "no_access" | "partial" | "ready";
};

export type AnalyticsHandle = {
  setProject(projectId: string, path: string): void;
  refresh(): void;
};

/* ----------------------------------------------------------- formatting */

function count(value: unknown): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? num.format(Math.round(parsed)) : "—";
}
function percent(value: unknown, digits = 0): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${(parsed * 100).toFixed(digits)}%` : "—";
}
function duration(seconds: unknown): string {
  const parsed = Number(seconds);
  if (!Number.isFinite(parsed) || parsed <= 0) return "—";
  const mins = Math.floor(parsed / 60);
  return mins ? `${mins}m ${Math.round(parsed % 60)}s` : `${Math.round(parsed)}s`;
}
function trendLabel(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (Math.abs(value) < 0.02) return "flat";
  return `${value > 0 ? "↑" : "↓"} ${percent(Math.abs(value))}`;
}
function trendTone(value: number | null): string {
  if (value === null || !Number.isFinite(value) || Math.abs(value) < 0.02) return "flat";
  return value > 0 ? "up" : "down";
}

function activeStreak(series: Point[]): number {
  let streak = 0;
  for (let i = series.length - 1; i >= 0; i -= 1) {
    if ((series[i]?.active_users ?? 0) <= 0) break;
    streak += 1;
  }
  return streak;
}
function el(tag: string, className = ""): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function readClientCache(): ClientCache {
  try {
    const value = JSON.parse(localStorage.getItem(CLIENT_CACHE_KEY) ?? "{}");
    return value && typeof value === "object" ? value as ClientCache : {};
  } catch {
    return {};
  }
}

function completedDay(): string {
  const day = new Date();
  day.setDate(day.getDate() - 1);
  const year = day.getFullYear();
  const month = String(day.getMonth() + 1).padStart(2, "0");
  const date = String(day.getDate()).padStart(2, "0");
  return `${year}-${month}-${date}`;
}

function cachedBundle(path: string, days: number): ClientCacheEntry | null {
  const entry = readClientCache()[`${path}::${days}`];
  return entry
    && Date.now() - entry.savedAt < CLIENT_CACHE_MAX_MS
    && entry.data.data_through === completedDay()
    ? entry
    : null;
}

function rememberBundle(path: string, days: number, data: AppBundle): void {
  try {
    const cache = readClientCache();
    cache[`${path}::${days}`] = { savedAt: Date.now(), data };
    const recent = Object.entries(cache)
      .sort((a, b) => b[1].savedAt - a[1].savedAt)
      .slice(0, 18);
    localStorage.setItem(CLIENT_CACHE_KEY, JSON.stringify(Object.fromEntries(recent)));
  } catch {
    // A full/disabled localStorage must never make Analytics unusable.
  }
}

function ageLabel(epochSeconds: number): string {
  const seconds = Math.max(0, Math.round(Date.now() / 1000 - epochSeconds));
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

/** DAU sparkline — pure SVG, no library, no external fetch. */
function sparkline(series: Point[], key: "active_users" | "new_users" = "active_users"): string {
  const points = series.filter((p) => Number.isFinite(p[key]));
  if (points.length < 2) return `<div class="an-spark-empty">not enough days</div>`;
  const values = points.map((p) => p[key]);
  const top = Math.max(...values), floor = Math.min(...values), span = top - floor || 1;
  const w = 100, h = 28;
  const coords = points.map((p, i) => {
    const x = (i / (points.length - 1)) * w;
    const y = h - ((p[key] - floor) / span) * h;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  return `<svg class="an-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <polygon points="0,${h} ${coords.join(" ")} ${w},${h}"></polygon>
    <polyline points="${coords.join(" ")}"></polyline></svg>`;
}

/** Larger dual-series chart: activity tells scale; new users tell whether growth is feeding it. */
function activityChart(series: Point[]): string {
  const points = series.filter((p) => Number.isFinite(p.active_users) && Number.isFinite(p.new_users));
  if (points.length < 2) return `<div class="an-chart-empty">Not enough daily data yet.</div>`;
  const top = Math.max(1, ...points.flatMap((p) => [p.active_users, p.new_users]));
  const w = 720, h = 128, pad = 5;
  const coords = (key: "active_users" | "new_users"): string => points.map((p, i) => {
    const x = pad + (i / (points.length - 1)) * (w - pad * 2);
    const y = h - pad - (p[key] / top) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const peak = Math.max(...points.map((p) => p.active_users));
  const latest = points.at(-1)?.active_users ?? 0;
  return `
    <div class="an-chart-head">
      <div><b>Daily momentum</b><small>${points.length} days · peak ${count(peak)} active</small></div>
      <div class="an-chart-legend"><span class="is-active">active</span><span class="is-new">new</span></div>
    </div>
    <svg class="an-chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Daily active and new users">
      <defs><linearGradient id="an-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-opacity=".28"/><stop offset="1" stop-opacity="0"/></linearGradient></defs>
      <polygon class="an-chart-area" points="${pad},${h} ${coords("active_users")} ${w - pad},${h}"></polygon>
      <polyline class="an-chart-active" points="${coords("active_users")}"></polyline>
      <polyline class="an-chart-new" points="${coords("new_users")}"></polyline>
    </svg>
    <div class="an-chart-foot"><span>oldest</span><b>${count(latest)} active yesterday</b><span>yesterday</span></div>`;
}

/* ============================================================ dashboard card
 * Deliberately dumb: state badge + one number + 14-day sparkline. All depth lives in the tab.
 */
export async function paintAnalyticsCard(path: string, host: HTMLElement): Promise<void> {
  host.innerHTML = `<div class="an-card-loading">reading analytics…</div>`;
  let data: AppBundle;
  try {
    data = await moduleGet<AppBundle>(`${M}/widget?root=${q(path)}`);
  } catch (error) {
    host.innerHTML = `<div class="an-card-empty"><small></small></div>`;
    host.querySelector("small")!.textContent = String(error);
    return;
  }
  if (data.linked === false || !data.property_id) {
    host.innerHTML = `<div class="an-card-empty"><small>Not linked to a GA4 property yet.</small></div>`;
    return;
  }
  const dau = count(data.totals?.active_users);
  const s = data.state ?? { label: "—", tone: "muted" as Tone };
  host.innerHTML = `
    <div class="an-card">
      <div class="an-card-top">
        <span class="an-badge is-${s.tone}">${s.label}</span>
        <span class="an-card-trend is-${trendTone(data.trend_wow)}">${trendLabel(data.trend_wow)}</span>
      </div>
      <div class="an-card-kpi"><strong>${dau}</strong><span>active users · ${data.totals?.active_users ? "28d" : "no data"}</span></div>
      <div class="an-card-spark">${sparkline((data.series ?? []).slice(-14))}</div>
    </div>`;
}

/* ==================================================================== tab */

export function mountAnalytics(root: HTMLElement): AnalyticsHandle {
  let days: number = 28;
  let path = "";
  let bundle: AppBundle | null = null;
  let setup: Setup | null = null;
  let preset = "retention_wall";
  let loading = false;
  let discovering = false;
  let clientSavedAt: number | null = null;
  let guideOpen = true;

  const PRESETS: Array<{ id: string; label: string }> = [
    { id: "retention_wall", label: "Do users return?" },
    { id: "first_session", label: "Where do users stop?" },
    { id: "ad_monetization", label: "Revenue signals" },
    { id: "acquisition", label: "Where users came from" },
    { id: "instrumentation", label: "Is tracking working?" },
  ];

  const PRESET_HELP: Record<string, string> = {
    retention_wall: "Of the people who first used the app in the measured cohort, this shows how many returned 1, 7, and 30 days later. The “floor” is a comparison point for casual apps—not a universal target.",
    first_session: "This compares how many unique people fired each milestone event. It suggests where people stop, but it does not prove that the same people completed the events in this exact order.",
    ad_monetization: "These are tracked ad and purchase events, not revenue. Use them to see whether monetization moments are happening; use RevenueCat or ad-network reporting for money.",
    acquisition: "This groups first-time users by the channel GA4 credits for bringing them in. “Organic” means GA4 did not classify the channel as paid.",
    instrumentation: "This compares analytics events found in the app’s source code with events seen by GA4. A coded event that stays silent may be unused, unreachable, or broken.",
  };

  function shell(): HTMLElement {
    root.innerHTML = `
      <header class="an-head">
        <div class="an-head-copy"><small>ANALYTICS</small><h2 class="an-title">Analytics</h2></div>
        <div class="an-head-tools">
          <span class="an-freshness" hidden></span>
          <div class="an-window" role="tablist"></div>
          <button class="an-refresh" type="button" title="Refresh this app from GA4">↻</button>
        </div>
      </header>
      <div class="an-body"></div>`;
    const windows = root.querySelector<HTMLElement>(".an-window")!;
    for (const option of WINDOWS) {
      const b = el("button", `an-window-opt${option === days ? " is-active" : ""}`) as HTMLButtonElement;
      b.type = "button";
      b.textContent = `${option}d`;
      b.addEventListener("click", () => { if (days !== option) { days = option; void load(); } });
      windows.append(b);
    }
    root.querySelector<HTMLButtonElement>(".an-refresh")!.addEventListener("click", () => void load(true));
    const freshness = root.querySelector<HTMLElement>(".an-freshness")!;
    if (bundle) {
      const storedAt = clientSavedAt ? Math.round(clientSavedAt / 1000) : bundle._cache?.stored_at;
      freshness.hidden = false;
      freshness.textContent = storedAt ? `● cached ${ageLabel(storedAt)}` : "● ready";
      freshness.title = `Completed through ${bundle.data_through}. It refreshes when a new day completes.`;
    }
    return root.querySelector<HTMLElement>(".an-body")!;
  }

  function note(host: HTMLElement, title: string, detail: string, tone: Tone = "muted"): void {
    const card = el("div", `an-note is-${tone}`);
    card.innerHTML = `<b></b><small></small>`;
    card.querySelector("b")!.textContent = title;
    card.querySelector("small")!.textContent = detail;
    host.append(card);
  }

  function copyRow(host: HTMLElement, value: string): void {
    const row = el("div", "an-copy");
    row.innerHTML = `<code></code><button type="button">copy</button>`;
    row.querySelector("code")!.textContent = value;
    const btn = row.querySelector("button")!;
    btn.addEventListener("click", () => {
      void navigator.clipboard.writeText(value).then(() => { btn.textContent = "copied"; setTimeout(() => (btn.textContent = "copy"), 1200); });
    });
    host.append(row);
  }

  /* ---------------------------------------------------------- setup panel */

  function paintSetup(body: HTMLElement): void {
    const s = setup!;
    const wrap = el("div", "an-setup");
    const stageLabel: Record<string, string> = {
      no_key: "No credential found", no_access: "Credential has no property access",
      partial: "Some apps linked", ready: "All apps linked",
    };
    wrap.innerHTML = `
      <div class="an-setup-copy">
        <small>SETUP</small>
        <h3>${stageLabel[s.stage]}</h3>
        <p>Firebase Analytics has no API-key surface. Analytics reads through a Google service-account
        key with the <code>analytics.readonly</code> scope. Panel will find any key already on this
        machine and mount the ones GA4 accepts.</p>
      </div>
      <div class="an-steps"></div>
      <div class="an-setup-actions">
        <button class="an-primary" type="button">${discovering ? "Searching…" : "Find my analytics"}</button>
        <button class="an-ghost" type="button">Paste a key</button>
      </div>
      <div class="an-setup-extra"></div>`;

    // state machine, each stage its own tick
    const steps = wrap.querySelector<HTMLElement>(".an-steps")!;
    const stageOrder = ["no_key", "no_access", "partial", "ready"];
    const reached = stageOrder.indexOf(s.stage);
    const rows: Array<[string, string]> = [
      ["Key found", s.has_credential ? "done" : "todo"],
      ["Access verified", s.linked_apps > 0 ? "done" : reached >= 1 ? "active" : "todo"],
      ["Apps matched", s.unlinked_apps.length === 0 && s.linked_apps > 0 ? "done" : s.linked_apps > 0 ? "active" : "todo"],
      ["Events flowing", s.stage === "ready" ? "done" : "todo"],
    ];
    for (const [label, st] of rows) {
      const r = el("div", `an-step-row is-${st}`);
      r.innerHTML = `<i></i><span></span>`;
      r.querySelector("span")!.textContent = label;
      steps.append(r);
    }

    const primary = wrap.querySelector<HTMLButtonElement>(".an-primary")!;
    primary.disabled = discovering;
    primary.addEventListener("click", () => void discover());
    wrap.querySelector<HTMLButtonElement>(".an-ghost")!.addEventListener("click", () => paintPasteForm(extra));

    const extra = wrap.querySelector<HTMLElement>(".an-setup-extra")!;
    if (s.grant_email && (s.stage === "no_access" || s.stage === "partial")) {
      note(extra, "One manual step: grant Viewer in GA4",
        "Add this service account as a Viewer at the Account level in Google Analytics (Admin → Account access management). Account-level covers every property at once. Repeat per Analytics account.", "warn");
      copyRow(extra, s.grant_email);
      if (s.unlinked_apps.length) {
        note(extra, `${s.unlinked_apps.length} apps still unlinked`, s.unlinked_apps.join(", "), "muted");
      }
    }
    body.append(wrap);
  }

  function paintPasteForm(host: HTMLElement): void {
    host.innerHTML = "";
    const form = el("form", "an-paste") as HTMLFormElement;
    form.innerHTML = `
      <label><span>Service-account JSON</span><textarea name="key" rows="5" spellcheck="false" placeholder='{ "type": "service_account", … }' required></textarea></label>
      <div class="an-paste-actions"><button type="submit">Connect</button><small></small></div>`;
    form.addEventListener("submit", (e) => { e.preventDefault(); void connect(form); });
    host.append(form);
  }

  async function connect(form: HTMLFormElement): Promise<void> {
    const status = form.querySelector<HTMLElement>(".an-paste-actions small")!;
    const raw = (form.elements.namedItem("key") as HTMLTextAreaElement).value.trim();
    status.textContent = "connecting…";
    try {
      const r = await modulePost<{ stored?: string; verified?: boolean; error?: string; hint?: string }>(`${M}/connect`, { service_account: raw });
      if (r.error && !r.stored) throw new Error(r.error);
      if (!r.verified) { status.textContent = `${r.error ?? "stored, not verified"} — ${r.hint ?? ""}`; return; }
      await load(true);
    } catch (error) { status.textContent = String(error); }
  }

  async function discover(): Promise<void> {
    discovering = true;
    render();
    try {
      await modulePost(`${M}/autodiscover`, {});
    } catch { /* surfaced on reload */ }
    discovering = false;
    await load(true);
  }

  /* ------------------------------------------------------------- app view */

  function stateBanner(host: HTMLElement, data: AppBundle): void {
    const s = data.state;
    const score = Math.max(0, Math.min(100, data.score ?? 0));
    const streak = activeStreak(data.series ?? []);
    const banner = el("div", `an-state is-${s.tone}`);
    banner.innerHTML = `
      <div class="an-state-left">
        <small class="an-state-kicker">CURRENT RUN · ${days} DAYS</small>
        <span class="an-state-label"></span>
        <span class="an-state-action"></span>
        <div class="an-run-meta">
          <span class="an-run-chip"><i></i>${streak ? `${streak}-day active streak` : "no active streak"}</span>
          <span class="an-run-chip">${count(data.totals?.active_users)} people reached</span>
        </div>
      </div>
      <div class="an-state-right">
        <span class="an-state-score" style="--score:${score}">
          <span><b></b><i>health</i></span>
        </span>
        <small>${data.confident ? "signal locked" : "small sample"}</small>
      </div>`;
    banner.querySelector(".an-state-label")!.textContent = s.label;
    banner.querySelector(".an-state-action")!.textContent = s.action;
    banner.querySelector(".an-state-score b")!.textContent = data.score === null ? "—" : String(data.score);
    host.append(banner);
  }

  function readingGuide(host: HTMLElement, data: AppBundle): void {
    const guide = el("details", "an-guide") as HTMLDetailsElement;
    guide.open = guideOpen;
    guide.innerHTML = `
      <summary>
        <span><b>How to read this screen</b><small>Four things before acting on these numbers</small></span>
        <i aria-hidden="true">⌄</i>
      </summary>
      <div class="an-guide-grid">
        <div><b>Verdict</b><p>A rule-based diagnosis, not a fact. The sentence beside it is the recommended next move.</p></div>
        <div><b>Health estimate</b><p>A 0–100 blend of return rate, session length, and engagement. Compare direction; do not treat it as revenue.</p></div>
        <div><b>Selected window</b><p>Activity uses the selected ${days} days. Return rates use an older cohort because users need time to reach Day 30.</p></div>
        <div><b>Data freshness</b><p>GA4 is complete through ${data.data_through}. Panel reuses that finished snapshot until another day completes.</p></div>
      </div>`;
    guide.addEventListener("toggle", () => { guideOpen = guide.open; });
    host.append(guide);
  }

  function statRow(host: HTMLElement, data: AppBundle): void {
    const t = data.totals ?? {};
    const row = el("div", "an-stats");
    const stats: Array<[string, string, string, string]> = [
      [count(t.active_users), "active users", trendLabel(data.trend_wow), "Distinct people who used the app during this window."],
      [count(t.new_users), "first-time users", "", "People whose first recorded use happened during this window."],
      [duration(t.session_seconds), "average session", "", "Average time between opening and leaving or becoming inactive."],
      [percent(t.engagement_rate), "engaged sessions", "", "The share of sessions GA4 considers meaningfully active."],
      [count(t.sessions), "total sessions", "", "App-use periods. One person can create several sessions."],
    ];
    for (const [v, label, sub, help] of stats) {
      const cell = el("div", "an-stat");
      cell.title = help;
      cell.innerHTML = `<b></b><span></span><i></i>`;
      cell.querySelector("b")!.textContent = v;
      cell.querySelector("span")!.textContent = label;
      cell.querySelector("i")!.textContent = sub;
      row.append(cell);
    }
    host.append(row);
  }

  function actionDeck(host: HTMLElement, data: AppBundle): void {
    const actions: Array<{ tag: string; title: string; detail: string; tone: Tone }> = [{
      tag: "NEXT MOVE",
      title: data.state.action,
      detail: `Panel reads this app as “${data.state.label}” across the selected ${days}-day window.`,
      tone: data.state.tone,
    }];
    const coverage = data.event_audit?.coverage;
    if (coverage?.unmapped.length) {
      actions.push({
        tag: "MEASUREMENT",
        title: `Map ${coverage.unmapped.length} unclaimed event${coverage.unmapped.length === 1 ? "" : "s"}`,
        detail: "They exist in the app, but no analytics lens uses them yet.",
        tone: "warn",
      });
    } else if (coverage?.trigger_rate !== null && coverage?.trigger_rate < 0.6) {
      actions.push({
        tag: "INSTRUMENTATION",
        title: "Find the coded events users never reach",
        detail: `${percent(coverage.trigger_rate)} of analytics events in the code have fired.`,
        tone: "risk",
      });
    }
    if (data.trend_wow !== null && data.trend_wow <= -0.1) {
      actions.push({
        tag: "MOMENTUM",
        title: "Investigate the week-over-week drop",
        detail: `Active users are down ${percent(Math.abs(data.trend_wow))}; check acquisition and release timing.`,
        tone: "risk",
      });
    } else if (!data.event_audit?.has_ad_signal && !data.event_audit?.has_iap_signal) {
      actions.push({
        tag: "REVENUE SIGNAL",
        title: "Monetization is currently invisible",
        detail: "No ad or purchase event appears in this window. Confirm whether that is intentional.",
        tone: "muted",
      });
    }

    const wrap = el("section", "an-actions");
    const heading = el("div", "an-section-title");
    heading.innerHTML = `<div><small>MISSIONS</small><b>Your next best moves</b></div><span>${actions.length} in this run</span>`;
    wrap.append(heading);
    const grid = el("div", "an-action-grid");
    for (const [index, action] of actions.slice(0, 3).entries()) {
      const card = el("article", `an-action is-${action.tone}`);
      card.innerHTML = `<div class="an-action-top"><span></span><small></small></div><b></b><p></p>`;
      card.querySelector(".an-action-top span")!.textContent = String(index + 1).padStart(2, "0");
      card.querySelector("small")!.textContent = action.tag;
      card.querySelector("b")!.textContent = action.title;
      card.querySelector("p")!.textContent = action.detail;
      grid.append(card);
    }
    wrap.append(grid);
    host.append(wrap);
  }

  function presetTabs(host: HTMLElement): void {
    const bar = el("div", "an-presets");
    for (const p of PRESETS) {
      const b = el("button", `an-preset-tab${p.id === preset ? " is-active" : ""}`) as HTMLButtonElement;
      b.type = "button";
      b.textContent = p.label;
      b.addEventListener("click", () => { preset = p.id; render(); });
      bar.append(b);
    }
    host.append(bar);
  }

  function paintPreset(host: HTMLElement, data: AppBundle): void {
    const p = data.presets?.[preset];
    if (!p) { note(host, "No data for this lens", "Try another preset.", "muted"); return; }
    const box = el("section", `an-lens is-${p.tone}`);
    box.innerHTML = `<div class="an-lens-verdict"><b></b><small class="an-lens-help"></small><p></p></div><div class="an-lens-body"></div>`;
    box.querySelector("b")!.textContent = p.title;
    box.querySelector(".an-lens-help")!.textContent = PRESET_HELP[preset] ?? "";
    box.querySelector("p")!.textContent = p.verdict;
    const b = box.querySelector<HTMLElement>(".an-lens-body")!;
    if (preset === "retention_wall") paintRetention(b, p, data);
    else if (preset === "first_session") paintFunnel(b, p);
    else if (preset === "ad_monetization") paintMonetization(b, p);
    else if (preset === "acquisition") paintAcquisition(b, p);
    else if (preset === "instrumentation") paintInstrumentation(b, p);
    host.append(box);
  }

  const ROLE_COPY: Record<string, string> = {
    activation: "the first-session path a new user must finish",
    core_loop: "the repeatable value moment, fired every session",
    ad_moment: "the terminal beat of the loop — the natural ad break",
    monetization: "ads, rewarded moments, purchases",
    retention: "habit hooks that pull a user back",
  };

  const CAUSE_COPY: Record<string, string> = {
    not_coded: "no call site in the code — never written",
    never_reached: "call site exists, nobody ever triggered it",
    unknown: "source not scanned",
  };

  /** The contract as a lens: what each role promised, what actually fires, what drifted. */
  function paintInstrumentation(host: HTMLElement, p: Preset): void {
    const cov = p.coverage as Coverage | undefined;
    if (cov?.scanned) {
      const cells: Array<[string, string]> = [
        [String(cov.coded_total), "events in the code"],
        [String(cov.triggered), "actually triggered"],
        [cov.trigger_rate === null ? "—" : percent(cov.trigger_rate), "trigger rate"],
        [String(cov.unmapped.length), "coded, no role"],
      ];
      const grid = el("div", "an-mini-grid");
      for (const [v, label] of cells) {
        const c = el("div", "an-mini");
        c.innerHTML = `<b></b><span></span>`;
        c.querySelector("b")!.textContent = v;
        c.querySelector("span")!.textContent = label;
        grid.append(c);
      }
      host.append(grid);
      const read = el("small", "an-lens-note");
      read.textContent = `read from ${cov.files_read} Dart files`;
      host.append(read);
    }

    const roles = (p.roles as Record<string, RoleAudit>) ?? {};
    const list = el("div", "an-roles");
    for (const [name, r] of Object.entries(roles)) {
      const tone = !r.instrumented ? "muted" : r.present.length === 0 ? "risk"
        : (r.coverage ?? 0) >= 1 ? "ok" : "warn";
      const row = el("div", `an-role is-${tone}`);
      row.innerHTML = `
        <div class="an-role-head">
          <b></b><span class="an-role-count"></span>
        </div>
        <small class="an-role-why"></small>
        <div class="an-role-bar"><i></i></div>
        <div class="an-chips"></div>`;
      row.querySelector("b")!.textContent = name.replace(/_/g, " ");
      row.querySelector(".an-role-count")!.textContent = r.instrumented
        ? `${r.present.length}/${r.declared.length} firing`
        : "not instrumented";
      row.querySelector(".an-role-why")!.textContent = ROLE_COPY[name] ?? "";
      (row.querySelector(".an-role-bar i") as HTMLElement).style.width =
        `${Math.round((r.coverage ?? 0) * 100)}%`;
      const chips = row.querySelector<HTMLElement>(".an-chips")!;
      for (const e of r.present) { const c = el("span", "an-chip is-on"); c.textContent = e; chips.append(c); }
      // A gap reads differently depending on cause: never written vs written and never reached.
      for (const g of r.gaps ?? r.missing.map((e) => ({ event: e, cause: "unknown" as const, at: null }))) {
        const c = el("span", `an-chip is-off is-${g.cause}`);
        c.textContent = g.cause === "not_coded" ? `${g.event} · not coded` : g.event;
        c.title = g.at ? `${CAUSE_COPY[g.cause]} — ${g.at}` : CAUSE_COPY[g.cause];
        chips.append(c);
      }
      if (!r.declared.length) { const c = el("span", "an-chip is-none"); c.textContent = "nothing declared"; chips.append(c); }
      list.append(row);
    }
    host.append(list);

    // Coded but no role claims it — the actionable "add these to the contract" list.
    if (cov?.unmapped.length) {
      const box = el("div", "an-drift");
      const head = el("small", "an-lens-note");
      head.textContent = `${cov.unmapped.length} event(s) exist in the code but belong to no role — no lens reads them:`;
      box.append(head);
      const chips = el("div", "an-chips");
      for (const u of cov.unmapped.slice(0, 20)) {
        const c = el("span", `an-chip ${u.fired ? "is-drift" : "is-none"}`);
        c.textContent = u.fired ? `${u.event} · ${count(u.users)} users` : `${u.event} · silent`;
        if (u.at) c.title = u.at;
        chips.append(c);
      }
      box.append(chips);
      host.append(box);
    }

    // Fires in GA4 with no call site here: an SDK/plugin event, or the shipped build is behind.
    if (cov?.phantom.length) {
      const box = el("div", "an-drift");
      const head = el("small", "an-lens-note");
      head.textContent = "fires in GA4 with no call site in this repo (SDK/plugin, or the live build is older than the code):";
      box.append(head);
      const chips = el("div", "an-chips");
      for (const e of cov.phantom.slice(0, 16)) { const c = el("span", "an-chip is-drift"); c.textContent = e; chips.append(c); }
      box.append(chips);
      host.append(box);
    }

    const drift = (p.undeclared as Array<{ event: string; count: number }>) ?? [];
    if (drift.length) {
      const box = el("div", "an-drift");
      const head = el("small", "an-lens-note");
      head.textContent = `${p.undeclared_total} event(s) fire that no role claims — nothing reads them:`;
      box.append(head);
      const chips = el("div", "an-chips");
      for (const d of drift) { const c = el("span", "an-chip is-drift"); c.textContent = `${d.event} · ${count(d.count)}`; chips.append(c); }
      box.append(chips);
      host.append(box);
    }
    if (!p.declared) {
      const s = el("small", "an-lens-note");
      s.textContent = `Category "${p.category}" is a guess. Add this app to APP_CONTRACTS in the analytics module to make every lens app-specific.`;
      host.append(s);
    }
  }

  function paintRetention(host: HTMLElement, p: Preset, data: AppBundle): void {
    const curve = (p.curve as Array<{ day: string; value: number | null; grade: string; band_ok: number; band_good: number }>) ?? [];
    const grid = el("div", "an-curve");
    for (const c of curve) {
      const cell = el("div", `an-curve-cell is-${c.grade}`);
      cell.innerHTML = `<b></b><span></span><i></i>`;
      cell.querySelector("b")!.textContent = c.value === null ? "—" : percent(c.value);
      cell.querySelector("span")!.textContent = c.day;
      cell.querySelector("i")!.textContent = `floor ${percent(c.band_ok)}`;
      grid.append(cell);
    }
    host.append(grid);
    const meta = el("small", "an-lens-note");
    meta.textContent = `cohort of ${count(p.cohort_size)} acquired ${p.cohort_start ?? "—"} · data through ${data.data_through}`;
    host.append(meta);
  }

  function paintFunnel(host: HTMLElement, p: Preset): void {
    const steps = (p.steps as Array<{ event: string; users: number; present: boolean; from_previous: number | null }>) ?? [];
    if (!steps.length) { note(host, "Funnel unavailable", (p.missing as string[] | undefined)?.length ? `Missing events: ${(p.missing as string[]).join(", ")}` : "No first-session events.", "muted"); return; }
    const top = steps[0]?.users || 1;
    for (const step of steps) {
      const r = el("div", `an-step${step.present ? "" : " is-absent"}`);
      r.innerHTML = `<span class="an-step-name"></span><span class="an-step-bar"><i></i></span><span class="an-step-users"></span><span class="an-step-drop"></span>`;
      r.querySelector(".an-step-name")!.textContent = step.event;
      (r.querySelector(".an-step-bar i") as HTMLElement).style.width = `${Math.max(1, (step.users / top) * 100)}%`;
      r.querySelector(".an-step-users")!.textContent = step.present ? count(step.users) : "not fired";
      r.querySelector(".an-step-drop")!.textContent = step.from_previous === null ? "" : percent(step.from_previous);
      host.append(r);
    }
    const missing = p.missing as string[] | undefined;
    if (missing?.length) { const s = el("small", "an-lens-note"); s.textContent = `Instrument these for a full funnel: ${missing.join(", ")}`; host.append(s); }
  }

  function paintMonetization(host: HTMLElement, p: Preset): void {
    const cells: Array<[string, string]> = [
      [String(p.ad_moments_per_session ?? "—"), "core-loop moments / session"],
      [String(p.sessions_per_dau ?? "—"), "sessions / user"],
      [count(p.ad_impressions), "ad events"],
      [count(p.iap_events), "purchase events"],
    ];
    const grid = el("div", "an-mini-grid");
    for (const [v, label] of cells) {
      const c = el("div", "an-mini");
      c.innerHTML = `<b></b><span></span>`;
      c.querySelector("b")!.textContent = v;
      c.querySelector("span")!.textContent = label;
      grid.append(c);
    }
    host.append(grid);

    // Name the events the numbers came from — a proxy nobody can trace is a proxy nobody trusts.
    const triggers = (p.trigger_events as string[]) ?? [];
    const declared = (p.declared_monetization as string[]) ?? [];
    const money = (p.money_events as string[]) ?? [];
    const chips = el("div", "an-chips");
    for (const e of triggers) { const c = el("span", "an-chip is-on"); c.textContent = e; chips.append(c); }
    for (const e of money) { const c = el("span", "an-chip is-money"); c.textContent = e; chips.append(c); }
    for (const e of declared.filter((d) => !money.includes(d))) {
      const c = el("span", "an-chip is-off"); c.textContent = e; chips.append(c);
    }
    if (chips.childElementCount) {
      const s = el("small", "an-lens-note");
      s.textContent = declared.length
        ? "core-loop moments · money events firing · declared but silent"
        : "core-loop moments — no monetization events declared for this app";
      host.append(s); host.append(chips);
    }
  }

  function paintAcquisition(host: HTMLElement, p: Preset): void {
    const total = Number(p.new_users) || 0;
    const paid = Number(p.paid) || 0;
    const bar = el("div", "an-acq-bar");
    bar.innerHTML = `<i class="paid" style="width:${total ? (paid / total) * 100 : 0}%"></i>`;
    host.append(bar);
    const legend = el("div", "an-acq-legend");
    legend.innerHTML = `<span><i class="paid"></i>paid ${count(paid)}</span><span><i class="organic"></i>organic ${count(total - paid)}</span>`;
    host.append(legend);
    const channels = (p.channels as Array<{ channel: string; new_users: number }>) ?? [];
    if (channels.length) {
      const list = el("div", "an-channels");
      for (const c of channels.slice(0, 6)) {
        const r = el("div", "an-channel");
        r.innerHTML = `<span></span><b></b>`;
        r.querySelector("span")!.textContent = c.channel;
        r.querySelector("b")!.textContent = count(c.new_users);
        list.append(r);
      }
      host.append(list);
    }
  }

  /* ----------------------------------------------------------------- flow */

  function render(): void {
    const body = shell();
    const titleEl = root.querySelector<HTMLElement>(".an-title")!;
    if (setup && !setup.has_credential) { titleEl.textContent = "Analytics"; paintSetup(body); return; }
    if (discovering) { note(body, "Searching for keys…", "Testing each against GA4.", "muted"); return; }
    if (loading) { note(body, "Reading GA4…", "", "muted"); return; }

    if (bundle && (bundle.linked === false || !bundle.property_id)) {
      titleEl.textContent = bundle.app;
      note(body, "Not linked to a GA4 property", `${bundle.app} has no matching Analytics property yet.`, "warn");
      if (setup?.grant_email) {
        note(body, "If it should have one, grant the service account access", "Add it as Viewer in the app's Analytics account, then refresh.", "muted");
        copyRow(body, setup.grant_email);
      }
      return;
    }
    if (!bundle) {
      // No project selected — this tab only ever speaks about one app. The all-projects
      // Kill/Keep board lives on the Home screen, not here.
      titleEl.textContent = "Analytics";
      note(body, "Select a project", "Pick an app from the sidebar to see its analytics. The portfolio-wide board is on Home.", "muted");
      return;
    }

    titleEl.textContent = bundle.app;
    stateBanner(body, bundle);
    readingGuide(body, bundle);
    statRow(body, bundle);
    const chart = el("section", "an-activity");
    chart.innerHTML = activityChart(bundle.series ?? []);
    body.append(chart);
    actionDeck(body, bundle);
    presetTabs(body);
    paintPreset(body, bundle);
  }

  async function load(refresh = false): Promise<void> {
    if (!refresh && path) {
      const local = cachedBundle(path, days);
      if (local) {
        bundle = local.data;
        clientSavedAt = local.savedAt;
        loading = false;
        render();
        return;
      }
    }
    loading = true;
    render();
    try {
      setup = await moduleGet<Setup>(`${M}/setup${refresh ? "?refresh=1" : ""}`);
      if (!setup.has_credential) { loading = false; render(); return; }
      if (path) {
        bundle = await moduleGet<AppBundle>(`${M}/app?root=${q(path)}&days=${days}${refresh ? "&refresh=1" : ""}`);
        clientSavedAt = null;
        rememberBundle(path, days, bundle);
      } else {
        bundle = null;
        clientSavedAt = null;
      }
      loading = false;
      render();
    } catch (error) {
      loading = false;
      const body = shell();
      note(body, "Analytics unavailable", String(error), "risk");
    }
  }

  return {
    setProject(_projectId, projectPath): void {
      if (path === projectPath && bundle) return;
      path = projectPath;
      bundle = null;
      clientSavedAt = null;
      preset = "retention_wall";
      void load();
    },
    refresh(): void { void load(true); },
  };
}
