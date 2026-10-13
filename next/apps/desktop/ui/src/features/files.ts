/**
 * The Work tab — an Xcode-like workspace.
 *
 * Left, the NAVIGATOR: a filter box over a lazy folder tree rooted at the project, like Xcode's
 * Project Navigator. Type in the box and the tree becomes a flat list of matching files; clear
 * it and the tree comes back with the open file revealed. ⌘P opens the same index as a picker.
 *
 * There used to be a worklist above the tree — files the agent handed back with a reason. It is
 * gone: people either prompt the agent or work by hand, and the in-between rail earned its
 * height on neither path. What the open file reaches and what reaches it still shows, as one
 * quiet RELATED row under the tab strip, because that question belongs to the file, not the turn.
 *
 * Right, the EDITOR the human writes in: a tab strip above the buffer and a status bar under
 * it. The strip follows the model every editor since VS Code taught: a single click opens a
 * PREVIEW tab (italic), and there is only ever one — the next single click reuses it. A tab is
 * KEPT the moment you do anything that says you mean it: type in it, save it, double-click it,
 * or open it from a place that implies intent (⌘-click, a Find hit, a jump from the agent).
 * ⌘1…⌘9 land on the tabs in order. Right-click a tab or a tree row for the rest.
 * The tab carries a basename (grown to `parent/name` only when two open files collide) and
 * the status bar carries the full path, the caret, whether the buffer agrees with disk, and the
 * language. Three rules hold the editor together:
 *
 *   - `open(path, line)` is called from the agent's views. A code reference is a promise that
 *     clicking it lands you on the exact line, so the jump scrolls, selects and flashes.
 *   - `markDirty(path)` is called when the AGENT wrote the file underneath the human. Two
 *     writers, one file: a clean buffer reloads silently, a dirty buffer becomes a CONFLICT
 *     the human resolves. Never clobber, never hide.
 *   - The surface is themed like Xcode's source editor — Default Dark / Default Light — and a
 *     Compartment swaps the whole pack live when the app theme toggles.
 *
 * Motion budget: NOTHING animates on arrival. The rail used to stagger in and, worse, the tab
 * carried a robot banner that opened a theater performing every edit an agent had made. Both are
 * gone. This is a reading and editing surface — text that moves while you are trying to read it
 * is a cost, and a notification on a work surface is a second inbox. What an agent did is
 * reported in ONE place, the Inbox. The only motion left is the 900ms flash that marks where a
 * `open(path, line)` jump landed, which is the jump telling you where you are.
 */

import { invoke } from "@tauri-apps/api/core";
import { icon } from "../icons";
import type { EditorState } from "@codemirror/state";
import { projectAssetUrl, projectMediaKind } from "../project-assets";
import { confirmDialog, promptDialog } from "../views/dialog";
import { modulePost } from "./modules";
import { errorText } from "../errors";
import {
  createCodeEditor,
  fileVisual,
  indentLabel,
  lineDiff,
  mountFindInProject,
  mountQuickOpen,
} from "./editor";
import type { DiffRow } from "./editor";
import type { QuickOpenList, QuickOpenTarget } from "./editor";
import {
  announceBreakpoints,
  BREAKPOINTS_EVENT,
  DEBUG_PHASE_EVENT,
  type BreakpointsChanged,
  type DebugCommand,
  type DebugPhaseChanged,
} from "./debug_events";
import "./files.css";

export type FilesHandle = {
  /** Switch project context. Close all tabs — they belong to the old project. */
  setProject(projectId: string, projectPath: string): void;
  /** Open a file (project-relative path) and optionally land on a 1-indexed line. */
  open(path: string, line?: number): Promise<void>;
  /** Close the file the human is currently looking at. Returns whether there was one to close. */
  closeActiveTab(): boolean;
  /** ⌘1…⌘9 — show the file in that slot of the strip. False when the slot is empty. */
  activateSlot(slot: number): boolean;
  /** Create a safe text draft if absent, then open it in the same editor as project files. */
  openDocument(path: string, draft?: string): Promise<void>;
  /** Persist the named open buffer (if dirty) and return its exact contents. */
  finishDocument(path: string): Promise<string>;
  /** The AGENT just wrote this file on disk. Reconcile the buffer. */
  markDirty(path: string): void;
};

/* --------------------------------------------------------------- helpers */

const basename = (path: string): string => path.split("/").pop() || path;

/** "lib/views/login.dart" -> "lib/views/". The empty string for a file at the root. */
function dirname(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut + 1);
}

/** A `ref` is "path:line". Only the line matters here — the path we already have. */
function lineOf(ref: string | null | undefined): number | undefined {
  if (!ref) return undefined;
  const match = /:(\d+)\s*$/.exec(ref);
  return match ? Number(match[1]) : undefined;
}

/**
 * The agent speaks in project-relative paths; a `file_changed` hook may speak absolute. Same
 * file, two names. Neither side should have to care.
 */
function sameFile(a: string, b: string): boolean {
  if (a === b) return true;
  return a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

/* ---------------------------------------------------------------- the tree */

type DirEntry = { name: string; is_dir: boolean };

type FileRelation = {
  path: string;
  line: number;
  direction: "incoming" | "outgoing";
  detail: string;
};

type SymbolLocation = {
  path: string;
  line: number;
  detail: string;
};

/** One file the open one reaches, or that reaches it. `why` is the import or type that links them. */
type RailFile = {
  path: string;
  why: string;
  /** "path:line" — where the link is made. */
  ref: string;
  direction: "incoming" | "outgoing" | "both";
};

type TreeNode = {
  /** Project-relative path — parent path + "/" + name. */
  path: string;
  name: string;
  isDir: boolean;
  depth: number;
  expanded: boolean;
  /** Children fetched once and cached, so re-expand is instant. Files are born loaded. */
  loaded: boolean;
  children: TreeNode[];
  /** A filter hit: one row standing for a full path, outside the tree's nesting. */
  flat?: boolean;
};

/* ------------------------------------------------------------------- tabs */

type MediaKind = "image" | "audio" | "video" | "pdf" | "binary";

/** A file open in the code editor. */
type TextTab = {
  kind: "text";
  path: string;
  name: string;
  /** Authoritative document state. Kept in sync with the view while this tab is active. */
  state: EditorState;
  /** The document as it last agreed with disk. Dirty is `state.doc` diverging from this. */
  saved: EditorState["doc"];
  /**
   * The file as HEAD has it. `null` while it is still being fetched, `""` for a file git does
   * not know — an untracked file has no committed version, so every line of it is new.
   */
  head: string | null;
  /** Agent wrote the file while the human had unsaved edits. Held until the human decides. */
  conflict: boolean;
  /** What the agent put on disk, parked while the conflict is open. */
  incoming: string | null;
  scrollTop: number;
  /** A kept slot. Opening another file beside it never replaces it. */
  pinned: boolean;
};

/** A file shown as-is: an image, an audio/video player, a PDF, or a "can't preview" card. */
type MediaTab = {
  kind: "media";
  path: string;
  name: string;
  media: MediaKind;
  /** Only for `media === "binary"`: why there is nothing to render. */
  note: string;
  pinned: boolean;
};

type Tab = TextTab | MediaTab;

/** Which non-text viewer a path wants, or null when it should open in the code editor. */
function mediaKind(path: string): Exclude<MediaKind, "binary"> | null {
  return projectMediaKind(path);
}

/** Build the viewer element for a media tab. `src` is empty for the binary placeholder. */
function buildMedia(kind: MediaKind, src: string, note: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = `ed-media-inner is-${kind}`;
  if (kind === "image") {
    const img = document.createElement("img");
    img.src = src;
    img.alt = "";
    wrap.append(img);
  } else if (kind === "audio") {
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "metadata";
    audio.src = src;
    wrap.append(audio);
  } else if (kind === "video") {
    const video = document.createElement("video");
    video.controls = true;
    video.preload = "metadata";
    video.src = src;
    wrap.append(video);
  } else if (kind === "pdf") {
    const frame = document.createElement("iframe");
    frame.className = "ed-pdf";
    frame.src = src;
    wrap.append(frame);
  } else {
    const card = document.createElement("div");
    card.className = "ed-media-note";
    const title = document.createElement("b");
    title.textContent = "No preview available";
    const detail = document.createElement("span");
    detail.textContent = note || "This file can't be shown in the editor.";
    card.append(title, detail);
    wrap.append(card);
  }
  return wrap;
}

/** Filter hits painted at once. Past this the answer is another letter, not more scrolling. */
const MAX_FILTER_HITS = 200;

/* Git's own letters, the ones every editor's tree uses. A folder gets a dot, because the only
   honest summary of "three modified and one deleted under here" is "look inside". */
const GIT_MARKS: Record<string, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  conflict: "!",
  nested: "•",
};

const GIT_TITLES: Record<string, string> = {
  modified: "modified",
  added: "staged as new",
  deleted: "deleted",
  renamed: "renamed",
  untracked: "new, untracked",
  conflict: "conflicted",
  nested: "something inside this folder changed",
};

const NAV_WIDTH_KEY = "panel.files.nav-width";
const NAV_MIN = 180;
const NAV_MAX = 480;

/**
 * What Work asks the rest of the app for. Only the debugger: a breakpoint is set HERE, the
 * program stops HERE, and the human should not have to leave to press Step Over. Work never
 * owns a session — it sends a command and reads the phase Debug announces back.
 */
export type FilesHooks = {
  /** Start a session on the selected project, loading the Debug module if it is not up yet. */
  startDebug?(): void;
  /** Drive the live session. Same commands the Debug toolbar sends. */
  debugCommand?(command: DebugCommand): void;
  /** Resolve an expression in the paused frame, for the editor's hover. Null when it cannot. */
  evaluate?(expression: string): Promise<string | null>;
};

export function mountFiles(host: HTMLElement, hooks: FilesHooks = {}): FilesHandle {
  host.classList.add("files-root");
  host.replaceChildren();

  /* ------------------------------------------------------------- chrome */

  const nav = document.createElement("aside");
  nav.className = "nav";
  nav.setAttribute("aria-label", "Navigator");

  /* The filter is the navigator's head. Typing narrows the tree to a flat list of matching
     files; clearing brings the tree back. A label saying FILES over a file tree said nothing. */
  const filterWrap = document.createElement("div");
  filterWrap.className = "ft-filter";
  const filterInput = document.createElement("input");
  filterInput.className = "ft-filter-input";
  filterInput.type = "search";
  filterInput.autocomplete = "off";
  filterInput.spellcheck = false;
  filterInput.placeholder = "Filter files";
  filterInput.setAttribute("aria-label", "Filter project files");
  filterWrap.append(filterInput);

  // FILES — the project tree, lazy-loaded folder by folder.
  const treeSec = document.createElement("section");
  treeSec.className = "ft";
  treeSec.setAttribute("aria-label", "Project files");

  const treeEl = document.createElement("div");
  treeEl.className = "ft-tree";
  treeEl.tabIndex = 0;
  treeEl.setAttribute("role", "tree");

  const navHead = document.createElement("header");
  navHead.className = "ft-head";
  navHead.innerHTML = `<img src="/assets/panel-wolf-mark.webp" alt="" width="26" height="26"><span><small>EXPLORER</small><b class="ft-project">Project files</b></span><button type="button" class="ed-tool" data-work-action="new" title="New file in project root" aria-label="New file">＋</button>`;
  treeSec.append(navHead, filterWrap, treeEl);

  const grip = document.createElement("div");
  grip.className = "nav-grip";
  grip.setAttribute("aria-hidden", "true");

  nav.append(treeSec, grip);

  const editor = document.createElement("div");
  editor.className = "ed";

  const toolbar = document.createElement("div");
  toolbar.className = "ed-toolbar";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Coding tools");
  toolbar.innerHTML = `
    <button class="ed-tool" type="button" data-work-action="navigator" aria-label="Toggle file explorer" title="Toggle file explorer" aria-expanded="true">${icon("panel-left")}</button>
    <button class="ed-tool" type="button" data-work-action="open">Open file <kbd>⌘P</kbd></button>
    <button class="ed-tool" type="button" data-work-action="search">Search <kbd>⌘⇧F</kbd></button>
    <span class="ed-tool-spacer"></span>
    <button class="ed-tool" type="button" data-work-action="wrap" aria-pressed="false">Wrap</button>
    <button class="ed-tool ed-tool-save" type="button" data-work-action="save">Save <kbd>⌘S</kbd></button>`;
  const saveButton = toolbar.querySelector<HTMLButtonElement>('[data-work-action="save"]')!;
  const wrapButton = toolbar.querySelector<HTMLButtonElement>('[data-work-action="wrap"]')!;
  const navigatorButton = toolbar.querySelector<HTMLButtonElement>('[data-work-action="navigator"]')!;

  const tabStrip = document.createElement("div");
  tabStrip.className = "ed-tabs";
  tabStrip.setAttribute("role", "tablist");

  /* ‹ › at the head of the strip. A jump — a Related chip, a ⌘-click, a Find hit — is a
     promise that you can come back, and a promise needs a button. ⌃⌘← / ⌃⌘→, Xcode's keys. */
  const trailNav = document.createElement("div");
  trailNav.className = "ed-trail";
  const backButton = document.createElement("button");
  backButton.type = "button";
  backButton.className = "ed-trail-btn";
  backButton.textContent = "‹";
  backButton.title = "Back (⌃⌘←)";
  backButton.setAttribute("aria-label", "Back");
  const forwardButton = document.createElement("button");
  forwardButton.type = "button";
  forwardButton.className = "ed-trail-btn";
  forwardButton.textContent = "›";
  forwardButton.title = "Forward (⌃⌘→)";
  forwardButton.setAttribute("aria-label", "Forward");
  trailNav.append(backButton, forwardButton);

  /*
   * The debug bar.
   *
   * Debugging used to cost a tab switch per step: arm a breakpoint here, leave for Debug to
   * press Start, get thrown back here when it paused, leave again to step. The controls belong
   * where the code is. This bar owns no session state — it mirrors the phase Debug announces
   * and sends commands straight back to it, so the two toolbars can never disagree.
   *
   * It is invisible until the project has a debug profile, and it stays a single quiet strip:
   * Work is a reading surface, and a permanent row of grey buttons over the tabs is a tax on
   * every file you ever open.
   */
  const debugBar = document.createElement("div");
  debugBar.className = "ed-debug";
  debugBar.hidden = true;
  const debugPhaseEl = document.createElement("span");
  debugPhaseEl.className = "ed-debug-phase";
  const debugDot = document.createElement("i");
  const debugPhaseText = document.createElement("b");
  debugPhaseEl.append(debugDot, debugPhaseText);
  const debugStart = document.createElement("button");
  debugStart.type = "button";
  debugStart.className = "ed-debug-start";
  debugStart.textContent = "Start";
  debugStart.title = "Start debugging this project";
  const debugControls = document.createElement("div");
  debugControls.className = "ed-debug-controls";
  const debugButton = (glyph: string, title: string, command: DebugCommand): HTMLButtonElement => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ed-debug-act";
    button.textContent = glyph;
    button.title = title;
    button.dataset.command = command;
    debugControls.append(button);
    return button;
  };
  // Same glyphs and same order as the Debug toolbar — a control you learned there is the same
  // control here.
  const debugResume = debugButton("▶", "Continue", "continue");
  const debugPause = debugButton("Ⅱ", "Pause", "pause");
  const debugOver = debugButton("↷", "Step over", "next");
  const debugIn = debugButton("↓", "Step into", "stepIn");
  const debugOut = debugButton("↑", "Step out", "stepOut");
  debugButton("■", "Stop", "stop");
  const debugWhere = document.createElement("span");
  debugWhere.className = "ed-debug-where";
  debugBar.append(debugPhaseEl, debugStart, debugControls, debugWhere);

  debugStart.addEventListener("click", () => hooks.startDebug?.());
  debugControls.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-command]");
    if (button) hooks.debugCommand?.(button.dataset.command as DebugCommand);
  });

  /* RELATED — what the open file reaches and what reaches it. It used to be a whole row of
     chips under the tabs, on every file, mostly saying "nothing". Now it is one count in the
     status bar; the click opens the same ⌘⇧O picker, which is where the list reads best. */
  const relatedButton = document.createElement("button");
  relatedButton.type = "button";
  relatedButton.className = "ed-stat ed-stat-act ed-status-related";
  relatedButton.hidden = true;
  relatedButton.title = "Related files (⌘⇧O)";

  const conflictBar = document.createElement("div");
  conflictBar.className = "ed-conflict";
  conflictBar.hidden = true;

  const surface = document.createElement("div");
  surface.className = "ed-surface";

  const mediaEl = document.createElement("div");
  mediaEl.className = "ed-media";
  mediaEl.hidden = true;

  /* Nothing open. The pane used to say one grey sentence, which taught nobody anything —
     so the resting state is where Work's keyboard lives. ⌘⇧O and ⌘-click have no other
     surface that mentions them. */
  const empty = document.createElement("div");
  empty.className = "ed-empty";
  const emptyCard = document.createElement("div");
  emptyCard.className = "ed-empty-card";
  emptyCard.innerHTML = `
    <div class="ed-welcome-hero">
      <img class="ed-wolf-art" src="/assets/panel-wolf-coding.webp" alt="" width="1536" height="1024" decoding="async">
      <div class="ed-welcome-copy">
        <span class="ed-welcome-label">PANEL / CODE</span>
        <h2 class="ed-empty-title">Make your next change.</h2>
        <p class="ed-empty-lede">Find the file. Follow the code. Keep your place.</p>
        <span class="ed-welcome-project"></span>
      </div>
    </div>
    <div class="ed-start-actions">
      <button type="button" data-work-action="open">${icon("code")}<span><b>Open a file</b><small>Jump anywhere in this project</small></span><kbd>⌘P</kbd></button>
      <button type="button" data-work-action="search">${icon("log")}<span><b>Search the code</b><small>Find text across project files</small></span><kbd>⌘⇧F</kbd></button>
      <button type="button" data-work-action="new">${icon("work")}<span><b>Create a file</b><small>Start in the project root</small></span><span aria-hidden="true">＋</span></button>
    </div>
    <section class="ed-recent" hidden aria-label="Recently visited files"><h3>Pick up where you left off</h3><div class="ed-recent-files"></div></section>
    <div class="ed-welcome-notes"><span><kbd>⌘</kbd> click a symbol to find its definition</span><span><kbd>⌘⇧O</kbd> explore related files</span></div>`;
  empty.append(emptyCard);

  /* The status bar. An editor without one reads as a text box: you cannot say where you are,
     what language is lit, or whether the buffer agrees with disk. Left is the full path,
     because the tab only carries a basename. Right is position, then state. */
  const status = document.createElement("footer");
  status.className = "ed-status";
  status.hidden = true;
  const statusPath = document.createElement("span");
  statusPath.className = "ed-status-path";
  const statusMeta = document.createElement("span");
  statusMeta.className = "ed-status-meta";
  status.append(statusPath, relatedButton, statusMeta);

  /* The conflict diff. It shares the drawer row with find-in-project — you are never doing both
     at once, and giving the comparison the full width of the pane is what makes it readable. */
  const diffPanel = document.createElement("section");
  diffPanel.className = "ed-diff";
  diffPanel.hidden = true;
  diffPanel.setAttribute("aria-label", "What the agent changed");

  const toast = document.createElement("div");
  toast.className = "ed-toast";
  toast.hidden = true;

  editor.append(debugBar, tabStrip, toolbar, conflictBar, surface, mediaEl, empty, diffPanel, status, toast);
  host.append(nav, editor);



  /* -------------------------------------------------------------- state */

  /* One open workspace per project. Panel's whole shape is "selecting a project changes what
     you SEE, never what is RUNNING" — and dropping every buffer on a project switch broke that
     promise for the one surface where it costs the most. Come back and your files are where you
     left them, on the line you left them on. */
  /** One place you were: a file and the line the caret was on when you left it. */
  type Spot = { path: string; line: number };
  type Workspace = {
    tabs: Map<string, Tab>;
    order: string[];
    activePath: string | null;
    /** Where you have been, oldest first, and where in it you stand. ⌃⌘← walks it back. */
    trail: Spot[];
    trailAt: number;
  };
  const blankWorkspace = (): Workspace => ({
    tabs: new Map(),
    order: [],
    activePath: null,
    trail: [],
    trailAt: -1,
  });
  const workspaces = new Map<string, Workspace>();
  /** Most-recently-used first. The eviction order, and nothing else. */
  const recent: string[] = [];

  let current: Workspace = blankWorkspace();
  let tabs = current.tabs;
  let order = current.order;
  let activePath: string | null = null;
  let project: string | null = null;
  let projectPath = "";
  /** Semantic relationships for the open file. */
  const relationCache = new Map<string, RailFile[]>();
  let relationships: RailFile[] = [];
  let relationshipPath: string | null = null;
  let relationshipsLoading = false;
  let relationshipRequest = 0;
  let toastTimer = 0;
  /** Persisted by Rust under Panel's user state. Repositories stay untouched. */
  let breakpoints = new Map<string, Set<number>>();
  const breakpointSaves = new Map<string, number>();

  /** Project-relative path -> git state. Folders are not in here; they are rolled up on render. */
  let gitStates = new Map<string, string>();
  /** Every folder with a dirty descendant, so a collapsed tree still shows where to look. */
  let gitFolders = new Set<string>();

  let treeRoot: TreeNode[] = [];
  /** The nodes currently rendered, top to bottom — parallel to `treeEl.children`. */
  let treeVisible: TreeNode[] = [];
  let cursorNode: TreeNode | null = null;
  /** What the filter box says, trimmed. Empty means the tree. */
  let treeQuery = "";
  /** Every file in the project, relative. Fetched once per project; dropped when the agent
   *  writes, because it may have created a file. */
  let fileIndex: string[] | null = null;
  let fileIndexPromise: Promise<string[]> | null = null;

  /* ------------------------------------------------------------ the editor */

  /* The shared editor. Everything about how text looks and behaves — palette, gutters, minimap,
     keymap, zoom, jump-and-flash — lives in `./editor` and is identical here and in every other
     Panel editing surface. This pane only owns what surrounds the buffer: tabs and conflicts. */
  let code: ReturnType<typeof createCodeEditor>;
  code = createCodeEditor({
    parent: surface,
    /* The Work tab starts life inside a `display:none` container (the portfolio lands on Home,
       and the per-project chrome opens on Terminals, not Files), so the editor watches the
       whole pane and re-measures the instant it is revealed. */
    visibilityHost: editor,
    onSave: () => void save(),
    changeBars: true,
    onStageHunk: async ({ path, line }) => {
      const tab = findTab(path);
      if (!tab || tab.kind !== "text") throw new Error("This file is no longer open.");
      if (tab.conflict) throw new Error("Resolve the disk conflict before staging.");
      await saveTab(tab);
      const result = await modulePost<{ error?: string }>("/m/git-manager/stage-hunk", {
        repo: projectPath,
        path: tab.path,
        line,
      });
      if (result.error) throw new Error(result.error);
      if (project) void refreshGit(project);
    },
    onHunkError: (error) => fail(`Could not stage hunk — ${error}`),
    /* Hovering a name while the program is paused answers "what is this right now". Silent at
       every other moment — a tooltip that fires on a resting file is noise on a reading surface. */
    hoverValue: (expression) =>
      debugPhase?.phase === "paused" && hooks.evaluate
        ? hooks.evaluate(expression)
        : Promise.resolve(null),
    breakpoints: (path) => [...(breakpoints.get(path) ?? [])],
    onToggleBreakpoint: (path, line) => {
      if (!project) return;
      const before = new Set(breakpoints.get(path) ?? []);
      const next = new Set(before);
      if (next.has(line)) next.delete(line);
      else next.add(line);
      if (next.size) breakpoints.set(path, next);
      else breakpoints.delete(path);
      if (activePath === path) code.setBreakpoints([...next]);
      const owner = project;
      announceBreakpoints({ project: owner, path, lines: [...next] });
      void invoke("debug_set_breakpoints", {
        project: owner,
        path,
        lines: [...next].sort((a, b) => a - b),
      }).catch((error) => {
        if (project !== owner) return;
        if (before.size) breakpoints.set(path, before);
        else breakpoints.delete(path);
        if (activePath === path) code.setBreakpoints([...before]);
        announceBreakpoints({ project: owner, path, lines: [...before] });
        fail(`Could not save breakpoint — ${message(error)}`);
      });
    },
    onUpdate: (update) => {
      const tab = activePath ? tabs.get(activePath) : null;
      if (!tab || tab.kind !== "text") return;
      tab.state = update.state;
      if (update.docChanged) {
        // Typing in a preview is the clearest "I mean this file" there is. A reload from disk
        // is not typing, so it must not keep a tab the human only glanced at.
        if (!tab.pinned && !reloading && isDirty(tab)) tab.pinned = true;
        const armed = breakpoints.get(tab.path);
        if (armed?.size) {
          const moved = new Set(
            [...armed].map((line) => {
              const position = update.startState.doc.line(
                Math.max(1, Math.min(line, update.startState.doc.lines)),
              ).from;
              return update.state.doc.lineAt(update.changes.mapPos(position, 1)).number;
            }),
          );
          breakpoints.set(tab.path, moved);
          queueBreakpointSave(tab.path, moved);
        }
        // One class flip on one tab. Rebuilding the strip on every keystroke was the single
        // largest cost of typing here — it re-queried the whole tree for the open row too.
        paintTabState(tab);
        queueChanges();
      }
      if (update.docChanged || update.selectionSet) renderStatusMeta();
    },
    /* Tabs park their states off-screen. Theme toggles and zoom reach them here, so switching
       back to a parked tab can never resurrect the old palette or the old size. */
    onReconfigure: (apply) => {
      // Every workspace, not just the open one. A buffer parked under another project must not
      // come back wearing last week's palette.
      for (const workspace of workspaces.values()) {
        for (const tab of workspace.tabs.values()) {
          if (tab.kind !== "text") continue; // media tabs carry no editor state to reconfigure
          if (workspace === current && activePath !== null && tab.path === activePath) continue;
          tab.state = apply(tab.state);
        }
      }
    },
  });
  const view = code.view;
  const makeState = (path: string, text: string): EditorState => code.createState(path, text);

  const isDirty = (tab: TextTab): boolean => !tab.state.doc.eq(tab.saved);
  /** Set while the buffer is being overwritten from disk, so the change is not read as typing. */
  let reloading = false;

  function queueBreakpointSave(path: string, lines: Set<number>): void {
    if (!project) return;
    const owner = project;
    const key = `${owner}:${path}`;
    window.clearTimeout(breakpointSaves.get(key));
    breakpointSaves.set(
      key,
      window.setTimeout(() => {
        breakpointSaves.delete(key);
        void invoke("debug_set_breakpoints", {
          project: owner,
          path,
          lines: [...lines].sort((a, b) => a - b),
        }).catch((error) => {
          if (project === owner) fail(`Could not move breakpoint — ${message(error)}`);
        });
        announceBreakpoints({ project: owner, path, lines: [...lines] });
      }, 240),
    );
  }

  window.addEventListener(BREAKPOINTS_EVENT, (event) => {
    const detail = (event as CustomEvent<BreakpointsChanged>).detail;
    if (!detail || detail.project !== project) return;
    if (detail.lines.length) breakpoints.set(detail.path, new Set(detail.lines));
    else breakpoints.delete(detail.path);
    if (activePath === detail.path) code.setBreakpoints(detail.lines);
  });

  /* ---------------------------------------------------------------- debug */

  /** Where the program is stopped, if it is. Survives a tab switch — see `activate`. */
  let execAt: { path: string; line: number } | null = null;
  let debugPhase: DebugPhaseChanged | null = null;

  const PHASE_WORD: Record<string, string> = {
    idle: "Ready",
    starting: "Starting",
    running: "Running",
    paused: "Paused",
    ended: "Stopped",
    error: "Debug failed",
  };

  function renderDebugBar(): void {
    const phase = debugPhase;
    // No profile, no bar. An empty toolbar over every file is a tax on reading.
    debugBar.hidden = !phase || (!phase.canStart && phase.phase === "idle");
    if (!phase) return;
    debugBar.dataset.phase = phase.phase;
    debugPhaseText.textContent = phase.error || PHASE_WORD[phase.phase] || phase.phase;
    const live = phase.phase === "starting" || phase.phase === "running" || phase.phase === "paused";
    debugStart.hidden = live;
    debugControls.hidden = !live;
    debugResume.disabled = phase.phase !== "paused";
    debugPause.disabled = phase.phase !== "running";
    debugOver.disabled = phase.phase !== "paused";
    debugIn.disabled = phase.phase !== "paused";
    debugOut.disabled = phase.phase !== "paused";
    debugWhere.textContent = execAt ? `${basename(execAt.path)}:${execAt.line}` : "";
  }

  /** Put the amber band on the stopped line, but only in the buffer that owns it. */
  function syncExecLine(): void {
    if (!activePath) return;
    const tab = tabs.get(activePath);
    if (!tab || tab.kind !== "text") return;
    code.setExecLine(execAt && sameFile(execAt.path, activePath) ? execAt.line : null);
  }

  window.addEventListener(DEBUG_PHASE_EVENT, (event) => {
    const detail = (event as CustomEvent<DebugPhaseChanged>).detail;
    if (!detail || detail.project !== project) return;
    debugPhase = detail;
    const moved =
      detail.at?.path !== execAt?.path || detail.at?.line !== execAt?.line;
    execAt = detail.at;
    renderDebugBar();
    if (!moved) return;
    // The whole point of the integration: a stop OPENS the line it stopped on. Debug announces
    // this once per real move, so this cannot fight the human for the scroll position.
    if (execAt) void openFile(execAt.path, execAt.line);
    else syncExecLine();
  });

  function fail(text: string): void {
    toast.textContent = text;
    toast.hidden = false;
    toast.classList.add("is-on");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toast.classList.remove("is-on");
      toastTimer = window.setTimeout(() => {
        toast.hidden = true;
      }, 240);
    }, 4200);
  }

  const message = (error: unknown): string => errorText(error, "Panel hit a bug here. The details are in the console.");

  /* ------------------------------------------------------- code navigation */

  async function refreshRelationships(path: string, force = false): Promise<RailFile[]> {
    if (!project) return [];
    const cached = relationCache.get(path);
    relationshipPath = path;
    if (cached && !force) {
      relationships = cached;
      relationshipsLoading = false;
      renderRelated();
      return cached;
    }
    const request = ++relationshipRequest;
    const owner = project;
    relationships = [];
    relationshipsLoading = true;
    renderRelated();
    try {
      const found = await invoke<FileRelation[]>("file_relationships", {
        project: owner,
        path,
      });
      const files: RailFile[] = [];
      for (const relation of found) {
        const existing = files.find((file) => sameFile(file.path, relation.path));
        if (existing) {
          if (existing.why !== relation.detail) existing.why = `${existing.why} · ${relation.detail}`;
          if (existing.direction !== relation.direction) existing.direction = "both";
          continue;
        }
        files.push({
          path: relation.path,
          why: relation.detail,
          ref: `${relation.path}:${Math.max(1, relation.line)}`,
          direction: relation.direction,
        });
      }
      relationCache.set(path, files);
      if (request === relationshipRequest && project === owner && activePath === path) {
        relationships = files;
        relationshipsLoading = false;
        renderRelated();
      }
      return files;
    } catch (error) {
      if (request === relationshipRequest && activePath === path) {
        relationships = [];
        relationshipsLoading = false;
        renderRelated();
        fail(`Could not inspect file relationships — ${message(error)}`);
      }
      return [];
    }
  }

  const toTarget = (file: RailFile): QuickOpenTarget => ({
    path: file.path,
    line: lineOf(file.ref),
    detail: file.why,
  });

  /* ------------------------------------------------------- the file index */

  function loadFileIndex(): Promise<string[]> {
    if (fileIndex) return Promise.resolve(fileIndex);
    if (fileIndexPromise) return fileIndexPromise;
    const owner = project;
    if (!owner) return Promise.resolve([]);
    const request = invoke<string[]>("project_files", { project: owner })
      .then((paths) => {
        if (project !== owner) return [];
        fileIndex = paths;
        return paths;
      })
      .catch(() => [] as string[])
      .finally(() => {
        if (fileIndexPromise === request) fileIndexPromise = null;
      });
    fileIndexPromise = request;
    return request;
  }

  const fileTargets = (paths: string[]): QuickOpenTarget[] => paths.map((path) => ({ path }));

  /** The ⌘P list: the whole project, from cache in the same frame, or behind one fetch. */
  const anyFileList = (): QuickOpenList => ({
    title: "Open file",
    targets: fileTargets(fileIndex ?? []),
    pending: fileIndex ? undefined : loadFileIndex().then(fileTargets),
  });

  /* ⌘P — any file in the project. The one Xcode key nobody has to learn. */
  const openAny = mountQuickOpen({
    host,
    shortcut: { key: "p", shift: false },
    placeholder: "Type a file name",
    emptyText: "No file matches.",
    restoreFocus: () => view.focus(),
    onEmpty: () => fail("No files found in this project."),
    onChoose: (target) => void openFile(target.path, target.line),
    load: anyFileList,
  });

  relatedButton.addEventListener("click", () => void quickOpen.open());

  /* ⌘⇧O — the files related to the open one: what it reaches and what reaches it. Working that
     out means asking Rust to read the file, which is not free — so the panel opens on the cache
     in the same frame and the scan, when it is needed, lands behind it. With nothing open there
     is no relationship to show, so it falls back to the whole project. */
  const quickOpen = mountQuickOpen({
    host,
    emptyText: "No matching related file.",
    restoreFocus: () => view.focus(),
    onEmpty: () => fail("No related files found for the current file."),
    onChoose: (target) => void openFile(target.path, target.line),
    load: () => {
      if (!activePath) return anyFileList();
      const path = activePath;
      const fresh = relationshipPath === path && !relationshipsLoading;
      return {
        title: `Related to ${basename(path)}`,
        targets: (fresh ? relationships : relationCache.get(path) ?? []).map(toTarget),
        pending: fresh
          ? undefined
          : refreshRelationships(path).then((files) => files.map(toTarget)),
      };
    },
  });

  /* Find in project. It appends itself to `editor`, so it lands in the grid row reserved for it
     between the buffer and the status bar. Scoped to the selected project, read fresh on every
     query — a result from the repository you just left must never be clickable. */
  const find = mountFindInProject({
    host: editor,
    project: () => project,
    onChoose: (path, line) => void openFile(path, line),
    seed: () => {
      const range = view.state.selection.main;
      return range.empty ? "" : view.state.sliceDoc(range.from, range.to);
    },
    restoreFocus: () => view.focus(),
  });

  function setNavigatorVisible(shown: boolean): void {
    nav.hidden = !shown;
    host.classList.toggle("is-focused", !shown);
    navigatorButton.setAttribute("aria-expanded", String(shown));
    navigatorButton.title = shown ? "Hide file explorer" : "Show file explorer";
    try { localStorage.setItem("panel.files.navigator-hidden", shown ? "0" : "1"); } catch { /* session preference still applies */ }
    view.requestMeasure();
  }
  try {
    if (localStorage.getItem("panel.files.navigator-hidden") === "1") setNavigatorVisible(false);
  } catch { /* default to the explorer */ }

  host.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-work-action]");
    if (!button || button.disabled) return;
    switch (button.dataset.workAction) {
      case "open": void openAny.open(); break;
      case "search": closeDiff(); find.open(); break;
      case "new": void newEntry(null, false); break;
      case "navigator": setNavigatorVisible(nav.hidden === true); break;
      case "wrap": code.setWrap(!code.wrapped()); renderStatusMeta(); break;
      case "save": {
        const tab = activePath ? tabs.get(activePath) : null;
        if (tab?.kind === "text" && tab.conflict) openDiff(tab);
        else void save();
        break;
      }
    }
  });

  function renderWelcome(): void {
    const name = basename(projectPath) || "Your project";
    navHead.querySelector<HTMLElement>(".ft-project")!.textContent = name;
    navHead.title = projectPath;
    emptyCard.querySelector<HTMLElement>(".ed-welcome-project")!.textContent = name;
    const recentSection = emptyCard.querySelector<HTMLElement>(".ed-recent")!;
    const list = emptyCard.querySelector<HTMLElement>(".ed-recent-files")!;
    list.replaceChildren();
    const visited = new Set<string>();
    for (const spot of [...current.trail].reverse()) {
      if (visited.has(spot.path)) continue;
      visited.add(spot.path);
      const button = document.createElement("button");
      button.type = "button";
      button.title = spot.path;
      const name = document.createElement("b");
      name.textContent = basename(spot.path);
      const path = document.createElement("span");
      path.textContent = dirname(spot.path) || "Project root";
      button.append(name, path);
      button.addEventListener("click", () => void openFile(spot.path, spot.line, true));
      list.append(button);
      if (visited.size === 4) break;
    }
    recentSection.hidden = !visited.size;
  }

  function renderTools(): void {
    const tab = activePath ? tabs.get(activePath) : null;
    const text = tab?.kind === "text" ? tab : null;
    saveButton.disabled = !text || (!isDirty(text) && !text.conflict);
    const label = text?.conflict ? "Review conflict" : `Save <kbd>⌘S</kbd>`;
    if (saveButton.innerHTML !== label) saveButton.innerHTML = label;
    saveButton.classList.toggle("has-changes", !!text && isDirty(text));
    wrapButton.disabled = !text;
    wrapButton.setAttribute("aria-pressed", String(!!text && code.wrapped()));
  }

  function symbolAt(position: number): string | null {
    const line = view.state.doc.lineAt(position);
    const offset = position - line.from;
    let from = offset;
    let to = offset;
    while (from > 0 && /[\w$]/u.test(line.text[from - 1])) from -= 1;
    while (to < line.text.length && /[\w$]/u.test(line.text[to])) to += 1;
    const symbol = line.text.slice(from, to);
    return /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(symbol) ? symbol : null;
  }

  async function openSymbol(symbol: string, sourcePath: string): Promise<void> {
    if (!project) return;
    try {
      const locations = await invoke<SymbolLocation[]>("symbol_locations", {
        project,
        path: sourcePath,
        symbol,
      });
      if (!locations.length) {
        fail(`No definition found for ${symbol}.`);
      } else if (locations.length === 1) {
        await openFile(locations[0].path, locations[0].line);
      } else {
        void quickOpen.openWith({
          title: `Definitions of ${symbol}`,
          targets: locations.map((location) => ({
            path: location.path,
            line: location.line,
            detail: location.detail,
          })),
        });
      }
    } catch (error) {
      fail(`Could not find ${symbol} — ${message(error)}`);
    }
  }

  surface.addEventListener(
    "mousedown",
    (event) => {
      if (!event.metaKey || event.button !== 0 || !activePath) return;
      const tab = tabs.get(activePath);
      if (!tab || tab.kind !== "text") return;
      const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (position === null) return;
      const symbol = symbolAt(position);
      if (!symbol) return;
      event.preventDefault();
      event.stopPropagation();
      void openSymbol(symbol, tab.path);
    },
    true,
  );


  /* -------------------------------------------------------------- related */

  /** One count in the status bar. "Looking…" while the scan runs, hidden with nothing open. */
  function renderRelated(): void {
    relatedButton.hidden = activePath === null;
    if (activePath === null) return;
    const count = relationships.length;
    relatedButton.textContent = count
      ? `${count} related`
      : relationshipsLoading
        ? "Looking…"
        : "No related";
    relatedButton.disabled = !count;
  }

  /* --------------------------------------------------------------- filter */

  /** Name hits first, then path hits, then letters-in-order — `prodsp` still finds product_spine. */
  function filterPaths(paths: string[], query: string): string[] {
    const needle = query.toLocaleLowerCase();
    const byName: string[] = [];
    const byPath: string[] = [];
    const loose: string[] = [];
    for (const path of paths) {
      const lower = path.toLocaleLowerCase();
      if (basename(lower).includes(needle)) byName.push(path);
      else if (lower.includes(needle)) byPath.push(path);
      else {
        let cursor = 0;
        for (const character of lower) if (character === needle[cursor]) cursor += 1;
        if (cursor === needle.length) loose.push(path);
      }
    }
    return [...byName, ...byPath, ...loose];
  }

  let filterTimer = 0;
  filterInput.addEventListener("input", () => {
    window.clearTimeout(filterTimer);
    filterTimer = window.setTimeout(() => {
      const next = filterInput.value.trim();
      const cleared = treeQuery !== "" && next === "";
      treeQuery = next;
      cursorNode = null;
      if (treeQuery && !fileIndex) {
        void loadFileIndex().then(() => {
          if (treeQuery) renderTree();
        });
      }
      renderTree();
      if (cleared && activePath) void revealInTree(activePath);
    }, 60);
  });
  filterInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (!filterInput.value) return;
      filterInput.value = "";
      treeQuery = "";
      cursorNode = null;
      renderTree();
      if (activePath) void revealInTree(activePath);
    } else if (event.key === "ArrowDown" || event.key === "Enter") {
      const first = treeVisible[0];
      if (!first) return;
      cursorNode = first;
      paintCursor();
      if (event.key === "Enter") {
        if (!first.isDir) void openFile(first.path);
      } else {
        treeEl.focus();
      }
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  });

  /**
   * Open every folder above `path` and scroll its row into view. The tree answers "where am I"
   * on its own; the human never hunts for the file they are already reading.
   */
  async function revealInTree(path: string): Promise<void> {
    if (treeQuery || !project) return;
    const owner = project;
    const parts = path.split("/");
    let level = treeRoot;
    let changed = false;
    for (let depth = 0; depth < parts.length - 1; depth++) {
      const node = level.find((candidate) => candidate.isDir && candidate.name === parts[depth]);
      if (!node) return;
      if (!node.loaded) {
        await loadChildren(node);
        if (project !== owner || treeQuery) return;
        changed = true;
      }
      if (!node.expanded) {
        node.expanded = true;
        changed = true;
      }
      level = node.children;
    }
    if (changed) renderTree();
    treeEl
      .querySelector<HTMLElement>(`.ft-row[data-path="${CSS.escape(path)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }

  /* ----------------------------------------------------------- the tree */

  function makeNode(entry: DirEntry, parentPath: string, depth: number): TreeNode {
    return {
      path: parentPath ? `${parentPath}/${entry.name}` : entry.name,
      name: entry.name,
      isDir: entry.is_dir,
      depth,
      expanded: false,
      loaded: !entry.is_dir,
      children: [],
    };
  }

  /** Backend refuses or fails — the folder just stays empty. No toast for a tree miss. */
  async function loadChildren(node: TreeNode): Promise<void> {
    const here = project;
    if (!here) return;
    node.loaded = true;
    try {
      const entries = await invoke<DirEntry[]>("read_dir", { project: here, path: node.path });
      if (project !== here) return; // switched projects while reading
      node.children = entries.map((entry) => makeNode(entry, node.path, node.depth + 1));
    } catch {
      node.children = [];
    }
  }

  async function toggleDir(node: TreeNode): Promise<void> {
    node.expanded = !node.expanded;
    renderTree(); // flip the disclosure immediately; children may follow a beat later
    if (node.expanded && !node.loaded) {
      await loadChildren(node);
      renderTree();
    }
  }

  async function loadTreeRoot(projectId: string): Promise<void> {
    treeRoot = [];
    treeVisible = [];
    cursorNode = null;
    renderTree();
    let entries: DirEntry[] = [];
    try {
      entries = await invoke<DirEntry[]>("read_dir", { project: projectId, path: "" });
    } catch {
      entries = [];
    }
    if (project !== projectId) return; // switched again while reading
    treeRoot = entries.map((entry) => makeNode(entry, "", 0));
    renderTree();
    if (activePath) void revealInTree(activePath);
  }

  /**
   * Refresh the git marks. Called on project switch and whenever an agent writes, because the
   * one moment you most want to know a file changed is the moment something else changed it.
   *
   * Folders roll up: a dirty file lights every ancestor. Without that, the only way to find what
   * moved in a collapsed tree is to open every folder, which is the state Panel exists to fix.
   */
  async function refreshGit(projectId: string): Promise<void> {
    let states: Record<string, string> = {};
    try {
      states = await invoke<Record<string, string>>("git_file_states", { project: projectId });
    } catch {
      states = {}; // not a repository, or git is unavailable — the tree simply carries no marks
    }
    if (project !== projectId) return; // switched while asking
    gitStates = new Map(Object.entries(states));
    gitFolders = new Set();
    for (const path of gitStates.keys()) {
      const parts = path.split("/");
      for (let cut = parts.length - 1; cut > 0; cut--) {
        gitFolders.add(parts.slice(0, cut).join("/"));
      }
    }
    renderTree();
  }

  function treeRow(node: TreeNode): HTMLElement {
    const identity = fileVisual(node);
    const row = document.createElement("button");
    row.type = "button";
    row.tabIndex = -1;
    row.className = "ft-row";
    row.id = `ft-row-${treeVisible.length - 1}`;
    row.style.setProperty("--depth", String(node.depth));
    row.setAttribute("role", "treeitem");
    if (node.isDir) row.setAttribute("aria-expanded", String(node.expanded));
    row.title = node.isDir ? node.path : `${node.path} — ${identity.label}`;
    row.setAttribute(
      "aria-label",
      node.isDir ? `${node.name}, folder` : `${node.name}, ${identity.label} file`,
    );
    if (!node.isDir) row.dataset.path = node.path;
    row.classList.toggle(
      "is-open",
      !node.isDir && activePath !== null && sameFile(activePath, node.path),
    );
    row.classList.toggle("is-cursor", node === cursorNode);
    row.setAttribute("aria-selected", String(node === cursorNode));

    const disc = document.createElement("span");
    disc.className = "ft-disc";
    disc.textContent = node.isDir ? (node.expanded ? "▾" : "▸") : "";

    const glyph = document.createElement("span");
    glyph.className = `ft-glyph ${identity.className}`;
    glyph.innerHTML = identity.svg;

    const name = document.createElement("span");
    name.className = "ft-name";
    const folder = node.flat ? dirname(node.path) : "";
    if (folder) {
      const dirEl = document.createElement("span");
      dirEl.className = "ft-dir";
      dirEl.textContent = folder;
      name.append(dirEl);
    }
    name.append(document.createTextNode(node.name));

    /* Git, said once. A file carries its own state; a folder carries only "something under here
       moved", because summing six kinds of change into one letter would be a lie. */
    const state = node.isDir
      ? gitFolders.has(node.path)
        ? "nested"
        : ""
      : gitStates.get(node.path) ?? "";

    /* No type label on the row. The glyph already says TypeScript, and a column of tiny
       uppercase words down a file tree is noise no editor carries. The name is still in the
       tooltip and the aria-label. */
    row.append(disc, glyph, name);
    if (state) {
      row.classList.add("is-dirty", `is-git-${state}`);
      const mark = document.createElement("span");
      mark.className = "ft-git";
      mark.textContent = GIT_MARKS[state] ?? "•";
      mark.title = GIT_TITLES[state] ?? "changed";
      row.append(mark);
    }
    row.addEventListener("click", () => {
      cursorNode = node;
      treeEl.focus({ preventScroll: true });
      if (node.isDir) {
        void toggleDir(node);
      } else {
        paintCursor();
        void openFile(node.path);
      }
    });
    // The second click of a double-click KEEPS the slot the first one opened.
    row.addEventListener("dblclick", () => {
      if (!node.isDir) void openFile(node.path, undefined, true);
    });
    return row;
  }

  /** Find the loaded node for a folder path, or null. `""` is the root. */
  function nodeAt(path: string): TreeNode | null {
    if (!path) return null;
    let level = treeRoot;
    let found: TreeNode | null = null;
    for (const part of path.split("/")) {
      found = level.find((node) => node.name === part) ?? null;
      if (!found) return null;
      level = found.children;
    }
    return found;
  }

  /** Fresh entries, but the folders you had open stay open. */
  function mergeChildren(old: TreeNode[], fresh: TreeNode[]): TreeNode[] {
    const known = new Map(old.map((node) => [node.path, node]));
    return fresh.map((node) => {
      const before = known.get(node.path);
      if (!before || !node.isDir || !before.isDir) return node;
      node.expanded = before.expanded;
      node.loaded = before.loaded;
      node.children = before.children;
      return node;
    });
  }

  /**
   * Re-read one folder from disk. The agent creates files; so does the New File menu. A tree
   * that only learns about them on the next project switch is a tree that lies.
   */
  async function reloadFolder(dirPath: string): Promise<void> {
    const here = project;
    if (!here) return;
    const node = dirPath ? nodeAt(dirPath) : null;
    if (dirPath && (!node || !node.loaded)) return; // never opened — it will read fresh when it is
    let entries: DirEntry[] = [];
    try {
      entries = await invoke<DirEntry[]>("read_dir", { project: here, path: dirPath });
    } catch {
      return;
    }
    if (project !== here) return;
    if (node) node.children = mergeChildren(node.children, entries.map((e) => makeNode(e, node.path, node.depth + 1)));
    else treeRoot = mergeChildren(treeRoot, entries.map((e) => makeNode(e, "", 0)));
    renderTree();
  }

  /** The folder a new entry lands in when the menu was opened on `node` (or on air). */
  const folderFor = (node: TreeNode | null): string =>
    !node ? "" : node.isDir ? node.path : dirname(node.path).replace(/\/$/, "");

  async function fileOp(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      fail(message(error));
    }
  }

  async function newEntry(node: TreeNode | null, isDir: boolean): Promise<void> {
    if (!project) return;
    const owner = project;
    const dir = folderFor(node);
    const name = await promptDialog(isDir ? `New folder in ${dir || "project root"}` : `New file in ${dir || "project root"}`);
    if (!name?.trim() || project !== owner) return;
    await fileOp(async () => {
      const created = await invoke<string>("create_entry", {
        project: owner,
        path: dir ? `${dir}/${name.trim()}` : name.trim(),
        isDir,
      });
      if (project !== owner) return;
      fileIndex = null;
      const parent = nodeAt(dir);
      if (parent && !parent.expanded) parent.expanded = true;
      await reloadFolder(dir);
      if (project !== owner) return;
      if (!isDir) await openFile(created, undefined, true);
      void refreshGit(owner);
    });
  }

  /** Move every open tab under `from` to its new name. Nothing reloads; the buffers are still right. */
  function retargetTabs(from: string, to: string): void {
    for (const workspace of workspaces.values()) {
      for (const tab of [...workspace.tabs.values()]) {
        const next = tab.path === from
          ? to
          : tab.path.startsWith(`${from}/`) ? `${to}${tab.path.slice(from.length)}` : null;
        if (next === null) continue;
        workspace.tabs.delete(tab.path);
        const at = workspace.order.indexOf(tab.path);
        if (at >= 0) workspace.order[at] = next;
        if (workspace.activePath === tab.path) workspace.activePath = next;
        for (const spot of workspace.trail) if (spot.path === tab.path) spot.path = next;
        tab.path = next;
        tab.name = basename(next);
        workspace.tabs.set(next, tab);
      }
    }
    if (activePath === from || (activePath && activePath.startsWith(`${from}/`))) {
      activePath = `${to}${activePath.slice(from.length)}`;
    }
  }

  async function renameEntry(node: TreeNode): Promise<void> {
    if (!project) return;
    const name = await promptDialog(`Rename ${node.name}`, node.name);
    if (!name?.trim() || name.trim() === node.name) return;
    const owner = project;
    const dir = dirname(node.path);
    await fileOp(async () => {
      const to = await invoke<string>("rename_entry", {
        project: owner,
        from: node.path,
        to: `${dir}${name.trim()}`,
      });
      if (project !== owner) return;
      fileIndex = null;
      relationCache.clear();
      retargetTabs(node.path, to);
      statusPathFor = null;
      renderTabs();
      await reloadFolder(dir.replace(/\/$/, ""));
      void refreshGit(owner);
    });
  }

  async function deleteEntry(node: TreeNode): Promise<void> {
    if (!project) return;
    const inside = (path: string): boolean => path === node.path || path.startsWith(`${node.path}/`);
    let unsaved = 0;
    for (const tab of tabs.values()) if (tab.kind === "text" && inside(tab.path) && isDirty(tab)) unsaved += 1;
    const what = node.isDir ? `the folder ${node.name} and everything in it` : node.name;
    const warning = unsaved ? ` ${unsaved} open ${unsaved === 1 ? "file has" : "files have"} unsaved edits.` : "";
    const ok = await confirmDialog(`Delete ${what}?${warning} This cannot be undone.`, {
      okLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    const owner = project;
    await fileOp(async () => {
      await invoke("delete_entry", { project: owner, path: node.path });
      if (project !== owner) return;
      fileIndex = null;
      relationCache.clear();
      for (const path of [...order]) if (inside(path)) dropTab(path);
      settleAfterClose();
      await reloadFolder(dirname(node.path).replace(/\/$/, ""));
      void refreshGit(owner);
    });
  }

  const absolutePath = (path: string): string => (projectPath ? `${projectPath}/${path}` : path);

  function copyText(text: string): void {
    void navigator.clipboard?.writeText(text).catch(() => fail("Could not copy to the clipboard."));
  }

  function revealEntry(path: string): void {
    if (!project) return;
    void invoke("reveal_entry", { project, path }).catch((error) => fail(message(error)));
  }

  /* --------------------------------------------------------------- menus */

  type MenuItem =
    | { sep: true }
    | { label: string; run(): void; danger?: boolean; disabled?: boolean; hint?: string };

  const menu = document.createElement("div");
  menu.className = "ed-menu";
  menu.hidden = true;
  menu.setAttribute("role", "menu");
  host.append(menu);

  function closeMenu(): void {
    if (menu.hidden) return;
    menu.hidden = true;
    menu.replaceChildren();
  }

  /** One popover for every right-click in the pane. Escape, a click anywhere, or a choice closes it. */
  function openMenu(x: number, y: number, items: MenuItem[]): void {
    closeMenu();
    const frag = document.createDocumentFragment();
    for (const item of items) {
      if ("sep" in item) {
        const rule = document.createElement("hr");
        frag.append(rule);
        continue;
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ed-menu-item";
      button.setAttribute("role", "menuitem");
      button.classList.toggle("is-danger", !!item.danger);
      button.disabled = !!item.disabled;
      const label = document.createElement("span");
      label.textContent = item.label;
      button.append(label);
      if (item.hint) {
        const hint = document.createElement("kbd");
        hint.textContent = item.hint;
        button.append(hint);
      }
      button.addEventListener("click", () => {
        closeMenu();
        item.run();
      });
      frag.append(button);
    }
    menu.replaceChildren(frag);
    menu.hidden = false;
    const box = host.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    menu.style.left = `${Math.max(4, Math.min(x - box.left, box.width - width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(y - box.top, box.height - height - 4))}px`;
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }

  window.addEventListener("pointerdown", (event) => {
    if (!menu.hidden && !menu.contains(event.target as Node)) closeMenu();
  }, true);
  window.addEventListener("keydown", (event) => {
    if (menu.hidden) return;
    if (event.key === "Escape") {
      closeMenu();
      event.preventDefault();
      event.stopImmediatePropagation();
      view.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const buttons = [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = buttons[(at + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length];
      next?.focus();
      event.preventDefault();
    }
  }, true);
  window.addEventListener("blur", closeMenu);

  treeEl.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const row = (event.target as HTMLElement).closest<HTMLElement>(".ft-row");
    const at = row ? [...treeEl.children].indexOf(row) : -1;
    const node = at >= 0 ? treeVisible[at] ?? null : null;
    if (node) {
      cursorNode = node;
      paintCursor();
    }
    const items: MenuItem[] = [
      { label: "New File…", run: () => void newEntry(node, false) },
      { label: "New Folder…", run: () => void newEntry(node, true) },
    ];
    if (node) {
      items.push(
        { sep: true },
        { label: "Rename…", run: () => void renameEntry(node) },
        { label: "Delete", danger: true, run: () => void deleteEntry(node) },
        { sep: true },
        { label: "Copy Path", run: () => copyText(absolutePath(node.path)) },
        { label: "Copy Relative Path", run: () => copyText(node.path) },
        { label: "Reveal in Finder", run: () => revealEntry(node.path) },
      );
    } else {
      items.push({ sep: true }, { label: "Reveal in Finder", run: () => revealEntry("") });
    }
    openMenu(event.clientX, event.clientY, items);
  });

  /** Rebuilt flat and whole — a visible tree is a few hundred rows at worst. */
  function renderTree(): void {
    treeVisible = [];
    const frag = document.createDocumentFragment();
    if (treeQuery) {
      const hits = filterPaths(fileIndex ?? [], treeQuery).slice(0, MAX_FILTER_HITS);
      for (const path of hits) {
        const node: TreeNode = {
          path,
          name: basename(path),
          isDir: false,
          depth: 0,
          expanded: false,
          loaded: true,
          children: [],
          flat: true,
        };
        treeVisible.push(node);
        frag.append(treeRow(node));
      }
      if (!hits.length) {
        const none = document.createElement("p");
        none.className = "ft-none";
        none.textContent = fileIndex ? "No file matches." : "Indexing…";
        frag.append(none);
      }
      treeEl.replaceChildren(frag);
      paintCursor();
      return;
    }
    const walk = (nodes: TreeNode[]): void => {
      for (const node of nodes) {
        treeVisible.push(node);
        frag.append(treeRow(node));
        if (node.isDir && node.expanded) walk(node.children);
      }
    };
    walk(treeRoot);
    treeEl.replaceChildren(frag);
    paintCursor();
  }

  function paintCursor(): void {
    const rows = treeEl.children;
    let active = "";
    for (let i = 0; i < rows.length; i++) {
      const selected = treeVisible[i] === cursorNode;
      rows[i]?.classList.toggle("is-cursor", selected);
      rows[i]?.setAttribute("aria-selected", String(selected));
      if (selected) active = rows[i]?.id ?? "";
    }
    if (active) treeEl.setAttribute("aria-activedescendant", active);
    else treeEl.removeAttribute("aria-activedescendant");
  }

  treeEl.addEventListener("focus", () => {
    if (!cursorNode && treeVisible.length) cursorNode = treeVisible[0] ?? null;
    paintCursor();
  });

  function markTreeActive(): void {
    for (const row of treeEl.querySelectorAll<HTMLElement>(".ft-row[data-path]")) {
      const path = row.dataset.path ?? "";
      row.classList.toggle("is-open", activePath !== null && sameFile(activePath, path));
    }
  }

  treeEl.addEventListener("keydown", (event) => {
    if (!treeVisible.length) return;
    const index = cursorNode ? treeVisible.indexOf(cursorNode) : -1;
    const node = index >= 0 ? treeVisible[index] : null;

    const moveTo = (next: number): void => {
      const clamped = Math.max(0, Math.min(next, treeVisible.length - 1));
      cursorNode = treeVisible[clamped] ?? null;
      paintCursor();
      treeEl.children[clamped]?.scrollIntoView({ block: "nearest" });
    };

    switch (event.key) {
      case "ArrowDown":
        moveTo(index + 1);
        break;
      case "ArrowUp":
        moveTo(index < 0 ? 0 : index - 1);
        break;
      case "ArrowRight":
        if (node?.isDir && !node.expanded) void toggleDir(node);
        break;
      case "ArrowLeft":
        if (node?.isDir && node.expanded) void toggleDir(node);
        break;
      case "Enter":
        if (!node) break;
        if (node.isDir) void toggleDir(node);
        else void openFile(node.path);
        break;
      default:
        return;
    }
    event.preventDefault();
  });

  /* ----------------------------------------------------------- resizing */

  function applyNavWidth(width: number): void {
    const clamped = Math.round(Math.max(NAV_MIN, Math.min(NAV_MAX, width)));
    host.style.setProperty("--nav-w", `${clamped}px`);
  }

  try {
    const stored = Number(localStorage.getItem(NAV_WIDTH_KEY));
    if (Number.isFinite(stored) && stored > 0) applyNavWidth(stored);
  } catch {
    /* storage unavailable — the CSS default width stands */
  }

  grip.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = nav.getBoundingClientRect().width;
    grip.setPointerCapture(event.pointerId);
    host.classList.add("is-resizing");

    const onMove = (move: PointerEvent): void => {
      applyNavWidth(startWidth + move.clientX - startX);
    };
    const onUp = (): void => {
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onUp);
      grip.removeEventListener("pointercancel", onUp);
      host.classList.remove("is-resizing");
      try {
        localStorage.setItem(NAV_WIDTH_KEY, String(Math.round(nav.getBoundingClientRect().width)));
      } catch {
        /* fine — the width still applies for this session */
      }
    };
    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp);
    grip.addEventListener("pointercancel", onUp);
  });

  /* ----------------------------------------------------------- the tabs */

  /**
   * Two files called `index.ts` must not read identically. Only the colliding names grow a
   * parent folder — everything else stays a basename, which is why the strip is scannable.
   */
  function tabLabels(): Map<string, string> {
    const seen = new Map<string, number>();
    for (const path of order) {
      const tab = tabs.get(path);
      if (tab) seen.set(tab.name, (seen.get(tab.name) ?? 0) + 1);
    }
    const labels = new Map<string, string>();
    for (const path of order) {
      const tab = tabs.get(path);
      if (!tab) continue;
      const parts = tab.path.split("/");
      const parent = parts[parts.length - 2];
      labels.set(path, (seen.get(tab.name) ?? 0) > 1 && parent ? `${parent}/${tab.name}` : tab.name);
    }
    return labels;
  }

  const tabTitle = (tab: Tab): string =>
    tab.pinned ? tab.path : `${tab.path}\nPreview — type, save, or double-click to keep it open`;

  /** Repaint the state classes of ONE tab. Cheap: this runs on every keystroke. */
  function paintTabState(tab: Tab): void {
    const el = tabStrip.querySelector<HTMLElement>(`.ed-tab[data-path="${CSS.escape(tab.path)}"]`);
    if (!el) return;
    const dirty = tab.kind === "text" && isDirty(tab);
    const conflict = tab.kind === "text" && tab.conflict;
    el.classList.toggle("is-preview", !tab.pinned);
    el.classList.toggle("is-dirty", dirty && !conflict);
    el.classList.toggle("is-conflict", conflict);
    el.title = tabTitle(tab);
  }

  /** Drop a tab from the strip without asking. The caller has already decided. */
  function dropTab(path: string): void {
    tabs.delete(path);
    const at = order.indexOf(path);
    if (at >= 0) order.splice(at, 1);
    if (activePath === path) activePath = null;
  }

  /** After tabs were dropped: show the last one left, or the empty state. */
  function settleAfterClose(): void {
    if (activePath && tabs.has(activePath)) {
      renderTabs();
      return;
    }
    activePath = null;
    const next = order[order.length - 1];
    if (next) {
      activate(next);
      return;
    }
    relationshipRequest += 1;
    relationshipPath = null;
    relationships = [];
    relationshipsLoading = false;
    blank();
    mediaEl.replaceChildren();
    renderRelated();
    renderTabs();
  }

  /** Close every tab `keep` rejects, silently skipping unsaved ones and saying how many. */
  function closeWhere(keep: (tab: Tab) => boolean): void {
    let held = 0;
    for (const path of [...order]) {
      const tab = tabs.get(path);
      if (!tab || keep(tab)) continue;
      if (tab.kind === "text" && isDirty(tab)) {
        held += 1;
        continue;
      }
      dropTab(path);
    }
    settleAfterClose();
    if (held) fail(`Kept ${held} unsaved ${held === 1 ? "file" : "files"} open.`);
  }

  function tabMenu(tab: Tab, x: number, y: number): void {
    const others = order.filter((path) => path !== tab.path);
    openMenu(x, y, [
      { label: "Close", hint: "⌘W", run: () => void closeTab(tab.path) },
      { label: "Close Others", disabled: !others.length, run: () => closeWhere((other) => other.path === tab.path) },
      { label: "Close Saved", run: () => closeWhere((other) => other.kind === "text" && isDirty(other)) },
      { label: "Close All", run: () => closeWhere(() => false) },
      { sep: true },
      {
        label: "Keep Open",
        disabled: tab.pinned,
        run: () => {
          tab.pinned = true;
          paintTabState(tab);
        },
      },
      { label: "Copy Path", run: () => copyText(absolutePath(tab.path)) },
      { label: "Copy Relative Path", run: () => copyText(tab.path) },
      { label: "Reveal in Finder", run: () => revealEntry(tab.path) },
      { label: "Reveal in Navigator", run: () => void revealInTree(tab.path) },
    ]);
  }

  /** Rebuilt whole because a tab strip is a handful of nodes, not a list. */
  function renderTabs(): void {
    const frag = document.createDocumentFragment();
    const labels = tabLabels();
    for (const path of order) {
      const tab = tabs.get(path);
      if (!tab) continue;
      const dirty = tab.kind === "text" && isDirty(tab);

      const el = document.createElement("div");
      el.className = "ed-tab";
      el.dataset.path = path;
      el.setAttribute("role", "tab");
      el.classList.toggle("is-active", path === activePath);
      el.classList.toggle("is-preview", !tab.pinned);
      el.classList.toggle("is-dirty", dirty && !(tab.kind === "text" && tab.conflict));
      el.classList.toggle("is-conflict", tab.kind === "text" && tab.conflict);
      el.title = tabTitle(tab);
      el.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        tabMenu(tab, event.clientX, event.clientY);
      });
      // Middle-click closes, as in every browser and every editor.
      el.addEventListener("auxclick", (event) => {
        if (event.button === 1) void closeTab(path);
      });

      const identity = fileVisual({ name: tab.name });
      const glyph = document.createElement("span");
      glyph.className = `ft-glyph ${identity.className}`;
      glyph.setAttribute("aria-hidden", "true");
      glyph.innerHTML = identity.svg;

      const label = document.createElement("button");
      label.type = "button";
      label.className = "ed-tab-label";
      // No trailing asterisk: the dot on the close button already carries "unsaved", and one
      // fact said twice in one 190px tab is what makes a strip look homemade.
      label.textContent = labels.get(path) ?? tab.name;
      label.addEventListener("click", () => activate(path));
      label.addEventListener("dblclick", () => {
        tab.pinned = true;
        paintTabState(tab);
      });

      const close = document.createElement("button");
      close.type = "button";
      close.className = "ed-tab-close";
      close.setAttribute("aria-label", `Close ${tab.name}`);
      close.textContent = "×";
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        void closeTab(path);
      });

      // ⌘1…⌘9. Shown only while ⌘ is held (body.is-cmd-held) — the key, where it lands.
      const slot = order.indexOf(path) + 1;
      if (slot <= 9) {
        const key = document.createElement("kbd");
        key.className = "key-hint ed-tab-slot";
        key.setAttribute("aria-hidden", "true");
        key.textContent = String(slot);
        el.append(key);
      }
      el.append(glyph, label, close);
      frag.append(el);
    }
    frag.prepend(trailNav);
    tabStrip.replaceChildren(frag);
    paintTrail();
    const activeTab = activePath ? tabs.get(activePath) : null;
    tabStrip.hidden = order.length === 0;
    empty.hidden = !!activeTab;
    if (!activeTab) renderWelcome();
    surface.hidden = !activeTab || activeTab.kind !== "text";
    mediaEl.hidden = !activeTab || activeTab.kind !== "media";
    if (diffFor && (activePath !== diffFor || !tabs.has(diffFor))) closeDiff();
    renderStatus();
    renderConflict();
    markTreeActive();
  }

  /* --------------------------------------------------------- change bars */

  /** Recomputing on every keystroke is wasted work — the diff of a 3000-line file is not free
   *  and nobody reads a gutter mid-word. */
  let changeTimer = 0;

  /** Paint the bars for the open buffer. Cheap when HEAD has not arrived: it draws nothing. */
  function paintChanges(): void {
    const tab = activePath ? tabs.get(activePath) : null;
    if (!tab || tab.kind !== "text" || tab.head === null) {
      code.setChanges(null);
      return;
    }
    code.setChanges(tab.head);
  }

  function queueChanges(): void {
    window.clearTimeout(changeTimer);
    changeTimer = window.setTimeout(paintChanges, 220);
  }

  /**
   * Fetch the committed version of a file, once per open unless something moved it. An untracked
   * file resolves to `""` rather than staying null, because "git has never seen this" is an
   * answer — every line is new — and leaving it null would blank the gutter forever.
   */
  async function loadHead(tab: TextTab, force = false): Promise<void> {
    if (!project || (tab.head !== null && !force)) return;
    const owner = project;
    try {
      const committed = await invoke<string | null>("git_head_file", {
        project: owner,
        path: tab.path,
      });
      if (project !== owner || !tabs.has(tab.path)) return; // switched away while asking
      tab.head = committed ?? "";
    } catch {
      if (project !== owner) return;
      tab.head = ""; // not a repository, or git is unavailable — treat the file as all new
    }
    if (activePath === tab.path) paintChanges();
  }

  /* ----------------------------------------------------------- status bar */

  /** Which file the crumbs currently spell, so typing does not rebuild them every keystroke. */
  let statusPathFor: string | null = null;

  function renderStatus(): void {
    renderTools();
    const tab = activePath ? tabs.get(activePath) : null;
    status.hidden = !tab;
    if (!tab) {
      statusPathFor = null;
      statusPath.replaceChildren();
      statusMeta.replaceChildren();
      return;
    }
    if (statusPathFor !== tab.path) {
      statusPathFor = tab.path;
      // Two parts, not per-folder crumbs: the folders shrink and ellipsize, the filename never
      // does. A deep path must never be able to push the name it names off the bar.
      const dir = document.createElement("span");
      dir.className = "ed-crumb-dir";
      dir.textContent = dirname(tab.path);
      const leaf = document.createElement("span");
      leaf.className = "ed-crumb-leaf";
      leaf.textContent = tab.name;
      statusPath.replaceChildren(dir, leaf);
      statusPath.title = tab.path;
    }
    renderStatusMeta();
  }

  /** The right end: where the caret is, then whether the buffer agrees with disk. */
  function renderStatusMeta(): void {
    renderTools();
    const tab = activePath ? tabs.get(activePath) : null;
    if (!tab || status.hidden) return;
    const frag = document.createDocumentFragment();
    const add = (text: string, className = ""): void => {
      const el = document.createElement("span");
      el.className = className ? `ed-stat ${className}` : "ed-stat";
      el.textContent = text;
      frag.append(el);
    };

    /* A stat you can act on is a button. It looks like the others until you hover, so the bar
       keeps reading as one line of facts. */
    const act = (text: string, title: string, className: string, run: () => void): void => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = `ed-stat ed-stat-act ${className}`;
      el.textContent = text;
      el.title = title;
      el.addEventListener("click", run);
      frag.append(el);
    };

    if (tab.kind === "text") {
      const state = tab.path === activePath ? view.state : tab.state;
      const range = state.selection.main;
      const line = state.doc.lineAt(range.head);
      add(`Ln ${line.number}, Col ${range.head - line.from + 1}`, "is-num");
      if (!range.empty) add(`${range.to - range.from} sel`, "is-num");
      const armed = breakpoints.get(tab.path)?.size ?? 0;
      if (armed) add(`${armed} bp`, "is-risk");
      let unsaved = 0;
      for (const other of tabs.values()) if (other.kind === "text" && isDirty(other)) unsaved += 1;
      if (tab.conflict) add("Conflict", "is-risk");
      else if (isDirty(tab)) act("Unsaved", "Save (⌘S)", "is-warn", () => void save());
      else add("Saved", "is-ok");
      if (unsaved > 1) act(`${unsaved} unsaved`, "Save all (⌥⌘S)", "is-warn", () => void saveAll());
      add(indentLabel(state), "");
      const wrapped = tab.path === activePath ? code.wrapped() : false;
      act(wrapped ? "Wrap" : "No wrap", "Toggle line wrapping for this file", wrapped ? "is-on" : "", () => {
        code.setWrap(!code.wrapped());
        renderStatusMeta();
      });
    }
    add(fileVisual({ name: tab.name }).label, "is-lang");
    statusMeta.replaceChildren(frag);
  }

  /* ----------------------------------------------------------- the diff */

  /** Which file the diff panel is currently showing, so closing a tab can close it too. */
  let diffFor: string | null = null;

  function closeDiff(): void {
    diffFor = null;
    diffPanel.hidden = true;
    diffPanel.replaceChildren();
  }

  /**
   * Show what the agent's version does to yours.
   *
   * The conflict bar used to offer "Use agent's version" and "Keep mine" with nothing to look
   * at. That is not a choice, it is a coin toss — you cannot pick between two versions of a file
   * you have not seen. The diff is the missing half of the affordance, and the two buttons move
   * into its header so the decision sits next to the evidence.
   */
  function openDiff(tab: TextTab): void {
    if (tab.incoming === null) return;
    find.close();
    diffFor = tab.path;

    const rows = lineDiff(tab.state.doc.toString(), tab.incoming);
    const added = rows.filter((row) => row.kind === "add").length;
    const removed = rows.filter((row) => row.kind === "del").length;

    const head = document.createElement("header");
    head.className = "ed-diff-head";

    const title = document.createElement("b");
    title.className = "ed-diff-title";
    title.textContent = tab.name;

    const tally = document.createElement("span");
    tally.className = "ed-diff-tally";
    const plus = document.createElement("span");
    plus.className = "is-add";
    plus.textContent = `+${added}`;
    const minus = document.createElement("span");
    minus.className = "is-del";
    minus.textContent = `−${removed}`;
    tally.append(plus, minus);

    const legend = document.createElement("small");
    legend.className = "ed-diff-legend";
    legend.textContent = "Green is the agent's. Red is yours.";

    const take = document.createElement("button");
    take.type = "button";
    take.className = "ed-conflict-take";
    take.textContent = "Use agent's version";
    take.addEventListener("click", () => {
      if (tab.incoming === null) return;
      applyDisk(tab, tab.incoming);
      closeDiff();
      paintChanges();
      flashTab(tab.path);
      renderTabs();
      view.focus();
    });

    const keep = document.createElement("button");
    keep.type = "button";
    keep.className = "ed-conflict-keep";
    keep.textContent = "Keep mine";
    keep.addEventListener("click", () => {
      tab.conflict = false;
      tab.incoming = null;
      closeDiff();
      renderTabs();
      view.focus();
    });

    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "ed-diff-close";
    dismiss.textContent = "×";
    dismiss.setAttribute("aria-label", "Close the diff");
    dismiss.addEventListener("click", () => {
      closeDiff();
      view.focus();
    });

    head.append(title, tally, legend, take, keep, dismiss);

    const body = document.createElement("div");
    body.className = "ed-diff-body";
    const frag = document.createDocumentFragment();
    let quiet = 0;
    for (const row of rows) {
      // Unchanged lines are context, and a hundred of them between two edits is not context.
      if (row.kind === "same") {
        quiet += 1;
        if (quiet > 3) continue;
      } else {
        quiet = 0;
      }
      frag.append(diffRow(row));
    }
    body.append(frag);

    diffPanel.replaceChildren(head, body);
    diffPanel.hidden = false;
  }

  function diffRow(row: DiffRow): HTMLElement {
    const el = document.createElement("div");
    el.className = `ed-diff-row is-${row.kind}`;

    const before = document.createElement("span");
    before.className = "ed-diff-no";
    before.textContent = row.before === undefined ? "" : String(row.before);

    const after = document.createElement("span");
    after.className = "ed-diff-no";
    after.textContent = row.after === undefined ? "" : String(row.after);

    const sign = document.createElement("span");
    sign.className = "ed-diff-sign";
    sign.textContent = row.kind === "add" ? "+" : row.kind === "del" ? "−" : " ";

    // A text node, never innerHTML — this is file content the agent just wrote.
    const text = document.createElement("span");
    text.className = "ed-diff-text";
    text.textContent = row.text;

    el.append(before, after, sign, text);
    return el;
  }

  /** The affordance. Small, adjacent to the file, and it never decides for the human. */
  function renderConflict(): void {
    const tab = activePath ? tabs.get(activePath) : null;
    if (!tab || tab.kind !== "text" || !tab.conflict) {
      conflictBar.hidden = true;
      conflictBar.replaceChildren();
      return;
    }

    const lead = document.createElement("b");
    lead.textContent = "The agent rewrote this file on disk.";
    const rest = document.createTextNode(" You have unsaved edits.");
    const text = document.createElement("span");
    text.className = "ed-conflict-text";
    text.append(lead, rest);

    /* The bar now asks ONE thing, and it is the honest one: look at it first. Deciding between
       two versions you have not seen is a coin toss dressed as a choice, so the two commands
       moved into the diff's own header, next to the evidence for them. */
    const show = document.createElement("button");
    show.type = "button";
    show.className = "ed-conflict-take";
    show.textContent = "Show what changed";
    show.addEventListener("click", () => openDiff(tab));

    const keep = document.createElement("button");
    keep.type = "button";
    keep.className = "ed-conflict-keep";
    keep.textContent = "Keep mine";
    keep.title = "Keep your buffer; ⌘S will overwrite the agent's version";
    keep.addEventListener("click", () => {
      // Their buffer stands and stays dirty, so the tab still says "unsaved" and ⌘S is an
      // explicit, deliberate overwrite. We drop the parked copy — disk is still intact.
      tab.conflict = false;
      tab.incoming = null;
      closeDiff();
      renderTabs();
      view.focus();
    });

    conflictBar.replaceChildren(text, show, keep);
    conflictBar.hidden = false;
  }

  function flashTab(path: string): void {
    const el = tabStrip.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`);
    if (!el) return;
    el.classList.remove("is-flash");
    void el.offsetWidth; // restart the animation
    el.classList.add("is-flash");
  }

  /* --------------------------------------------------------------- trail */

  /** Set while back/forward is driving the editor, so the move is not recorded as a new step. */
  let retracing = false;

  function caretLine(): number {
    const tab = activePath ? tabs.get(activePath) : null;
    if (!tab || tab.kind !== "text") return 1;
    return view.state.doc.lineAt(view.state.selection.main.head).number;
  }

  /** Leaving a file: remember the line, so coming back lands where you were, not at the top. */
  function leaveSpot(): void {
    const spot = current.trail[current.trailAt];
    if (spot && activePath !== null && sameFile(spot.path, activePath)) spot.line = caretLine();
  }

  /** Arriving at a file by your own hand: a new step, and the forward branch is gone. */
  function arriveSpot(path: string): void {
    if (retracing) return;
    const here = current.trail[current.trailAt];
    if (here && sameFile(here.path, path)) return;
    current.trail.splice(current.trailAt + 1);
    current.trail.push({ path, line: 1 });
    if (current.trail.length > 60) current.trail.shift();
    current.trailAt = current.trail.length - 1;
    paintTrail();
  }

  async function retrace(delta: -1 | 1): Promise<void> {
    const next = current.trailAt + delta;
    const spot = current.trail[next];
    if (!spot) return;
    leaveSpot();
    current.trailAt = next;
    retracing = true;
    try {
      await openFile(spot.path, spot.line);
    } finally {
      retracing = false;
    }
    paintTrail();
    view.focus();
  }

  function paintTrail(): void {
    backButton.disabled = current.trailAt <= 0;
    forwardButton.disabled = current.trailAt >= current.trail.length - 1;
  }

  backButton.addEventListener("click", () => void retrace(-1));
  forwardButton.addEventListener("click", () => void retrace(1));
  window.addEventListener(
    "keydown",
    (event) => {
      if (
        !event.metaKey ||
        !event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        event.repeat ||
        (event.code !== "ArrowLeft" && event.code !== "ArrowRight") ||
        host.closest("[hidden]") ||
        host.getClientRects().length === 0
      ) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void retrace(event.code === "ArrowLeft" ? -1 : 1);
    },
    true,
  );

  /* ------------------------------------------------------------- buffers */

  function activate(path: string): void {
    const tab = tabs.get(path);
    if (!tab) return;
    const current = activePath ? tabs.get(activePath) : null;
    if (current && current.kind === "text" && current.path !== path) {
      current.scrollTop = view.scrollDOM.scrollTop;
    }
    leaveSpot();

    activePath = path;
    if (tab.kind === "text") {
      code.show(tab.state); // re-measures — the pane may have just been revealed
      code.setBreakpoints([...(breakpoints.get(tab.path) ?? [])]);
      paintChanges();
      void loadHead(tab);
      // The stopped line belongs to ONE file. Switching tabs must not carry the band along.
      syncExecLine();
      view.scrollDOM.scrollTop = tab.scrollTop;
      mediaEl.replaceChildren();
      const cached = relationCache.get(path);
      relationshipPath = path;
      relationships = cached ?? [];
      relationshipsLoading = !cached;
      renderRelated();
      if (!cached) void refreshRelationships(path);
    } else {
      const src = tab.media === "binary" ? "" : projectAssetUrl(project ?? "", tab.path);
      mediaEl.replaceChildren(buildMedia(tab.media, src, tab.note));
      const cached = relationCache.get(path);
      relationshipPath = path;
      relationships = cached ?? [];
      relationshipsLoading = !cached;
      renderRelated();
      if (!cached) void refreshRelationships(path);
    }
    renderTabs();
    arriveSpot(path);
    void revealInTree(path);
  }

  function blank(): void {
    code.blank();
  }

  async function closeTab(path: string): Promise<void> {
    const tab = tabs.get(path);
    if (!tab) return;
    if (
      tab.kind === "text" &&
      isDirty(tab) &&
      !(await confirmDialog(`${tab.name} has unsaved changes. Close it anyway?`, {
        okLabel: "Close anyway",
        danger: true,
      }))
    ) {
      return;
    }

    dropTab(path);
    settleAfterClose();
  }

  /** Overwrite the buffer with what is on disk. Only ever called with the human's consent
   *  (or when they had nothing to lose). Keeps the caret roughly where it was. */
  function applyDisk(tab: TextTab, text: string): void {
    if (tab.path === activePath) {
      reloading = true;
      try {
        code.replaceDoc(text);
      } finally {
        reloading = false;
      }
      tab.state = view.state;
    } else {
      tab.state = makeState(tab.path, text);
    }
    tab.saved = tab.state.doc;
    tab.conflict = false;
    tab.incoming = null;
  }

  async function saveTab(tab: TextTab): Promise<string> {
    if (!project) {
      throw new Error("No project selected.");
    }
    const owner = project;
    const saved = tab.state.doc;
    const contents = saved.toString();
    await invoke("write_file", { project: owner, path: tab.path, contents });
    tab.saved = saved;
    tab.conflict = false;
    tab.incoming = null;
    tab.pinned = true; // a file you saved into is one you are working in — keep its slot
    if (project !== owner) return contents;
    relationCache.clear();
    if (project) void refreshGit(project);
    void loadHead(tab, true); // a save can be the commit's own file; re-ask rather than assume
    renderTabs();
    if (tab.path === activePath) void refreshRelationships(tab.path, true);
    return contents;
  }

  async function save(): Promise<void> {
    const tab = activePath ? tabs.get(activePath) : null;
    if (!tab || tab.kind !== "text") return;
    try {
      await saveTab(tab);
    } catch (error) {
      fail(`Could not save ${tab.name} — ${message(error)}`);
    }
  }

  /** ⌥⌘S. Every dirty buffer in this workspace, conflicts excepted — those need a look first. */
  async function saveAll(): Promise<void> {
    const owner = project;
    let skipped = 0;
    for (const tab of [...tabs.values()]) {
      if (project !== owner) return;
      if (tab.kind !== "text" || !isDirty(tab)) continue;
      if (tab.conflict) {
        skipped += 1;
        continue;
      }
      try {
        await saveTab(tab);
      } catch (error) {
        fail(`Could not save ${tab.name} — ${message(error)}`);
        return;
      }
    }
    if (skipped) fail(`${skipped} ${skipped === 1 ? "file has" : "files have"} a conflict — resolve it first.`);
    renderStatusMeta();
  }

  window.addEventListener(
    "keydown",
    (event) => {
      if (
        !event.metaKey ||
        !event.altKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.repeat ||
        event.code !== "KeyS" ||
        host.closest("[hidden]") ||
        host.getClientRects().length === 0
      ) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void saveAll();
    },
    true,
  );

  const jumpTo = (line: number): void => code.jumpTo(line);

  /** Find an already-open tab for a path that may be spelled differently (abs vs relative). */
  function findTab(path: string): Tab | undefined {
    const direct = tabs.get(path);
    if (direct) return direct;
    for (const tab of tabs.values()) if (sameFile(tab.path, path)) return tab;
    return undefined;
  }

  /**
   * Put a new tab in the strip. There is at most ONE preview tab; a new preview takes its place
   * wherever it sits, and a kept tab goes after the active one, where the eye already is.
   * One place decides, so text and media tabs cannot differ.
   */
  function seat(tab: Tab): void {
    const preview = order.find((path) => {
      const open = tabs.get(path);
      return open && !open.pinned && !(open.kind === "text" && isDirty(open));
    });
    if (preview !== undefined) {
      tabs.delete(preview);
      order.splice(order.indexOf(preview), 1, tab.path);
    } else {
      const at = activePath ? order.indexOf(activePath) : -1;
      order.splice(at < 0 ? order.length : at + 1, 0, tab.path);
    }
    tabs.set(tab.path, tab);
  }

  async function openFile(path: string, line?: number, keep = line !== undefined): Promise<void> {
    const open = findTab(path);
    if (open) {
      if (keep) open.pinned = true;
      if (open.path !== activePath) activate(open.path);
      else renderTabs();
      if (open.kind === "text" && line !== undefined) jumpTo(line);
      return;
    }
    if (!project) {
      fail("No project selected.");
      return;
    }

    // Images, audio, video and PDFs are not text: serve their bytes off the project-asset
    // scheme and show a viewer/player instead of opening the code editor on binary garbage.
    const media = mediaKind(path);
    if (media) {
      const tab: MediaTab = {
        kind: "media",
        media,
        path,
        name: basename(path),
        note: "",
        pinned: keep,
      };
      seat(tab);
      activate(path);
      return;
    }

    const owner = project;
    let text: string;
    try {
      text = await invoke<string>("read_file", { project: owner, path });
      if (project !== owner) return;
    } catch (error) {
      if (project !== owner) return;
      // Binary (not valid UTF-8) or too large: don't flash a toast and show nothing — open a
      // placeholder tab that states why there is nothing to render.
      const tab: MediaTab = {
        kind: "media",
        media: "binary",
        path,
        name: basename(path),
        note: message(error),
        pinned: keep,
      };
      seat(tab);
      activate(path);
      return;
    }
    const state = makeState(path, text);
    const tab: TextTab = {
      kind: "text",
      path,
      name: basename(path),
      state,
      saved: state.doc,
      head: null,
      conflict: false,
      incoming: null,
      scrollTop: 0,
      pinned: keep,
    };
    seat(tab);
    activate(path);
    if (line !== undefined) jumpTo(line);
  }

  /* -------------------------------------------------------- workspaces */

  /** Holding a buffer for every app in the portfolio is a slow leak. Eight is more projects
   *  than anyone switches between in a sitting, and unsaved work is never evicted. */
  const MAX_WORKSPACES = 8;

  const hasUnsaved = (workspace: Workspace): boolean => {
    for (const tab of workspace.tabs.values()) if (tab.kind === "text" && isDirty(tab)) return true;
    return false;
  };

  function restoreWorkspace(projectId: string): Workspace {
    const found = workspaces.get(projectId) ?? blankWorkspace();
    workspaces.set(projectId, found);

    const seen = recent.indexOf(projectId);
    if (seen >= 0) recent.splice(seen, 1);
    recent.unshift(projectId);

    for (let index = recent.length - 1; index >= MAX_WORKSPACES; index--) {
      const stale = recent[index];
      const workspace = workspaces.get(stale);
      if (!workspace || hasUnsaved(workspace)) continue; // never throw away typing
      workspaces.delete(stale);
      recent.splice(index, 1);
    }
    return found;
  }

  renderRelated();
  renderTree();
  renderTabs();

  /* -------------------------------------------------------------- handle */

  return {
    setProject(projectId: string, nextProjectPath: string): void {
      if (project === projectId) return;

      // Park what is open before touching anything. The active buffer's scroll lives in the
      // view, not in the tab, so it has to be copied back or the file reopens at the top.
      const leaving = activePath ? tabs.get(activePath) : null;
      if (leaving && leaving.kind === "text") leaving.scrollTop = view.scrollDOM.scrollTop;
      leaveSpot();
      current.activePath = activePath;

      project = projectId;
      projectPath = nextProjectPath;
      navHead.querySelector<HTMLElement>(".ft-project")!.textContent = basename(projectPath) || "Project files";
      navHead.title = projectPath;
      current = restoreWorkspace(projectId);
      tabs = current.tabs;
      order = current.order;
      activePath = null; // set by `activate` below, so the editor and the strip agree

      relationshipRequest += 1;
      relationshipPath = null;
      relationships = [];
      relationshipsLoading = false;
      relationCache.clear();
      breakpoints = new Map();
      // The other project's session is not this one's. Debug re-announces on select.
      debugPhase = null;
      execAt = null;
      renderDebugBar();
      quickOpen.close();
      openAny.close();
      closeMenu();
      find.reset();
      closeDiff();
      blank();
      mediaEl.replaceChildren();

      fileIndex = null;
      fileIndexPromise = null;
      treeQuery = "";
      filterInput.value = "";
      renderRelated();
      // Restoring a workspace means putting its last file back on screen, not just its tabs.
      const resume = current.activePath && tabs.has(current.activePath) ? current.activePath : null;
      if (resume) activate(resume);
      else renderTabs();
      gitStates = new Map();
      gitFolders = new Set();
      void loadTreeRoot(projectId);
      void refreshGit(projectId);
      // Parse the project now, so the first Related row answers at once instead of after a
      // cold scan. Repeats are cheap: only changed files are read again.
      void invoke("warm_code_nav", { project: projectId }).catch(() => undefined);
      void invoke<Record<string, number[]>>("debug_breakpoints", { project: projectId })
        .then((stored) => {
          if (project !== projectId) return;
          breakpoints = new Map(
            Object.entries(stored).map(([path, lines]) => [path, new Set(lines)]),
          );
          if (activePath) code.setBreakpoints([...(breakpoints.get(activePath) ?? [])]);
        })
        .catch((error) => {
          if (project === projectId) fail(`Could not load breakpoints — ${message(error)}`);
        });
    },

    open: openFile,

    closeActiveTab(): boolean {
      if (!activePath) return false;
      void closeTab(activePath);
      return true;
    },

    activateSlot(slot: number): boolean {
      const path = order[slot - 1];
      if (!path) return false;
      activate(path);
      view.focus();
      return true;
    },

    async openDocument(path: string, draft = ""): Promise<void> {
      if (!project) throw new Error("No project selected.");
      const created = await invoke<string>("ensure_document", {
        project,
        path,
        contents: draft,
      });
      await openFile(created);
      view.focus();
    },

    async finishDocument(path: string): Promise<string> {
      if (!project) throw new Error("No project selected.");
      const tab = findTab(path);
      if (tab && tab.kind === "text") return isDirty(tab) ? saveTab(tab) : tab.state.doc.toString();
      return invoke<string>("read_file", { project, path });
    },

    markDirty(path: string): void {
      relationCache.clear();
      fileIndex = null; // the agent may have created or removed a file
      if (project) void refreshGit(project);
      // The agent may have created this file. The tree learns now, not on the next switch.
      const relative = projectPath && path.startsWith(`${projectPath}/`) ? path.slice(projectPath.length + 1) : path;
      void reloadFolder(dirname(relative).replace(/\/$/, ""));
      if (activePath) void refreshRelationships(activePath, true);
      const tab = findTab(path);
      if (!tab || tab.kind !== "text") return; // not open, or not a text buffer — nothing to reconcile
      if (!project) return;
      const here = project;

      void (async () => {
        let text: string;
        try {
          text = await invoke<string>("read_file", { project: here, path: tab.path });
        } catch (error) {
          fail(`${tab.name} changed on disk but could not be read — ${message(error)}`);
          return;
        }
        if (project !== here || !tabs.has(tab.path)) return; // switched away while reading

        if (tab.state.doc.toString() === text) {
          // The agent landed on what the human already had. Nothing is in tension.
          tab.saved = tab.state.doc;
          tab.conflict = false;
          tab.incoming = null;
          renderTabs();
          return;
        }
        if (!isDirty(tab)) {
          // Nothing of theirs to lose: take the agent's write and flash the tab so the change
          // is not silent.
          applyDisk(tab, text);
          renderTabs();
          if (tab.path === activePath) paintChanges();
          flashTab(tab.path);
          return;
        }
        // Both sides have work. Park the agent's copy, keep the human's buffer untouched, and
        // let them choose. Nothing is written and nothing is discarded until they do.
        tab.conflict = true;
        tab.incoming = text;
        renderTabs();
        flashTab(tab.path);
      })();
    },
  };
}
