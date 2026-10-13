/**
 * The one text editor in Panel.
 *
 * Every surface that lets a human type into a file mounts THIS. There is no second CodeMirror
 * configuration anywhere: same keymap, same gutters, same minimap, same Xcode palette, same
 * zoom, same jump-and-flash. A change here moves every editor at once, which is the point.
 *
 * Theme and font ride module-level Compartments, and every live editor is in one registry, so a
 * theme toggle or a ⌘+ lands on all of them in the same frame — an editor cannot drift out of
 * step with its neighbour just because it was mounted later.
 *
 * Hosts differ only in what they do AROUND the buffer: the Work tab parks many states and
 * swaps them (tabs); a host may keep exactly one. Both go through `createState` / `show`, so
 * off-screen states are reconfigured too and switching back can never resurrect an old palette.
 */

import { Compartment, EditorState, RangeSet, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  crosshairCursor,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  highlightTrailingWhitespace,
  gutter,
  hoverTooltip,
  keymap,
  lineNumbers,
  rectangularSelection,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { gotoLine, highlightSelectionMatches, search, searchKeymap, selectNextOccurrence, selectSelectionMatches } from "@codemirror/search";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit } from "@codemirror/language";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completeAnyWord,
  completionKeymap,
} from "@codemirror/autocomplete";
import { currentMode, themePacks, type ThemeMode } from "./theme";
import { minimap } from "./minimap";
import { fileExtension, languageFor } from "./languages";
import { indentGuides } from "./indent_guides";
import { stickyScroll } from "./sticky_scroll";
import {
  changeGutter,
  closeChangePopover,
  setChangeDocument,
  type StageHunk,
} from "./change_hunks";
import "./editor.css";

/* ------------------------------------------------------------------- flash */

/** A one-shot line highlight. Set on jump, cleared by the fade's own timeout. */
const setFlash = StateEffect.define<number | null>();
const flashDeco = Decoration.line({ class: "cm-flashLine" });

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setFlash)) continue;
      next = effect.value === null ? Decoration.none : Decoration.set([flashDeco.range(effect.value)]);
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/* ---------------------------------------------------------- execution line */

/*
 * Where the program is stopped right now.
 *
 * The flash above is a one-shot: it says "your jump landed here" and fades. A paused debugger
 * needs the opposite — a mark that STAYS until the program moves, because the whole time it is
 * paused the question is "which line am I on". So this is a separate field with no timer, set
 * and cleared by the debug bar rather than by a jump.
 */
const setExec = StateEffect.define<number | null>();
const execDeco = Decoration.line({ class: "cm-execLine" });

const execField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setExec)) continue;
      next = effect.value === null ? Decoration.none : Decoration.set([execDeco.range(effect.value)]);
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * The word under the pointer, as an expression.
 *
 * Deliberately naive: an identifier, plus the dotted path it hangs off, and nothing more. A real
 * expression parser would occasionally read further and get it wrong, and a wrong value is worse
 * than no value when you are deciding whether a bug is here or upstream.
 */
const NAME = /[A-Za-z_$][\w$]*/;

function expressionAt(view: EditorView, pos: number): { from: number; to: number; text: string } | null {
  const line = view.state.doc.lineAt(pos);
  const offset = pos - line.from;
  let from = offset;
  let to = offset;
  const body = line.text;
  const wordy = (ch: string): boolean => NAME.test(ch);
  while (from > 0 && wordy(body[from - 1])) from -= 1;
  while (to < body.length && wordy(body[to])) to += 1;
  if (from === to) return null;
  // Walk back over `a.b.` so hovering `name` inside `user.profile.name` asks about the whole path.
  let start = from;
  while (start > 1 && body[start - 1] === ".") {
    let back = start - 1;
    while (back > 0 && wordy(body[back - 1])) back -= 1;
    if (back === start - 1) break;
    start = back;
  }
  const text = body.slice(start, to);
  if (!text || !NAME.test(text[0])) return null;
  return { from: line.from + start, to: line.from + to, text };
}

function valueTooltip(resolve: HoverValue): Extension {
  return hoverTooltip(async (view, pos) => {
    const found = expressionAt(view, pos);
    if (!found) return null;
    const value = await resolve(found.text);
    if (value === null) return null;
    return {
      pos: found.from,
      end: found.to,
      above: true,
      create: () => {
        const dom = document.createElement("div");
        dom.className = "cm-valueTip";
        const name = document.createElement("b");
        name.textContent = found.text;
        const body = document.createElement("span");
        body.textContent = value;
        dom.append(name, body);
        return { dom };
      },
    };
  }, { hoverTime: 220 });
}

/* ------------------------------------------------------------ breakpoints */

const setBreakpointLines = StateEffect.define<readonly number[]>();

class BreakpointMarker extends GutterMarker {
  toDOM(): HTMLElement {
    const dot = document.createElement("span");
    dot.className = "cm-breakpoint-dot";
    return dot;
  }
}

const breakpointMarker = new BreakpointMarker();

function breakpointSet(state: EditorState, lines: readonly number[]): RangeSet<GutterMarker> {
  const ranges = lines
    .filter((line) => line >= 1 && line <= state.doc.lines)
    .map((line) => breakpointMarker.range(state.doc.line(line).from));
  return RangeSet.of(ranges, true);
}

function breakpointGutter(path: string, options: CodeEditorOptions): Extension {
  const field = StateField.define<RangeSet<GutterMarker>>({
    create: (state) => breakpointSet(state, options.breakpoints?.(path) ?? []),
    update(markers, transaction) {
      let next = markers.map(transaction.changes);
      for (const effect of transaction.effects) {
        if (effect.is(setBreakpointLines)) next = breakpointSet(transaction.state, effect.value);
      }
      return next;
    },
    provide: (source) =>
      gutter({
        class: "cm-breakpoint-gutter",
        markers: (view) => view.state.field(source),
        initialSpacer: () => breakpointMarker,
        domEventHandlers: {
          mousedown(view, line, event) {
            if (!(event instanceof MouseEvent) || event.button !== 0) return false;
            const number = view.state.doc.lineAt(line.from).number;
            options.onToggleBreakpoint?.(path, number);
            return true;
          },
        },
      }),
  });
  return field;
}

/* ------------------------------------------------------------- indentation */

/**
 * What the file already does, so Tab does the same. A Python file indented by four must not
 * get two spaces from a default nobody chose. Tabs win when any indented line uses one; among
 * spaces, the most common step between consecutive indented lines wins, with 2 as the tie.
 */
function detectIndent(text: string): string {
  let tabs = 0;
  const steps = new Map<number, number>();
  let previous = 0;
  let seen = 0;
  const lines = text.split("\n", 4000);
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line[0] === "\t") {
      tabs += 1;
      continue;
    }
    let spaces = 0;
    while (spaces < line.length && line[spaces] === " ") spaces += 1;
    const delta = Math.abs(spaces - previous);
    if (delta > 0 && delta <= 8) {
      steps.set(delta, (steps.get(delta) ?? 0) + 1);
      seen += 1;
    }
    previous = spaces;
  }
  if (tabs > seen) return "\t";
  let best = 2;
  let votes = 0;
  for (const [step, count] of steps) {
    if (count > votes || (count === votes && step < best)) {
      best = step;
      votes = count;
    }
  }
  return " ".repeat(best);
}

/** "Tab" or "2 spaces" — for the status bar. */
export function indentLabel(state: EditorState): string {
  const unit = state.facet(indentUnit);
  return unit.includes("\t") ? "Tab" : `${unit.length} spaces`;
}

/* -------------------------------------------------------------------- wrap */

/*
 * Line wrapping is per buffer, not per app. Prose wants it — a Markdown paragraph that runs off
 * the right edge is unreadable — and code does not, because indentation is structure and a
 * wrapped line lies about its depth. The default follows the file; the status bar flips it.
 */
const PROSE_EXTENSIONS = new Set(["md", "markdown", "txt", "text", "rst", "adoc", ""]);

const wrapCompartment = new Compartment();
const setWrap = StateEffect.define<boolean>();
const wrapField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setWrap)) return effect.value;
    return value;
  },
});

const wrapExtension = (on: boolean): Extension => (on ? EditorView.lineWrapping : []);

export const wrapsByDefault = (path: string): boolean => PROSE_EXTENSIONS.has(fileExtension(path));

/* -------------------------------------------------------------- zoom, theme */

const FONT_SIZE_KEY = "panel.editor.font-size";
/** Where the Work tab kept its zoom before the editor was shared. Read once, never written. */
const LEGACY_FONT_SIZE_KEY = "panel.files.font-size";
const FONT_MIN = 9;
const FONT_MAX = 28;
const FONT_DEFAULT = 13;

/* One Compartment instance is a KEY, not state — every editor's state can carry the same two,
   which is what lets a single reconfigure sweep them all. */
const themeCompartment = new Compartment();
const fontCompartment = new Compartment();

const fontExtension = (size: number): Extension => EditorView.theme({ "&": { fontSize: `${size}px` } });

function storedFontSize(): number {
  try {
    for (const key of [FONT_SIZE_KEY, LEGACY_FONT_SIZE_KEY]) {
      const stored = Number(localStorage.getItem(key));
      if (Number.isFinite(stored) && stored >= FONT_MIN && stored <= FONT_MAX) return stored;
    }
  } catch {
    /* storage unavailable — the default size stands */
  }
  return FONT_DEFAULT;
}

let fontSize = storedFontSize();
let themeMode: ThemeMode = currentMode();

/** Every mounted editor. Theme and zoom are app-wide, so they are applied across this set. */
const live = new Set<Instance>();

type Instance = {
  view: EditorView;
  options: CodeEditorOptions;
};

/** Push a compartment change into one editor: the live view, then the host's parked states. */
function reconfigure(instance: Instance, effect: StateEffect<unknown>): void {
  instance.view.dispatch({ effects: effect });
  instance.options.onReconfigure?.((state) => state.update({ effects: effect }).state);
}

/**
 * The app theme toggled. Every live view syncs immediately; every parked state gets the same
 * reconfigure applied off-screen so switching to it later cannot resurrect the old palette.
 */
function onThemeChange(): void {
  const mode = currentMode();
  if (mode === themeMode) return;
  themeMode = mode;
  const effect = themeCompartment.reconfigure(themePacks[mode]);
  for (const instance of live) reconfigure(instance, effect);
}
window.addEventListener("panel-theme-change", onThemeChange);

/** Zoom the code, everywhere, clamped and persisted. */
function setFontSize(size: number): void {
  const clamped = Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(size)));
  if (clamped === fontSize) return;
  fontSize = clamped;
  const effect = fontCompartment.reconfigure(fontExtension(clamped));
  for (const instance of live) reconfigure(instance, effect);
  try {
    localStorage.setItem(FONT_SIZE_KEY, String(clamped));
  } catch {
    /* storage unavailable — zoom still holds for this session */
  }
}

const zoomIn = (): boolean => (setFontSize(fontSize + 1), true);
const zoomOut = (): boolean => (setFontSize(fontSize - 1), true);
const zoomReset = (): boolean => (setFontSize(FONT_DEFAULT), true);

/* ------------------------------------------------------------------ editor */

/*
 * Hovering a name while the debugger is paused.
 *
 * The Debug tab already has a variables tree and a REPL; this is neither. It is the one question
 * you ask twenty times per pause — "what is THIS right now" — answered where your eye already is,
 * without typing the name into a prompt on another screen.
 */
export type HoverValue = (expression: string) => Promise<string | null>;

export type CodeEditorOptions = {
  /** The element the CodeMirror view is appended to. */
  parent: HTMLElement;
  /**
   * Resolve the identifier under the pointer to a value, or null when there is nothing to say.
   * Called only after the reader rests on a word, so it is free to go out to a debug adapter.
   */
  hoverValue?: HoverValue;
  /**
   * Watched for visibility instead of `parent`, when the pane that can be hidden is an
   * ancestor. An editor built inside `display:none` caches a zero-size geometry — the gutter
   * prints line numbers but the content viewport never paints — so it re-measures the instant
   * it becomes visible. Revealing the tab is then enough; no scroll or keystroke needed.
   */
  visibilityHost?: HTMLElement;
  /** ⌘/Ctrl+S. The host owns what "save" means and where it writes. */
  onSave?(): void;
  /** Fired for every view update, doc change or not. */
  onUpdate?(update: ViewUpdate): void;
  /**
   * The host parks states off-screen (tabs). Called on any theme or zoom change: map each
   * parked state through `apply` and store the result. Single-buffer hosts omit it.
   */
  onReconfigure?(apply: (state: EditorState) => EditorState): void;
  /** Initial breakpoint lines for a file. Omit both hooks for non-code editors. */
  breakpoints?(path: string): readonly number[];
  /** A click in the breakpoint gutter. The host persists and reapplies the full line set. */
  onToggleBreakpoint?(path: string, line: number): void;
  /** Draw the git change gutter. The host feeds it through `setChanges`. */
  changeBars?: boolean;
  /** Stage one clicked gutter hunk. Only Work supplies this Git-owned action. */
  onStageHunk?(hunk: StageHunk): Promise<void>;
  /** Surface a hunk action failure in the host's normal status affordance. */
  onHunkError?(message: string): void;
  /** Host-specific extensions appended to every state this editor builds. */
  extra?: Extension[];
};

export type CodeEditor = {
  /** The live view. Reach for it only for things this handle deliberately does not wrap. */
  readonly view: EditorView;
  /** Build a state for a buffer — the full pack, plus the language `path` implies. */
  createState(path: string, text: string): EditorState;
  /** Whether the live buffer wraps long lines. */
  wrapped(): boolean;
  /** Flip wrapping on the live buffer only. Other buffers keep their own answer. */
  setWrap(on: boolean): void;
  /** Put a state on screen and re-measure (the pane may have just been revealed). */
  show(state: EditorState): void;
  /** Build and show in one step. The single-buffer path. */
  load(path: string, text: string): void;
  /** Nothing open: an empty, chrome-free buffer that still carries theme and zoom. */
  blank(): void;
  /** Current buffer contents. */
  doc(): string;
  /** Overwrite the buffer in place, keeping the caret roughly where it was. */
  replaceDoc(text: string): void;
  /** Land the eye on a 1-indexed line: select it, centre it, flash it, release it. */
  jumpTo(line: number): void;
  /** Replace the breakpoint markers in the live buffer. */
  setBreakpoints(lines: readonly number[]): void;
  /** Compare the live buffer to this HEAD text. Null clears the change gutter. */
  setChanges(base: string | null): void;
  /**
   * Mark the line the debugger is stopped on, or clear it with null. Unlike `jumpTo`'s flash
   * this does not fade: it is the answer to "where am I" for as long as the program is paused.
   */
  setExecLine(line: number | null): void;
  destroy(): void;
};

export function createCodeEditor(options: CodeEditorOptions): CodeEditor {
  options.parent.classList.add("panel-editor");
  const view = new EditorView({ parent: options.parent });
  const instance: Instance = { view, options };
  live.add(instance);

  const visibility = new IntersectionObserver((entries) => {
    for (const entry of entries) if (entry.isIntersecting) view.requestMeasure();
  });
  visibility.observe(options.visibilityHost ?? options.parent);

  // ⌘/Ctrl + wheel (and trackpad pinch, which the OS reports as ctrl+wheel) zooms too.
  const onWheel = (event: WheelEvent): void => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    setFontSize(fontSize + (event.deltaY < 0 ? 1 : -1));
  };
  options.parent.addEventListener("wheel", onWheel, { passive: false });

  let flashTimer = 0;

  function createState(path: string, text: string): EditorState {
    const wrap = wrapsByDefault(path);
    return EditorState.create({
      doc: text,
      extensions: [
        indentUnit.of(detectIndent(text)),
        wrapField.init(() => wrap),
        wrapCompartment.of(wrapExtension(wrap)),
        ...(options.onToggleBreakpoint ? [breakpointGutter(path, options)] : []),
        ...(options.changeBars
          ? [changeGutter(path, { stage: options.onStageHunk, failed: options.onHunkError })]
          : []),
        lineNumbers(),
        highlightActiveLineGutter(),
        foldGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        highlightTrailingWhitespace(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        bracketMatching(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        rectangularSelection(),
        crosshairCursor(),
        /* Xcode's find bar sits at the TOP of the editor, not the bottom. */
        search({ top: true }),
        /* Quotes and brackets close themselves, and typing the closer skips over it. */
        closeBrackets(),
        /* Completion. Language packs contribute their own sources; every language also gets
           words already in the document, which is what actually helps in a prose file or
           a config file where no grammar knows the vocabulary. */
        autocompletion(),
        EditorState.languageData.of(() => [{ autocomplete: completeAnyWord }]),
        /* ⌃⇧click adds a cursor, as in Xcode. ⌘click is left to the pane — in the Work tab it
           means "jump to the definition", and it falls through to adding a cursor only when
           there is no symbol under the pointer. */
        EditorView.clickAddsSelectionRange.of(
          (event) => (event.ctrlKey && event.shiftKey) || event.metaKey,
        ),
        indentGuides(),
        stickyScroll(),
        minimap(),
        flashField,
        execField,
        ...(options.hoverValue ? [valueTooltip(options.hoverValue)] : []),
        keymap.of([
          /* Completion and bracket keys go first — they must win over the plain editing
             bindings while a tooltip is open, or Escape and the arrows land in the document. */
          ...closeBracketsKeymap,
          ...completionKeymap,
          /* Multi-cursor. ⌘D FINDS AND SELECTS the next occurrence — it never duplicates
             anything. It is bound here rather than left to `searchKeymap` at the bottom of
             this array so nothing added later can quietly shadow it. ⌥⌘E is Xcode's name for
             the same move; ⌃⌘E and ⌘⇧L take every occurrence at once. */
          { key: "Mod-d", preventDefault: true, run: selectNextOccurrence },
          { key: "Mod-Alt-e", preventDefault: true, run: selectNextOccurrence },
          { key: "Mod-Ctrl-e", preventDefault: true, run: selectSelectionMatches },
          /* Xcode puts Go to Line on ⌘L. CodeMirror's own ⌥⌘G still works. */
          { key: "Mod-l", preventDefault: true, run: gotoLine },
          ...(options.onToggleBreakpoint
            ? [{
                key: "F9",
                preventDefault: true,
                run: (target: EditorView) => {
                  options.onToggleBreakpoint?.(
                    path,
                    target.state.doc.lineAt(target.state.selection.main.head).number,
                  );
                  return true;
                },
              }]
            : []),
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              options.onSave?.();
              return true;
            },
          },
          { key: "Mod-=", preventDefault: true, run: zoomIn },
          { key: "Mod-+", preventDefault: true, run: zoomIn },
          { key: "Mod--", preventDefault: true, run: zoomOut },
          { key: "Mod-0", preventDefault: true, run: zoomReset },
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          ...foldKeymap,
        ]),
        themeCompartment.of(themePacks[themeMode]),
        fontCompartment.of(fontExtension(fontSize)),
        EditorView.updateListener.of((update) => options.onUpdate?.(update)),
        ...(options.extra ?? []),
        ...languageFor(path),
      ],
    });
  }

  function show(state: EditorState): void {
    closeChangePopover(view);
    view.setState(state);
    view.requestMeasure();
  }

  return {
    view,
    createState,
    show,
    load: (path, text) => show(createState(path, text)),
    blank() {
      closeChangePopover(view);
      view.setState(
        EditorState.create({
          doc: "",
          extensions: [
            themeCompartment.of(themePacks[themeMode]),
            fontCompartment.of(fontExtension(fontSize)),
          ],
        }),
      );
    },
    doc: () => view.state.doc.toString(),
    wrapped: () => view.state.field(wrapField, false) ?? false,
    setWrap(on) {
      if (!view.state.field(wrapField, false) === !on) return;
      view.dispatch({ effects: [setWrap.of(on), wrapCompartment.reconfigure(wrapExtension(on))] });
    },
    replaceDoc(text) {
      const head = Math.min(view.state.selection.main.head, text.length);
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: head },
      });
    },
    jumpTo(line) {
      const doc = view.state.doc;
      const target = doc.line(Math.max(1, Math.min(line, doc.lines)));
      view.dispatch({
        selection: { anchor: target.from },
        effects: [setFlash.of(target.from), EditorView.scrollIntoView(target.from, { y: "center" })],
      });
      view.focus();
      window.clearTimeout(flashTimer);
      flashTimer = window.setTimeout(() => {
        view.dispatch({ effects: setFlash.of(null) });
      }, 1100);
    },
    setBreakpoints(lines) {
      view.dispatch({ effects: setBreakpointLines.of(lines) });
    },
    setChanges(base) {
      if (!options.changeBars) return;
      setChangeDocument(view, base);
    },
    setExecLine(line) {
      const doc = view.state.doc;
      if (line === null || line < 1 || line > doc.lines) {
        view.dispatch({ effects: setExec.of(null) });
        return;
      }
      const target = doc.line(line);
      view.dispatch({
        effects: [setExec.of(target.from), EditorView.scrollIntoView(target.from, { y: "center" })],
      });
    },
    destroy() {
      window.clearTimeout(flashTimer);
      closeChangePopover(view);
      options.parent.removeEventListener("wheel", onWheel);
      options.parent.classList.remove("panel-editor");
      visibility.disconnect();
      live.delete(instance);
      view.destroy();
    },
  };
}
