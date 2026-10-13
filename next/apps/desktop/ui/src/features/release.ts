/** The release screen. Two modes: one project's release, or the whole portfolio answering
 *  "which app needs a release at all". The Python release module stays the engine. */

import { loadModuleAssets, moduleGet, modulePost } from "./modules";
import { confirmDialog } from "../views/dialog";
import "./release.css";

const M = "/m/release-manager";
/** How an agent invokes the same engine this screen drives, for the copyable prompts. */
const CLI = "python3 release-manager/lib/release.py";

export type ReleaseHandle = {
  setProject(projectId: string, path: string): void;
  refresh(): void;
  paint(path: string, host: HTMLElement): Promise<void>;
};

/** Panel owns project selection, so a portfolio row hands the path back out. */
export type ReleaseEvents = { onOpenProject?(path: string, app: string): void };

type Platform = "ios" | "android";
type Note = { path: string; kind: string };
type Commit = { sha: string; short: string; subject: string; age: string; type: string };
type Diff = { sinceTag?: string; commits?: Commit[] };
type FlowPlatform = {
  shots: number;
  hasMetadata: boolean;
  locales: number;
  hasWhatsNew: boolean;
  released: boolean;
  pending: number;
  tag?: string;
};
type Flow = { platforms?: Partial<Record<Platform, FlowPlatform>> };
type LivePlatform = {
  configured?: boolean;
  needsCreds?: boolean;
  reason?: string;
  error?: string;
  version?: string;
  state?: string;
  versionCode?: number;
  status?: string;
};
type Live = { app?: string | null; ios?: LivePlatform; android?: LivePlatform };
type ReleaseState = {
  app: string;
  type: string;
  version?: string;
  platforms: string[];
  tags: { ios?: string; android?: string; iosExists?: boolean; androidExists?: boolean };
  status: {
    validationOk: boolean;
    validationMessage: string;
    rawScreenshots: number;
    framedScreenshots: number;
    fastlaneScreenshots: number;
    screenshotMappingOk?: boolean | null;
    nextSteps?: string[];
  };
  notes?: Partial<Record<Platform, Note[]>>;
};
type Artifacts = {
  locale?: string;
  locales?: string[];
  listing?: Record<string, string>;
  whatsNew?: string | null;
};
type Shot = { name: string; device: string; thumb: string };
type Shots = { locale?: string; locales?: string[]; shots?: Shot[]; total?: number };
type CatalogPlatform = { released?: boolean; lastTag?: string; ahead?: number; lastShipped?: string };
type CatalogEntry = {
  app: string;
  type?: string;
  version?: string;
  platforms?: string[];
  path?: string;
  error?: string;
  ios?: CatalogPlatform;
  android?: CatalogPlatform;
};
type RunResult = { jobId?: string; error?: string };

type ReleaseManagerApi = {
  renderJob(
    mount: HTMLElement,
    jobId: string,
    meta?: { app?: string; step?: string; platform?: string },
  ): HTMLElement;
  enhanceCard?(mount: HTMLElement, path: string): void;
};

declare global {
  interface Window {
    ReleaseManager?: ReleaseManagerApi;
  }
}

/** One launchable release-module step. `gate` marks the ones that change what the public
 *  can see, so they get a confirm regardless of how the button was reached. */
type Run = { label: string; step: string; platform?: string; gate?: boolean };

const cache = new Map<string, Promise<string>>();

async function fetchCard(path: string): Promise<string> {
  const hit = cache.get(path);
  if (hit) return hit;
  const pending = moduleGet<string>(`${M}/card?root=${encodeURIComponent(path)}`).then((html) =>
    typeof html === "string" ? html : "",
  );
  cache.set(path, pending);
  return pending;
}

export async function paintRelease(path: string, host: HTMLElement): Promise<void> {
  host.innerHTML = `<div class="ov-loading">reading release state…</div>`;
  try {
    const html = await fetchCard(path);
    host.innerHTML = html || `<div class="ov-empty">No release config for this project.</div>`;
    await loadModuleAssets("release-manager");
    window.ReleaseManager?.enhanceCard?.(host, path);
  } catch (error) {
    host.innerHTML = `<div class="ov-empty"></div>`;
    field<HTMLElement>(host, ".ov-empty").textContent = `Release state unavailable — ${String(error)}`;
  }
}

function field<T extends HTMLElement>(host: HTMLElement, selector: string): T {
  const found = host.querySelector<T>(selector);
  if (!found) throw new Error(`missing release control ${selector}`);
  return found;
}

function appFromCard(html: string): string {
  const document = new DOMParser().parseFromString(html, "text/html");
  return document.querySelector<HTMLElement>(".ov-plats")?.dataset.app ?? "";
}

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function button(className: string, label: string, onClick: () => void): HTMLButtonElement {
  const element = node("button", className, label);
  element.type = "button";
  element.addEventListener("click", onClick);
  return element;
}

function platformName(platform: Platform): string {
  return platform === "ios" ? "iOS" : "Android";
}

function storeName(platform: Platform): string {
  return platform === "ios" ? "App Store" : "Play Store";
}

function configuredPlatforms(state: ReleaseState): Platform[] {
  const list: Platform[] = [];
  if (state.platforms.includes("iOS")) list.push("ios");
  if (state.platforms.includes("android")) list.push("android");
  return list;
}

/** App Store Connect and Play both shout their states in SCREAMING_SNAKE. */
function humanState(raw: string): string {
  const words = raw.replace(/_/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function liveLine(platform: Platform, live: LivePlatform | undefined): string {
  if (!live) return "checking…";
  if (live.configured === false) return live.needsCreds ? "no store credentials" : live.reason || "not configured";
  if (live.error) return "store unreachable";
  if (platform === "ios") {
    return live.version ? `${live.version}${live.state ? ` · ${humanState(live.state)}` : ""}` : "no version found";
  }
  const code = live.versionCode ? `build ${live.versionCode}` : "no build found";
  return `${code}${live.status ? ` · ${humanState(live.status)}` : ""}`;
}

// ---- running a step ---------------------------------------------------------------

/** Steps whose argument parser has no --dry-run. Passing it anyway just kills the job, so
 *  these buttons are disabled while the dry-run switch is on rather than silently lying. */
const NO_DRY_RUN = new Set(["build", "post", "submit", "promote", "sync-tags", "full"]);

function isDryRun(screen: HTMLElement): boolean {
  return field<HTMLInputElement>(screen, "[data-rel=dry-run]").checked;
}

function flagsFor(run: Run, screen: HTMLElement): string[] {
  const flags: string[] = [];
  if (isDryRun(screen) && !NO_DRY_RUN.has(run.step)) flags.push("--dry-run");
  if (run.step === "bump") flags.push("--set", field<HTMLInputElement>(screen, "[data-rel=next-version]").value.trim());
  if (["upload-ios", "upload-play"].includes(run.step)) flags.push("--screenshots");
  return flags;
}

async function runStep(run: Run, app: string, screen: HTMLElement): Promise<void> {
  if (screen.dataset.starting === "1") return;
  if (
    run.gate &&
    !isDryRun(screen) &&
    !(await confirmDialog(`${run.label} — ${app}?\n\nThis changes what the public sees and needs your approval.`, {
      okLabel: run.label,
      danger: true,
    }))
  ) return;

  const jobHost = field<HTMLElement>(screen, ".rel-job-host");
  field<HTMLElement>(screen, ".rel-job").hidden = false;
  jobHost.innerHTML = `<div class="ov-loading">starting ${run.step}…</div>`;
  jobHost.scrollIntoView({ behavior: "smooth", block: "nearest" });
  screen.dataset.starting = "1";
  try {
    const result = await modulePost<RunResult>(`${M}/run`, {
      app,
      step: run.step,
      platform: run.platform ?? "",
      flags: flagsFor(run, screen),
    });
    if (result.error || !result.jobId) throw new Error(result.error || "release job did not start");
    const manager = window.ReleaseManager;
    if (!manager) throw new Error("release module did not load");
    manager.renderJob(jobHost, result.jobId, { app, step: run.step, platform: run.platform ?? "" });
  } catch (error) {
    jobHost.innerHTML = `<div class="rel-error"></div>`;
    field(jobHost, ".rel-error").textContent = String(error);
  } finally {
    delete screen.dataset.starting;
  }
}

// ---- version -----------------------------------------------------------------------

/** The version this checkout would naturally move to next -- a starting point for the
 *  field, not a rule. Anything typed there wins. */
function nextPatch(current: string | undefined): string {
  if (!current) return "";
  const parts = current.split(".");
  const last = Number(parts[parts.length - 1]);
  if (!Number.isFinite(last)) return current;
  return [...parts.slice(0, -1), String(last + 1)].join(".");
}

function versionBar(state: ReleaseState, screen: HTMLElement): HTMLElement {
  const bar = node("section", "rel-versionbar");
  bar.append(node("small", undefined, "This checkout"));
  bar.append(node("strong", "rel-current", state.version ?? "no version"), node("span", "rel-arrow", "→"));

  const input = node("input", "rel-next");
  input.dataset.rel = "next-version";
  input.type = "text";
  input.spellcheck = false;
  input.value = nextPatch(state.version);
  input.placeholder = "1.4.0";
  input.title = "The version to move to. Add +21 to pin the build number too.";

  const bump = button("rel-btn is-small", "Bump", () =>
    void runStep({ label: "Bump version", step: "bump" }, state.app, screen),
  );
  bump.title = "Rewrite the project's version files. Nothing is built, tagged or pushed.";
  const sync = (): void => { bump.disabled = !input.value.trim() || input.value.trim() === state.version; };
  input.addEventListener("input", sync);
  sync();

  bar.append(input, bump, node("small", "rel-versionbar-hint", "Local files only"));
  return bar;
}

// ---- one platform ------------------------------------------------------------------

/** The four things you do to one store, in the order they happen. Every button targets a
 *  single platform now, so nothing has to be split or disambiguated at click time. */
function platformRuns(platform: Platform): Array<Run & { hint: string; primary?: boolean }> {
  return platform === "ios"
    ? [
        { label: "Deploy build", step: "build", platform: "ios", primary: true, hint: "Build → TestFlight" },
        { label: "Attach build", step: "post", platform: "ios", hint: "Attach + set notes" },
        { label: "Upload listing", step: "upload-ios", platform: "ios", hint: "Metadata + screenshots" },
        { label: "Submit for review", step: "submit", platform: "ios", gate: true, hint: "Goes to Apple review" },
      ]
    : [
        { label: "Deploy build", step: "build", platform: "android", primary: true, hint: "Build → Play internal" },
        { label: "Attach build", step: "post", platform: "android", hint: "Internal release" },
        { label: "Upload listing", step: "upload-play", platform: "android", hint: "Metadata + screenshots" },
        { label: "Promote to production", step: "promote", platform: "android", gate: true, hint: "Goes public" },
      ];
}

/** A locale picker that reloads whatever panel owns it. */
function localePicker(locales: string[], current: string, onPick: (locale: string) => void): HTMLSelectElement {
  const select = node("select", "rel-locale");
  for (const locale of locales) {
    const option = node("option", undefined, locale);
    option.value = locale;
    if (locale === current) option.selected = true;
    select.append(option);
  }
  select.addEventListener("change", () => onPick(select.value));
  return select;
}

/** What this store will actually receive: the notes text and the staged screenshot deck.
 *  Both are fetched lazily -- they are the slowest reads and the screen is useful without. */
function shipmentPanel(app: string, platform: Platform): HTMLElement {
  const panel = node("div", "rel-ship");
  panel.innerHTML = `
    <div class="rel-ship-col" data-ship="notes">
      <div class="rel-ship-head"><strong>What's New</strong><span class="rel-ship-meta"></span></div>
      <div class="rel-ship-body"><div class="ov-loading">reading…</div></div>
    </div>
    <div class="rel-ship-col" data-ship="shots">
      <div class="rel-ship-head"><strong>Screenshots</strong><span class="rel-ship-meta"></span></div>
      <div class="rel-ship-body"><div class="ov-loading">reading…</div></div>
    </div>`;

  const notesCol = field<HTMLElement>(panel, '[data-ship=notes]');
  const shotsCol = field<HTMLElement>(panel, '[data-ship=shots]');

  const loadNotes = async (locale?: string): Promise<void> => {
    const body = field<HTMLElement>(notesCol, ".rel-ship-body");
    const meta = field<HTMLElement>(notesCol, ".rel-ship-meta");
    try {
      const query = `app=${encodeURIComponent(app)}&platform=${platform}${locale ? `&locale=${encodeURIComponent(locale)}` : ""}`;
      const data = await moduleGet<Artifacts>(`${M}/artifacts?${query}`);
      const locales = data.locales ?? [];
      meta.replaceChildren();
      if (locales.length > 1 && data.locale) {
        meta.append(localePicker(locales, data.locale, (pick) => void loadNotes(pick)));
      } else if (data.locale) {
        meta.append(node("span", undefined, data.locale));
      }
      body.replaceChildren(
        data.whatsNew
          ? node("pre", "rel-notes-text", data.whatsNew)
          : node("div", "rel-ship-empty", "No release notes on disk for this locale."),
      );
    } catch (error) {
      body.replaceChildren(node("div", "rel-ship-empty", `Unavailable — ${String(error)}`));
    }
  };

  const loadShots = async (locale?: string): Promise<void> => {
    const body = field<HTMLElement>(shotsCol, ".rel-ship-body");
    const meta = field<HTMLElement>(shotsCol, ".rel-ship-meta");
    try {
      const query = `app=${encodeURIComponent(app)}&platform=${platform}&limit=8${locale ? `&locale=${encodeURIComponent(locale)}` : ""}`;
      const data = await moduleGet<Shots>(`${M}/shots?${query}`);
      const shots = data.shots ?? [];
      const locales = data.locales ?? [];
      meta.replaceChildren();
      if (locales.length > 1 && data.locale) {
        meta.append(localePicker(locales, data.locale, (pick) => void loadShots(pick)));
      }
      if (!shots.length) {
        body.replaceChildren(node("div", "rel-ship-empty", "Nothing staged for this store yet."));
        return;
      }
      const strip = node("div", "rel-strip");
      for (const shot of shots) {
        const frame = node("figure", "rel-shot");
        const image = node("img");
        image.src = shot.thumb;
        image.alt = shot.name;
        image.loading = "lazy";
        frame.append(image, node("figcaption", undefined, shot.name.replace(/\.png$/i, "")));
        frame.title = `${shot.device} · ${shot.name}`;
        strip.append(frame);
      }
      const total = data.total ?? shots.length;
      body.replaceChildren(strip);
      if (total > shots.length) {
        body.append(node("small", "rel-strip-more", `showing ${shots.length} of ${total} staged`));
      }
    } catch (error) {
      body.replaceChildren(node("div", "rel-ship-empty", `Unavailable — ${String(error)}`));
    }
  };

  void loadNotes();
  void loadShots();
  return panel;
}

function platformBlock(
  platform: Platform,
  state: ReleaseState,
  flow: FlowPlatform,
  diff: Diff,
  screen: HTMLElement,
): HTMLElement {
  const block = node("section", "rel-plat");
  const head = node("header", "rel-plat-head");
  head.append(node("h3", undefined, platformName(platform)));

  const live = node("span", "rel-plat-live", "checking…");
  live.dataset.live = platform;
  head.append(node("small", undefined, storeName(platform)), live);

  const ahead = diff.commits?.length ?? 0;
  const aheadPill = node(
    "span",
    `rel-plat-ahead${ahead ? " is-ahead" : ""}`,
    ahead ? `${ahead} commit${ahead === 1 ? "" : "s"} ahead` : "up to date",
  );
  if (diff.sinceTag) aheadPill.title = `since ${diff.sinceTag}`;
  head.append(aheadPill);
  block.append(head);

  const row = node("div", "rel-plat-actions");
  for (const run of platformRuns(platform)) {
    const cell = node("div", "rel-plat-action");
    const control = button(
      `rel-btn is-wide${run.primary ? " is-accent" : ""}${run.gate ? " is-gated" : ""}`,
      run.label.replace(" build", "").replace(" listing", "").replace(" for review", "").replace(" to production", ""),
      () => void runStep(run, state.app, screen),
    );
    control.dataset.step = run.step;
    const blocked = isDryRun(screen) && NO_DRY_RUN.has(run.step);
    control.disabled = blocked;
    control.title = blocked ? `${run.label} has no dry run — turn the switch off to use it` : run.label;
    cell.append(control, node("small", "rel-plat-hint", run.hint));
    row.append(cell);
  }
  block.append(row, shipmentPanel(state.app, platform));

  if (!flow.hasMetadata) {
    block.append(node("div", "rel-plat-warn", "No fastlane metadata found for this store."));
  }
  return block;
}

// ---- the shared change list ---------------------------------------------------------

function commitGroup(title: string, commits: Commit[]): HTMLElement {
  const group = node("div", "rel-group");
  group.append(node("h4", undefined, title));
  const list = node("div", "rel-group-list");
  for (const commit of commits) {
    const row = node("div", "rel-commit");
    row.append(
      node("span", "rel-commit-subject", commit.subject),
      node("code", "rel-commit-sha", commit.short),
      node("small", "rel-commit-age", commit.age),
    );
    list.append(row);
  }
  group.append(list);
  return group;
}

/** One shared history when both platforms share Git. Separate native repos keep separate lists. */
function changeSets(
  configured: Platform[],
  diffs: Partial<Record<Platform, Diff>>,
): Array<[Platform, Diff]> {
  const rows = configured.map((platform) => [platform, diffs[platform] ?? {}] as [Platform, Diff]);
  const histories = new Set(rows.map(([, diff]) => (diff.commits ?? []).map((item) => item.sha).join(",")));
  if (histories.size > 1) return rows;
  return rows.sort((a, b) => (b[1].commits?.length ?? 0) - (a[1].commits?.length ?? 0)).slice(0, 1);
}

function changesPanel(configured: Platform[], diffs: Partial<Record<Platform, Diff>>): HTMLElement {
  const panel = node("section", "rel-changes");
  const sets = changeSets(configured, diffs);
  for (const [platform, chosen] of sets) {
    const commits = chosen.commits ?? [];
    const prefix = sets.length > 1 ? `${platformName(platform)} · ` : "";
    const head = node("header", "rel-changes-head");
    head.append(node("h3", undefined, chosen.sinceTag
      ? `${prefix}Since ${chosen.sinceTag}`
      : `${prefix}Since the last release`));
    const oldest = commits.length ? commits[commits.length - 1].age : null;
    head.append(node("small", undefined, commits.length
      ? `${commits.length} commit${commits.length === 1 ? "" : "s"}${oldest ? ` · oldest ${oldest}` : ""}`
      : "nothing new"));
    panel.append(head);

    if (!commits.length) {
      const empty = node("div", "rel-changes-empty");
      empty.append(
        node("strong", undefined, "This checkout is already released."),
        node("span", undefined, chosen.sinceTag
          ? `Nothing has landed since ${chosen.sinceTag}.`
          : "No unreleased commits found."),
      );
      panel.append(empty);
      continue;
    }

    const feats = commits.filter((c) => c.type === "feat");
    const fixes = commits.filter((c) => c.type === "fix");
    const other = commits.filter((c) => c.type !== "feat" && c.type !== "fix");
    const body = node("div", "rel-changes-body");
    if (feats.length) body.append(commitGroup("Features", feats));
    if (fixes.length) body.append(commitGroup("Fixes", fixes));
    if (other.length) body.append(commitGroup("Other", other));
    panel.append(body);

    if (!feats.length && !fixes.length) {
      panel.append(node("div", "rel-changes-flag", "Nothing user-facing here — every commit is chore/other."));
    }
  }
  return panel;
}

// ---- agent hand-offs ---------------------------------------------------------------

function handoffRow(title: string, status: string, ready: boolean, prompt: string): HTMLElement {
  const block = node("div", `rel-handoff${ready ? " is-ready" : ""}`);
  const head = node("div", "rel-handoff-head");
  head.append(node("strong", undefined, title), node("span", "rel-handoff-status", status));

  // The prompt is shown in full and stays editable -- copying takes whatever is in the
  // box, so it can be adjusted before it goes to an agent.
  const text = node("textarea", "rel-prompt");
  text.value = prompt;
  text.spellcheck = false;
  text.rows = Math.min(12, prompt.split("\n").length + 1);

  const copy = button("rel-btn is-small", "Copy", () => {
    void navigator.clipboard.writeText(text.value).then(
      () => {
        copy.textContent = "Copied";
        copy.classList.add("is-copied");
        window.setTimeout(() => {
          copy.textContent = "Copy";
          copy.classList.remove("is-copied");
        }, 1600);
      },
      () => { copy.textContent = "Copy failed"; },
    );
  });
  head.append(copy);
  block.append(head, text);
  return block;
}

function screenshotPrompt(state: ReleaseState, configured: Platform[]): string {
  const platforms = configured.map(platformName).join(" + ");
  const shots = state.status;
  const mapping = shots.screenshotMappingOk === false
    ? "\nThe slot→filename mapping needs review — run shots-check first." : "";
  return [
    `${state.app} — design and capture the store screenshots (${platforms}).`,
    `On disk now: ${shots.rawScreenshots} raw, ${shots.framedScreenshots} framed, ${shots.fastlaneScreenshots} staged for fastlane.${mapping}`,
    ``,
    `Use the screenshot-director and showcase skills. Render on the iPhone simulator, not Chrome.`,
    `When the set is right, stage it:`,
    `  ${CLI} shots-run ${state.app}`,
  ].join("\n");
}

function notesPrompt(state: ReleaseState, configured: Platform[], diffs: Partial<Record<Platform, Diff>>): string {
  const sets = changeSets(configured, diffs);
  const changes = sets.flatMap(([platform, diff]) => [
    diff.sinceTag
      ? `${sets.length > 1 ? `${platformName(platform)} changed` : "Changed"} since ${diff.sinceTag} (${diff.commits?.length ?? 0} commits):`
      : `${sets.length > 1 ? platformName(platform) : "Recent changes"} (${diff.commits?.length ?? 0} commits):`,
    ...(diff.commits ?? []).map((commit) => `- ${commit.subject}`),
  ]);
  const uploads = configured.map((platform) => `  ${CLI} ${platform === "ios" ? "upload-ios" : "upload-play"} ${state.app}`);
  return [
    `${state.app} ${state.version ?? ""} — write the "What's New" release notes.`.replace(/\s+—/, " —"),
    ...changes,
    ``,
    `Write it for users, not developers: no commit-speak, no internal names, a few short lines.`,
    `Save it into the fastlane metadata release notes for every configured locale, then upload:`,
    ...uploads,
  ].join("\n");
}

// ---- the portfolio ------------------------------------------------------------------

function aheadOf(entry: CatalogEntry): number {
  return Math.max(entry.ios?.ahead ?? 0, entry.android?.ahead ?? 0);
}

function shippedOf(entry: CatalogEntry): string {
  return entry.ios?.lastShipped || entry.android?.lastShipped || "never";
}

/** The portfolio answers a different question than the project screen: not "how do I ship
 *  this" but "which of these needs shipping at all". Sorted by how far behind each app is. */
function portfolioTable(entries: CatalogEntry[], events: ReleaseEvents): HTMLElement {
  const wrap = node("section", "rel-portfolio");
  const ranked = [...entries].sort((a, b) => aheadOf(b) - aheadOf(a) || a.app.localeCompare(b.app));
  const waiting = ranked.filter((entry) => aheadOf(entry) > 0);

  const head = node("header", "rel-changes-head");
  head.append(node("h3", undefined, "All apps"));
  head.append(node("small", undefined,
    `${waiting.length} of ${ranked.length} ${waiting.length === 1 ? "app has" : "apps have"} unreleased work`));
  wrap.append(head);

  const table = node("div", "rel-table");
  const header = node("div", "rel-row is-head");
  for (const label of ["App", "Local", "iOS", "Android", "Last shipped"]) {
    header.append(node("span", undefined, label));
  }
  table.append(header);

  for (const entry of ranked) {
    const row = node("div", `rel-row${aheadOf(entry) > 0 ? " is-waiting" : ""}`);
    const name = node("span", "rel-row-app");
    name.append(node("strong", undefined, entry.app));
    if (entry.type) name.append(node("small", undefined, entry.type));
    row.append(name, node("span", "rel-row-ver", entry.version ?? "—"));

    for (const platform of ["ios", "android"] as Platform[]) {
      const value = entry[platform];
      const cell = node("span", "rel-row-plat");
      if (!value) {
        cell.append(node("small", "rel-muted", "—"));
      } else if ((value.ahead ?? 0) > 0) {
        cell.append(node("span", "rel-ahead", `${value.ahead} ahead`));
      } else {
        cell.append(node("small", "rel-muted", "up to date"));
      }
      row.append(cell);
    }
    row.append(node("span", "rel-row-when", shippedOf(entry)));

    if (entry.error) {
      row.classList.add("is-error");
      row.title = entry.error;
    } else if (entry.path && events.onOpenProject) {
      row.classList.add("is-clickable");
      row.title = `Open ${entry.app}`;
      row.addEventListener("click", () => events.onOpenProject?.(entry.path as string, entry.app));
    }
    table.append(row);
  }
  wrap.append(table);
  return wrap;
}

// ---- the project screen --------------------------------------------------------------

function buildScreen(
  state: ReleaseState,
  flow: Flow,
  diffs: Partial<Record<Platform, Diff>>,
  refresh: () => void,
): HTMLElement {
  const configured = configuredPlatforms(state);
  const screen = node("div", "rel-screen");
  screen.innerHTML = `
    <section class="rel-validation" hidden></section>
    <section class="rel-versionbar-slot"></section>
    <div class="rel-plats"></div>
    <section class="rel-handoffs"></section>
    <div class="rel-changes-slot"></div>
    <details class="rel-more"><summary>More commands</summary><div class="rel-more-grid"></div></details>
    <section class="rel-job" hidden><header><h3>Job output</h3></header><div class="rel-job-host"></div></section>
    <label class="rel-dry" hidden><input type="checkbox" data-rel="dry-run"></label>`;

  // Config failures surface here or not at all -- a bad Makefile fails the build twenty
  // minutes in, long after the click that caused it.
  if (!state.status.validationOk) {
    const strip = field<HTMLElement>(screen, ".rel-validation");
    strip.hidden = false;
    strip.append(
      node("strong", undefined, "Config problem"),
      node("span", undefined, state.status.validationMessage || "validation failed"),
    );
  }

  field(screen, ".rel-versionbar-slot").append(versionBar(state, screen));

  const plats = field(screen, ".rel-plats");
  for (const platform of configured) {
    plats.append(platformBlock(platform, state, flow.platforms?.[platform] ?? emptyFlow(), diffs[platform] ?? {}, screen));
  }

  const shots = state.status;
  const shotsReady = shots.fastlaneScreenshots > 0 && shots.screenshotMappingOk !== false;
  const notesReady = configured.every((platform) => Boolean(flow.platforms?.[platform]?.hasWhatsNew));
  const noteSources = (state.notes?.ios?.length ?? 0) + (state.notes?.android?.length ?? 0);
  field(screen, ".rel-handoffs").append(
    handoffRow(
      "Screenshots",
      shots.screenshotMappingOk === false
        ? `${shots.fastlaneScreenshots} staged · mapping needs review`
        : shots.fastlaneScreenshots > 0
          ? `${shots.fastlaneScreenshots} staged for the stores`
          : `${shots.rawScreenshots} raw · none staged yet`,
      shotsReady,
      screenshotPrompt(state, configured),
    ),
    handoffRow(
      "Release notes",
      notesReady
        ? "written for every locale"
        : noteSources
          ? `${noteSources} local source${noteSources === 1 ? "" : "s"} found, not in the listing yet`
          : "none written yet",
      notesReady,
      notesPrompt(state, configured, diffs),
    ),
  );

  field(screen, ".rel-changes-slot").append(changesPanel(configured, diffs));

  const moreGrid = field(screen, ".rel-more-grid");
  const more: Run[] = [
    { label: "Status report", step: "status" },
    { label: "Validate config", step: "validate" },
    { label: "Preview tags", step: "tag-check" },
    { label: "Create release tags", step: "tag" },
    { label: "Sync tags from stores", step: "sync-tags" },
    { label: "Capture screenshots", step: "shots-run" },
    { label: "Frame screenshots", step: "shots-frame" },
    { label: "Stage for stores", step: "shots-stage" },
    { label: "Diagnose screenshot names", step: "shots-check" },
    { label: "Describe capabilities", step: "describe" },
  ];
  for (const run of more) {
    moreGrid.append(button("rel-btn is-ghost", run.label, () => void runStep(run, state.app, screen)));
  }
  void refresh;
  return screen;
}

function emptyFlow(): FlowPlatform {
  return { shots: 0, hasMetadata: false, locales: 0, hasWhatsNew: false, released: false, pending: 0 };
}

/** Live store state costs real API round-trips, so it lands after the screen is up. */
async function fillLive(screen: HTMLElement, path: string, configured: Platform[]): Promise<void> {
  try {
    const live = await moduleGet<Live>(`${M}/live?root=${encodeURIComponent(path)}`);
    for (const platform of configured) {
      const cell = screen.querySelector<HTMLElement>(`[data-live=${platform}]`);
      if (!cell) continue;
      const value = live[platform];
      cell.textContent = liveLine(platform, value);
      cell.classList.toggle("is-unknown", !value || value.configured === false || Boolean(value.error));
    }
  } catch {
    for (const platform of configured) {
      const cell = screen.querySelector<HTMLElement>(`[data-live=${platform}]`);
      if (!cell) continue;
      cell.textContent = "unavailable";
      cell.classList.add("is-unknown");
    }
  }
}

export function mountRelease(host: HTMLElement, events: ReleaseEvents = {}): ReleaseHandle {
  host.className = "pane release-pane";
  host.innerHTML = `
    <div class="rel-wrap">
      <header class="rel-head">
        <div class="rel-head-id"><h2>Release</h2><small></small></div>
        <div class="rel-mode" role="group" aria-label="Scope"></div>
        <label class="rel-dry"><input type="checkbox" data-rel="dry-run"> Dry run</label>
        <button type="button" class="rel-btn is-ghost rel-refresh" title="Re-read release state">↻</button>
      </header>
      <div class="rel-body"><div class="ov-loading">loading release state…</div></div>
    </div>`;
  const body = field<HTMLElement>(host, ".rel-body");
  const headTitle = field<HTMLElement>(host, ".rel-head-id h2");
  const headMeta = field<HTMLElement>(host, ".rel-head-id small");
  const dryLabel = field<HTMLElement>(host, "header .rel-dry");
  let projectPath = "";
  let mode: "project" | "portfolio" = "project";
  let loadId = 0;

  const modeBox = field<HTMLElement>(host, ".rel-mode");
  const modeButtons = new Map<string, HTMLButtonElement>();
  for (const [value, label] of [["project", "This app"], ["portfolio", "All apps"]] as const) {
    const element = button("rel-mode-btn", label, () => {
      if (mode === value) return;
      mode = value;
      for (const [key, btn] of modeButtons) btn.classList.toggle("is-on", key === mode);
      void draw();
    });
    modeButtons.set(value, element);
    modeBox.append(element);
  }
  modeButtons.get("project")?.classList.add("is-on");

  const drawPortfolio = async (): Promise<void> => {
    const requested = ++loadId;
    headTitle.textContent = "Portfolio";
    headMeta.textContent = "every app the release module knows";
    dryLabel.hidden = true;
    body.innerHTML = `<div class="rel-loading"><strong>Reading every app</strong><small>Checking tags and unreleased commits across the portfolio…</small></div>`;
    try {
      const entries = await moduleGet<CatalogEntry[] | { projects: CatalogEntry[] }>(`${M}/catalog`);
      if (requested !== loadId) return;
      const list = Array.isArray(entries) ? entries : entries.projects ?? [];
      body.replaceChildren(portfolioTable(list, events));
    } catch (error) {
      if (requested !== loadId) return;
      body.innerHTML = `<div class="rel-error"></div>`;
      field(body, ".rel-error").textContent = `Portfolio unavailable — ${String(error)}`;
    }
  };

  const drawProject = async (): Promise<void> => {
    if (!projectPath) {
      body.innerHTML = `<div class="rel-no-config"><h2>No project selected</h2><p>Pick a project, or switch to All apps.</p></div>`;
      return;
    }
    const requestedPath = projectPath;
    const requested = ++loadId;
    dryLabel.hidden = false;
    body.innerHTML = `<div class="rel-loading"><strong>Reading release state</strong><small>Checking version, tags and store artifacts…</small></div>`;
    try {
      const [, card] = await Promise.all([loadModuleAssets("release-manager"), fetchCard(requestedPath)]);
      if (requested !== loadId || requestedPath !== projectPath) return;
      const app = appFromCard(card);
      if (!app) {
        headTitle.textContent = "Release";
        headMeta.textContent = "";
        body.innerHTML = `<div class="rel-no-config"><h2>No release configuration</h2><p>This project is not registered with the release module yet.</p></div>`;
        return;
      }
      const state = await moduleGet<ReleaseState>(`${M}/state?app=${encodeURIComponent(app)}`);
      const platforms = configuredPlatforms(state);
      const [flow, ...diffValues] = await Promise.all([
        moduleGet<Flow>(`${M}/flow?app=${encodeURIComponent(app)}`),
        ...platforms.map((platform) => moduleGet<Diff>(`${M}/diff?app=${encodeURIComponent(app)}&platform=${platform}`)),
      ]);
      if (requested !== loadId || requestedPath !== projectPath) return;
      const diffs: Partial<Record<Platform, Diff>> = {};
      platforms.forEach((platform, index) => { diffs[platform] = diffValues[index]; });

      headTitle.textContent = state.app;
      headMeta.textContent = `${state.type} · ${platforms.map(platformName).join(" + ")}`;
      const screen = buildScreen(state, flow, diffs, () => { cache.delete(projectPath); void draw(); });
      body.replaceChildren(screen);
      // The real switch lives in the pane header; the screen keeps a hidden mirror so
      // flagsFor() has one selector to read no matter which mode drew it.
      const mirror = field<HTMLInputElement>(screen, "[data-rel=dry-run]");
      const real = field<HTMLInputElement>(host, "header [data-rel=dry-run]");
      mirror.checked = real.checked;
      real.onchange = () => {
        mirror.checked = real.checked;
        for (const control of screen.querySelectorAll<HTMLButtonElement>(".rel-plat-action .rel-btn")) {
          const step = control.dataset.step ?? "";
          if (NO_DRY_RUN.has(step)) control.disabled = real.checked;
        }
      };
      void fillLive(screen, requestedPath, platforms);
    } catch (error) {
      if (requested !== loadId) return;
      body.innerHTML = `<div class="rel-error"></div>`;
      field(body, ".rel-error").textContent = `Release state unavailable — ${String(error)}`;
    }
  };

  const draw = (): Promise<void> => (mode === "portfolio" ? drawPortfolio() : drawProject());
  field<HTMLButtonElement>(host, ".rel-refresh").addEventListener("click", () => {
    cache.delete(projectPath);
    void draw();
  });

  return {
    setProject(_projectId, path) {
      if (projectPath === path && body.querySelector(".rel-screen")) return;
      projectPath = path;
      if (mode === "project") void draw();
    },
    refresh() {
      cache.delete(projectPath);
      void draw();
    },
    paint: paintRelease,
  };
}
