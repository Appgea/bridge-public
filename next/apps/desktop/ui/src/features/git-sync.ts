/**
 * Pull all / Push all — one sweep across every Panel-tracked repository.
 *
 * The portfolio is a dozen repos, and the question "is everything in sync?" used to cost a dozen
 * visits to the Git tab. This is the one place that answers it and then acts on it: scan, show the
 * plan, run it repo by repo, and settle each row with what actually happened.
 *
 * HONEST MOTION. Every moving thing here is bound to a real phase reported by git, not to a timer
 * pretending to be progress. The packet crossing a row's track means that repo's `git fetch` /
 * `rebase` / `push` is running RIGHT NOW; it stops when the subprocess stops. The phase word under
 * the name is the module's own progress file (`/pull/progress`), polled while the repo is in
 * flight — so a slow repo looks slow instead of looking finished.
 *
 * SEQUENTIAL ON PURPOSE. Each repo is a separate one-shot subprocess. Running them one at a time
 * costs wall-clock but buys a readable sweep and keeps a credential prompt or a conflict from
 * landing in the middle of four other repos' output.
 */

import { moduleGet, modulePost } from "./modules";
import { icon } from "../icons";
import "../motion.css";
import "./git-sync.css";

const M = "/m/git-manager";

export type SweepMode = "pull" | "push";

type RepoInfo = {
  path: string;
  name: string;
  branch: string;
  remote: string;
  behind?: number;
  ahead?: number;
  dirty?: number;
  hasUpstream?: boolean;
};

/** `count` is behind (pull) or ahead (push); -1 means "never pushed — unknown, but send it". */
type Row = {
  info: RepoInfo;
  count: number;
  node: HTMLElement;
  phase: HTMLElement;
  note: HTMLElement;
  fix: HTMLElement;
  state: RowState;
};

type RowState = "wait" | "queued" | "active" | "done" | "conflict" | "failed" | "insync";

type PullResult = {
  ok?: boolean;
  pulled?: boolean;
  conflict?: boolean;
  conflicts?: string[];
  error?: string;
};
type PushResult = { ok?: boolean; pushed?: boolean; rejected?: boolean; error?: string };

const esc = (value: unknown): string =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      (({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }) as Record<
        string,
        string
      >)[c] ?? c,
  );

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

/** git's own words, shortened to something readable at a glance in a row. */
const PHASE_COPY: Record<string, string> = {
  fetching: "fetching",
  rebasing: "rebasing",
  pushing: "pushing",
  resolving: "agent resolving",
  done: "done",
  failed: "failed",
  conflict: "conflicted",
};

const COPY = {
  pull: {
    title: "Pull all",
    lede: "Every tracked repository, rebased onto its remote.",
    verb: "Pull",
    running: "Pulling",
    done: "pulled",
    nothing: "Nothing to pull — every repository already has its remote's history.",
    unit: "behind",
  },
  push: {
    title: "Push all",
    lede: "Every tracked repository's unsent commits, sent to its remote.",
    verb: "Push",
    running: "Pushing",
    done: "pushed",
    nothing: "Nothing to push — no repository is carrying unsent commits.",
    unit: "ahead",
  },
} as const;

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * Open the sweep. Resolves when the panel closes, carrying how many repos actually moved — the
 * caller uses that to decide whether the dashboard's numbers are stale.
 */
export function openGitSweep(mode: SweepMode): Promise<number> {
  return new Promise((resolve) => {
    const copy = COPY[mode];
    let rows: Row[] = [];
    let running = false;
    let changed = 0;
    let closed = false;

    /* ------------------------------------------------------------------ shell */

    const wrap = document.createElement("div");
    wrap.className = "gs-wrap";
    wrap.dataset.mode = mode;
    wrap.innerHTML = `
      <section class="gs-card mo-rise" role="dialog" aria-modal="true">
        <header class="gs-head">
          <span class="gs-ico" aria-hidden="true">${icon("git")}</span>
          <div class="gs-title">
            <strong>${copy.title}</strong>
            <small>${copy.lede}</small>
          </div>
          <button class="gs-close" type="button" title="Close">✕</button>
        </header>
        <div class="gs-bar"><i></i></div>
        <div class="gs-list" role="list"></div>
        <footer class="gs-foot">
          <div class="gs-summary">Scanning repositories…</div>
          <div class="gs-acts">
            <button class="gs-btn gs-go" type="button" disabled>Scanning…</button>
          </div>
        </footer>
      </section>`;

    const card = wrap.querySelector<HTMLElement>(".gs-card")!;
    const list = wrap.querySelector<HTMLElement>(".gs-list")!;
    const bar = wrap.querySelector<HTMLElement>(".gs-bar")!;
    const barFill = bar.querySelector<HTMLElement>("i")!;
    const summary = wrap.querySelector<HTMLElement>(".gs-summary")!;
    const acts = wrap.querySelector<HTMLElement>(".gs-acts")!;
    const go = wrap.querySelector<HTMLButtonElement>(".gs-go")!;
    const closeBtn = wrap.querySelector<HTMLButtonElement>(".gs-close")!;

    const close = (): void => {
      if (running || closed) return;
      closed = true;
      document.removeEventListener("keydown", onKey, true);
      card.classList.add("is-leaving");
      setTimeout(() => wrap.remove(), 140);
      resolve(changed);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener("keydown", onKey, true);
    closeBtn.addEventListener("click", close);
    wrap.addEventListener("mousedown", (event) => {
      if (event.target === wrap) close();
    });
    document.body.append(wrap);

    /* ------------------------------------------------------------------- rows */

    function setState(row: Row, state: RowState): void {
      row.state = state;
      row.node.dataset.state = state;
    }

    function makeRow(info: RepoInfo, count: number, index: number): Row {
      const node = document.createElement("div");
      node.className = "gs-row mo-rise";
      node.style.setProperty("--mo-delay", `${Math.min(index, 12) * 32}ms`);
      node.setAttribute("role", "listitem");
      const badge =
        count < 0
          ? "first push"
          : count > 0
            ? `${mode === "pull" ? "↓" : "↑"}${count}`
            : "in sync";
      node.innerHTML = `
        <span class="gs-mark" aria-hidden="true"></span>
        <div class="gs-id">
          <b>${esc(info.name)}</b>
          <small class="mono">${esc(info.branch)} · ${esc(info.remote)}</small>
        </div>
        <div class="gs-track" aria-hidden="true"><i class="gs-packet"></i></div>
        <div class="gs-status">
          <span class="gs-phase">${esc(badge)}</span>
          <small class="gs-note"></small>
        </div>
        <div class="gs-fix"></div>`;
      list.append(node);
      return {
        info,
        count,
        node,
        phase: node.querySelector<HTMLElement>(".gs-phase")!,
        note: node.querySelector<HTMLElement>(".gs-note")!,
        fix: node.querySelector<HTMLElement>(".gs-fix")!,
        state: "wait",
      };
    }

    function paintRow(row: Row, phase: string, note = ""): void {
      row.phase.textContent = phase;
      row.note.textContent = note;
      row.note.title = note;
    }

    /* ------------------------------------------------------------------ scan */

    const listPath = (fetch: boolean): string =>
      mode === "pull"
        ? `${M}/pullable?fetch=${fetch ? 1 : 0}`
        : `${M}/pushable?fetch=${fetch ? 1 : 0}`;

    const countOf = (info: RepoInfo): number =>
      mode === "pull" ? (info.behind ?? 0) : (info.ahead ?? 0);

    async function scan(): Promise<void> {
      // Two-stage on pull: the cached counts land instantly so the panel has something true to
      // show, then the fetched counts replace them. Push needs no network to know what it holds.
      let seen: RepoInfo[] = [];
      try {
        const first = await moduleGet<{ pullable?: RepoInfo[]; pushable?: RepoInfo[] }>(
          listPath(false),
        );
        seen = first.pullable ?? first.pushable ?? [];
      } catch (error) {
        summary.textContent = `Could not read the project list. ${String(error)}`;
        go.hidden = true;
        return;
      }
      draw(seen);

      if (mode === "pull") {
        bar.classList.add("is-scanning");
        summary.textContent = "Refreshing remotes…";
        try {
          const live = await moduleGet<{ pullable?: RepoInfo[] }>(listPath(true));
          if (closed) return;
          draw(live.pullable ?? seen);
        } catch {
          // offline or auth-blocked: the cached counts stay, and the summary says so
          summary.textContent = "Remotes could not be refreshed — showing last known counts.";
        }
        bar.classList.remove("is-scanning");
      }
      armGo();
    }

    function draw(infos: RepoInfo[]): void {
      const ordered = [...infos].sort((a, b) => {
        const diff = Math.abs(countOf(b)) - Math.abs(countOf(a));
        return diff || a.name.localeCompare(b.name);
      });
      list.replaceChildren();
      rows = ordered.map((info, index) => {
        const row = makeRow(info, countOf(info), index);
        setState(row, row.count === 0 ? "insync" : "wait");
        return row;
      });
    }

    const pending = (): Row[] => rows.filter((row) => row.count !== 0);

    function armGo(): void {
      const todo = pending();
      const insync = rows.length - todo.length;
      if (!rows.length) {
        summary.textContent = "No tracked repository has a remote to sync with.";
        go.hidden = true;
        return;
      }
      if (!todo.length) {
        summary.textContent = copy.nothing;
        go.hidden = true;
        return;
      }
      const total = todo.reduce((sum, row) => sum + Math.max(row.count, 1), 0);
      summary.textContent = `${plural(todo.length, "repository", "repositories")} · ${plural(
        total,
        "commit",
      )} to ${mode}${insync ? ` · ${insync} already in sync` : ""}`;
      go.disabled = false;
      go.textContent = `${copy.verb} ${plural(todo.length, "repository", "repositories")}`;
      go.focus();
    }

    /* -------------------------------------------------------------- the sweep */

    /** Poll the module's progress file so a row says what git is doing, not what we hope it is. */
    function watch(row: Row): () => void {
      let alive = true;
      const tick = async (): Promise<void> => {
        while (alive) {
          try {
            const state = await moduleGet<{ phase?: string; note?: string }>(
              `${M}/${mode}/progress?repo=${encodeURIComponent(row.info.path)}`,
            );
            if (!alive) return;
            const phase = state.phase ?? "";
            if (phase && phase !== "done" && phase !== "failed") {
              paintRow(row, PHASE_COPY[phase] ?? phase, state.note ?? "");
            }
          } catch {
            /* progress is a nicety — never let it break the sweep */
          }
          await sleep(450);
        }
      };
      void tick();
      return () => {
        alive = false;
      };
    }

    function progress(done: number, total: number): void {
      barFill.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
    }

    /** One repo, one direction. Also the retry path, so a failed row is never a dead end. */
    async function runRepo(row: Row): Promise<void> {
      setState(row, "active");
      row.fix.replaceChildren();
      row.node.scrollIntoView({ block: "nearest" });
      paintRow(row, mode === "pull" ? "fetching" : "pushing");
      const stop = watch(row);
      try {
        if (mode === "pull") {
          const result = await modulePost<PullResult>(`${M}/pull`, {
            repo: row.info.path,
            remote: row.info.remote,
            branch: row.info.branch,
          });
          if (result.conflict) {
            setState(row, "conflict");
            paintRow(
              row,
              "conflicted",
              `${plural(result.conflicts?.length ?? 0, "file")} need resolving`,
            );
            offerFix(row);
          } else if (result.error) {
            setState(row, "failed");
            paintRow(row, "failed", result.error);
            offerRetry(row);
          } else {
            setState(row, "done");
            paintRow(row, `↓${row.count} ${copy.done}`);
            changed += 1;
          }
        } else {
          const result = await modulePost<PushResult>(`${M}/push`, {
            repo: row.info.path,
            remote: row.info.remote,
            branch: row.info.branch,
            smart: true,
          });
          if (result.error) {
            setState(row, "failed");
            paintRow(
              row,
              "failed",
              result.rejected ? "the remote moved on — pull this repo first" : result.error,
            );
            offerRetry(row, Boolean(result.rejected));
          } else {
            setState(row, "done");
            paintRow(
              row,
              row.count < 0 ? copy.done : `↑${row.count} ${copy.done}`,
              row.info.dirty ? `${plural(row.info.dirty, "file")} still uncommitted` : "",
            );
            changed += 1;
          }
        }
      } catch (error) {
        setState(row, "failed");
        paintRow(row, "failed", String(error).replace(/^Error:\s*/, ""));
        offerRetry(row);
      } finally {
        stop();
      }
    }

    /** A push the remote refused is not a failure to shrug at — it is one pull away from working. */
    async function pullThenPush(row: Row): Promise<void> {
      setState(row, "active");
      row.fix.replaceChildren();
      paintRow(row, "fetching");
      const stop = watch(row);
      try {
        const result = await modulePost<PullResult>(`${M}/pull`, {
          repo: row.info.path,
          remote: row.info.remote,
          branch: row.info.branch,
        });
        if (result.conflict) {
          setState(row, "conflict");
          paintRow(row, "conflicted", `${plural(result.conflicts?.length ?? 0, "file")} need resolving`);
          offerFix(row);
          return;
        }
        if (result.error) {
          setState(row, "failed");
          paintRow(row, "failed", result.error);
          offerRetry(row);
          return;
        }
      } catch (error) {
        setState(row, "failed");
        paintRow(row, "failed", String(error).replace(/^Error:\s*/, ""));
        offerRetry(row);
        return;
      } finally {
        stop();
      }
      await runRepo(row);
      retally();
    }

    async function sweep(): Promise<void> {
      const todo = pending();
      running = true;
      wrap.classList.add("is-running");
      go.disabled = true;
      closeBtn.disabled = true;
      go.textContent = `${copy.running}…`;
      todo.forEach((row) => {
        setState(row, "queued");
        paintRow(row, "queued");
      });

      for (const [index, row] of todo.entries()) {
        await runRepo(row);
        progress(index + 1, todo.length);
      }

      running = false;
      wrap.classList.remove("is-running");
      closeBtn.disabled = false;
      settle();
    }

    /** The footer, recomputed from what the rows actually say — retries and resolves keep it true. */
    function retally(): void {
      const count = (state: RowState): number => rows.filter((row) => row.state === state).length;
      const parts = [`${count("done")} ${copy.done}`];
      if (count("conflict")) parts.push(`${count("conflict")} conflicted`);
      if (count("failed")) parts.push(`${count("failed")} failed`);
      summary.textContent = parts.join(" · ");
    }

    function settle(): void {
      retally();
      go.hidden = true;
      acts.querySelector(".gs-resolve-all")?.remove();
      if (rows.filter((row) => row.state === "conflict").length > 1) {
        const all = document.createElement("button");
        all.className = "gs-btn gs-resolve-all";
        all.type = "button";
        all.innerHTML = `${icon("agent")}<span>Resolve all with AI</span>`;
        all.addEventListener("click", () => void resolveAll());
        acts.prepend(all);
      }
      const done = document.createElement("button");
      done.className = "gs-btn gs-done";
      done.type = "button";
      done.textContent = "Close";
      done.addEventListener("click", close);
      acts.append(done);
      done.focus();
    }

    /* --------------------------------------------------------------- conflicts */

    /**
     * A settled row always offers its way out. A plain failure gets "Try again"; a push the
     * remote refused gets the actual fix — pull that repo, then send it — because telling someone
     * what went wrong and making them go do it elsewhere is the dead end this panel exists to kill.
     */
    function offerRetry(row: Row, rejected = false): void {
      row.fix.innerHTML = `<button class="gs-mini ghost" type="button">${
        rejected ? "Pull, then push" : "Try again"
      }</button>`;
      row.fix.querySelector("button")!.addEventListener("click", () => {
        if (rejected) return void pullThenPush(row);
        void runRepo(row).then(retally);
      });
    }

    function offerFix(row: Row): void {
      row.fix.innerHTML = `
        <button class="gs-mini" type="button" data-fix="ai">Resolve with AI</button>
        <button class="gs-mini ghost" type="button" data-fix="abort">Leave it</button>`;
      row.fix.querySelector('[data-fix="ai"]')!.addEventListener("click", () => void resolveOne(row));
      row.fix
        .querySelector('[data-fix="abort"]')!
        .addEventListener("click", () => void abort(row));
    }

    async function resolveOne(row: Row): Promise<void> {
      row.fix.replaceChildren();
      setState(row, "active");
      paintRow(row, "agent resolving");
      const stop = watch(row);
      try {
        const result = await modulePost<{ ok?: boolean; files?: string[]; error?: string }>(
          `${M}/pull/resolve`,
          { repo: row.info.path },
        );
        if (result.error) {
          setState(row, "failed");
          paintRow(row, "failed", result.error);
        } else {
          setState(row, "done");
          paintRow(row, `↓${row.count} pulled`, `AI resolved ${plural(result.files?.length ?? 0, "file")}`);
          changed += 1;
        }
      } catch (error) {
        setState(row, "failed");
        paintRow(row, "failed", String(error));
        offerRetry(row);
      } finally {
        stop();
        retally();
      }
    }

    async function resolveAll(): Promise<void> {
      const stuck = rows.filter((row) => row.state === "conflict");
      if (!stuck.length) return;
      acts.querySelector(".gs-resolve-all")?.remove();
      const stops = stuck.map((row) => {
        row.fix.replaceChildren();
        setState(row, "active");
        paintRow(row, "agent resolving");
        return watch(row);
      });
      try {
        const result = await modulePost<{
          results?: Array<{ repo: string; ok?: boolean; error?: string; files?: string[] }>;
        }>(`${M}/pull/resolve-all`, { repos: stuck.map((row) => row.info.path) });
        for (const row of stuck) {
          const own = (result.results ?? []).find((entry) => entry.repo === row.info.path);
          if (own?.ok) {
            setState(row, "done");
            paintRow(row, `↓${row.count} pulled`, `AI resolved ${plural(own.files?.length ?? 0, "file")}`);
            changed += 1;
          } else {
            setState(row, "failed");
            paintRow(row, "failed", own?.error ?? "could not be resolved — left untouched");
          }
        }
      } catch (error) {
        stuck.forEach((row) => {
          setState(row, "failed");
          paintRow(row, "failed", String(error));
        });
      } finally {
        stops.forEach((stop) => stop());
        retally();
      }
    }

    async function abort(row: Row): Promise<void> {
      row.fix.replaceChildren();
      try {
        await modulePost(`${M}/pull/abort`, { repo: row.info.path });
        setState(row, "wait");
        paintRow(row, "left alone", "rebase aborted — the repo is back where it was");
        offerRetry(row);
      } catch (error) {
        setState(row, "failed");
        paintRow(row, "failed", String(error));
        offerRetry(row);
      }
      retally();
    }

    go.addEventListener("click", () => void sweep());
    void scan();
  });
}
