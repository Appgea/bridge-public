/**
 * The project rail's rules: which lane a project sits in, what its second line says, which rows
 * fold together, and what the small marks on a row mean.
 *
 * Pure functions over plain facts, so the rail in main.ts stays a painter and these stay testable
 * by reading them.
 *
 * LANES. A flat list of thirty apps that all say "idle" gives no reason to click any of them. The
 * lanes sort the portfolio by what it asks of you: an agent parked on you, an agent working, an
 * app on its way through a store, work in progress, live apps that moved lately, and the quiet
 * rest. Quiet folds away, so the rail at rest is the handful that matters today.
 */

import type { GitState } from "../types";
import type { Activity, Standing, Verdict } from "./pulse";

export type Lane = "needs" | "working" | "shipping" | "building" | "live" | "quiet";

export const LANES: ReadonlyArray<{ id: Lane; label: string; hint: string }> = [
  { id: "needs", label: "Needs you", hint: "An agent is parked on you, a turn finished, or work waits for review" },
  { id: "working", label: "Working", hint: "An agent is mid-turn" },
  { id: "shipping", label: "Shipping", hint: "In store review or being released, from portfolio.yaml" },
  { id: "building", label: "In progress", hint: "Being built, or active without a portfolio status" },
  { id: "live", label: "Live", hint: "Live apps that moved in the last two weeks" },
  { id: "quiet", label: "Quiet", hint: "Nothing waiting and no movement for two weeks, or paused" },
];

const DAY = 86_400_000;
/** No movement for this long and nothing waiting: the row goes to Quiet. */
export const QUIET_AFTER = 14 * DAY;
/** No movement for this long: the row fades, wherever it sits. */
export const STALE_AFTER = 30 * DAY;

export type RowFacts = {
  exists: boolean;
  attention: "needs" | "done" | null;
  running: boolean;
  reviews: number;
  standing: Standing | null;
  verdict: Verdict | null;
  /** Newest of: selected, an agent turn, a commit, a report. 0 = never. */
  touched: number;
};

export function laneOf(facts: RowFacts, now = Date.now()): Lane {
  if (facts.attention || facts.reviews > 0) return "needs";
  if (facts.running) return "working";
  if (!facts.exists) return "quiet";
  const status = facts.standing?.status ?? "";
  if (status === "review" || status === "releasing" || status === "submitted") return "shipping";
  if (status === "paused" || status === "archived") return "quiet";
  const moving = facts.touched > 0 && now - facts.touched < QUIET_AFTER;
  // A falling app is not quiet even if nobody touched it: that is exactly when it needs a look.
  if (!moving && !facts.verdict?.risk) return "quiet";
  if (status === "live") return "live";
  return "building";
}

/** The more urgent of two lanes. A merged row or a collection sits where its busiest member does. */
export function urgent(a: Lane, b: Lane): Lane {
  const rank = (lane: Lane): number => LANES.findIndex((entry) => entry.id === lane);
  return rank(a) <= rank(b) ? a : b;
}

/** "3d", "5h", "now". Short enough for a row. */
export function age(at: number, now = Date.now()): string {
  if (!at) return "";
  const mins = Math.max(0, Math.round((now - at) / 60_000));
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return days < 60 ? `${days}d` : `${Math.round(days / 30)}mo`;
}

export type LineInput = RowFacts & {
  ask: string | null;
  status: string;
  move: string;
  report: { title: string; at: number } | null;
};

export type Line = { text: string; tone: "warn" | "ok" | "live" | "risk" | "mute" | "" };

/** The row's second line: the one thing worth knowing before you click. */
export function rowLine(input: LineInput, now = Date.now()): Line {
  if (input.attention === "needs") return { text: input.ask ?? "needs your OK", tone: "warn" };
  if (input.attention === "done") {
    return { text: input.report ? `your turn · ${input.report.title}` : "your turn", tone: "ok" };
  }
  if (input.reviews > 0) return { text: `${input.reviews} to review`, tone: "warn" };
  if (input.running) return { text: input.status || "working", tone: "live" };
  if (!input.exists) return { text: "folder missing", tone: "risk" };
  if (input.verdict?.risk) {
    const trend = input.verdict.trend;
    const drop = trend !== null && trend < 0 ? ` · ${Math.round(trend * 100)}% wk` : "";
    return { text: `${input.verdict.label || input.verdict.call}${drop}`, tone: "risk" };
  }
  if (input.move) return { text: input.move, tone: "mute" };
  if (input.report && now - input.report.at < 7 * DAY) {
    return { text: `${input.report.title} · ${age(input.report.at, now)}`, tone: "" };
  }
  const status = known(input.standing?.status);
  const since = input.touched ? age(input.touched, now) : "";
  if (status && since) return { text: `${status} · ${since} ago`, tone: "" };
  if (status) return { text: status, tone: "" };
  if (!since) return { text: "idle", tone: "" };
  return { text: now - input.touched < QUIET_AFTER ? `active ${since} ago` : `quiet · ${since}`, tone: "" };
}

/** A portfolio status worth printing. "unknown" is the CPO's placeholder, not a fact. */
export function known(status: string | undefined): string {
  return status && status !== "unknown" ? status : "";
}

/** Up to two short git tokens. Drift you must act on first, then dirt, then unpushed work. */
export function gitChip(git: GitState | null): { text: string; warn: boolean; title: string } | null {
  if (!git?.is_repo) return null;
  const tokens: string[] = [];
  const notes: string[] = [];
  if (git.behind > 0) {
    tokens.push(`↓${git.behind}`);
    notes.push(`${git.behind} to pull`);
  }
  if (git.dirty > 0) {
    tokens.push(`±${git.dirty}`);
    notes.push(`${git.dirty} uncommitted`);
  }
  if (git.ahead > 0) {
    tokens.push(`↑${git.ahead}`);
    notes.push(`${git.ahead} to push`);
  }
  const mainline = ["main", "master", "develop", ""].includes(git.branch);
  if (!mainline) notes.unshift(`on ${git.branch}`);
  if (!tokens.length && mainline) return null;
  const text = (mainline ? tokens : [`⎇ ${git.branch.slice(0, 12)}`, ...tokens]).slice(0, 2).join(" ");
  return { text, warn: git.behind > 0 || git.dirty >= 10, title: notes.join(" · ") };
}

/** Fourteen bars, oldest left. Empty history draws nothing at all. */
export function sparkSvg(activity: Activity | null): string {
  const days = activity?.days ?? [];
  const peak = Math.max(0, ...days);
  if (!peak) return "";
  const scale = Math.max(peak, 3);
  const bars = days
    .map((count, at) => {
      const height = count ? Math.max(2, Math.round((count / scale) * 10)) : 1;
      return `<rect x="${at * 2}" y="${10 - height}" width="1.4" height="${height}" rx="0.5"${count ? "" : ' class="is-zero"'}/>`;
    })
    .join("");
  return `<svg class="project-spark" viewBox="0 0 28 10" aria-hidden="true">${bars}</svg>`;
}

/* ------------------------------------------------------------------ one row per app */

export type Member = { id: string; name: string; path: string; parent_id: string; role: string };

/**
 * Leaf projects that live inside another leaf's folder fold into that row.
 *
 * Key Master iOS and Key Master Android are one app on two platforms. Two rows say "two apps",
 * and the rail has room for neither. The host row keeps the shared name and gets one pill per
 * platform. Collections and their children are a separate shape and are left alone.
 */
export function platformGroups(members: Member[]): Map<string, string[]> {
  const loose = members.filter((m) => m.role === "leaf" && !m.parent_id);
  const hostOf = new Map<string, string>();
  for (const inner of loose) {
    let best: Member | null = null;
    for (const outer of loose) {
      if (outer.id === inner.id) continue;
      const prefix = outer.path.endsWith("/") ? outer.path : `${outer.path}/`;
      if (!inner.path.startsWith(prefix)) continue;
      if (!best || outer.path.length > best.path.length) best = outer;
    }
    if (best) hostOf.set(inner.id, best.id);
  }
  // A host that is itself folded hands its guests up to its own host.
  const root = (id: string): string => {
    let at = id;
    while (hostOf.has(at)) at = hostOf.get(at)!;
    return at;
  };
  const groups = new Map<string, string[]>();
  for (const id of hostOf.keys()) {
    const host = root(id);
    if (!groups.has(host)) groups.set(host, [host]);
    groups.get(host)!.push(id);
  }
  return groups;
}

/** "Key Master iOS" + "Key Master Android" → base "Key Master", pills "iOS" and "Android". */
export function splitNames(names: string[]): { base: string; pills: string[] } {
  const words = names.map((name) => name.trim().split(/\s+/));
  let shared = 0;
  while (words.every((list) => list.length > shared + 1 && list[shared] === words[0][shared])) shared += 1;
  if (!shared) return { base: names[0], pills: names };
  return {
    base: words[0].slice(0, shared).join(" "),
    pills: words.map((list) => list.slice(shared).join(" ")),
  };
}

/* ------------------------------------------------------------------ filter actions */

export type RowAction = "claude" | "shell" | "run" | "release" | "git" | "work" | "dash" | "review";

const ACTION_WORDS: Record<string, RowAction> = {
  claude: "claude",
  agent: "claude",
  shell: "shell",
  run: "run",
  release: "release",
  ship: "release",
  git: "git",
  diff: "work",
  work: "work",
  dash: "dash",
  review: "review",
};

/** "tavla release" → query "tavla", action release. A lone action word is still a search. */
export function parseQuery(raw: string): { query: string; action: RowAction | null } {
  const words = raw.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const last = words[words.length - 1];
  if (words.length > 1 && last && ACTION_WORDS[last]) {
    return { query: words.slice(0, -1).join(" "), action: ACTION_WORDS[last] };
  }
  return { query: words.join(" "), action: null };
}
