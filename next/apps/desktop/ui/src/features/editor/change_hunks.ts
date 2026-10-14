/** Git change bars, their inline hunk preview, and the undoable revert action. */

import { RangeSet, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  GutterMarker,
  gutter,
} from "@codemirror/view";
import { analyzeChanges, revertedHunk, type DiffAnalysis, type DiffHunk } from "./diff";
import { overviewSources, type OverviewMark, type OverviewTone } from "./minimap";

export type StageHunk = {
  path: string;
  /** A current-file line inside the Git hunk. */
  line: number;
};

export type ChangeHunkActions = {
  stage?(hunk: StageHunk): Promise<void>;
  failed?(message: string): void;
};

const setChangeBase = StateEffect.define<string | null>();

class ChangeMarker extends GutterMarker {
  constructor(readonly kind: OverviewTone) {
    super();
  }

  eq(other: ChangeMarker): boolean {
    return other.kind === this.kind;
  }

  toDOM(): HTMLElement {
    const bar = document.createElement("span");
    bar.className = `cm-change cm-change-${this.kind}`;
    bar.title = "Preview this hunk";
    return bar;
  }
}

const markers: Record<string, ChangeMarker> = {
  added: new ChangeMarker("added"),
  modified: new ChangeMarker("modified"),
  deleted: new ChangeMarker("deleted"),
};

type ChangeModel = {
  base: string | null;
  analysis: DiffAnalysis | null;
  marks: RangeSet<GutterMarker>;
};

function markerSet(state: EditorState, analysis: DiffAnalysis | null): RangeSet<GutterMarker> {
  if (!analysis) return RangeSet.empty;
  const at = new Map<number, GutterMarker>();
  for (const line of analysis.deleted) at.set(line, markers.deleted);
  for (const line of analysis.added) at.set(line, markers.added);
  for (const line of analysis.modified) at.set(line, markers.modified);
  return RangeSet.of(
    [...at.entries()]
      .filter(([line]) => line >= 1 && line <= state.doc.lines)
      .sort((a, b) => a[0] - b[0])
      .map(([line, marker]) => marker.range(state.doc.line(line).from)),
    true,
  );
}

const openPopovers = new WeakMap<EditorView, () => void>();

export function closeChangePopover(view: EditorView): void {
  openPopovers.get(view)?.();
}

function errorText(error: unknown): string {
  return typeof error === "string" ? error : error instanceof Error ? error.message : String(error);
}

function minimalChange(before: string, after: string): { from: number; to: number; insert: string } {
  let from = 0;
  while (from < before.length && from < after.length && before[from] === after[from]) from += 1;
  let tail = 0;
  while (
    tail < before.length - from &&
    tail < after.length - from &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) tail += 1;
  return {
    from,
    to: before.length - tail,
    insert: after.slice(from, after.length - tail),
  };
}

function hunkAt(hunks: readonly DiffHunk[], line: number): DiffHunk | null {
  return hunks.find((hunk) => line >= hunk.fromLine && line <= hunk.toLine) ?? null;
}

function openPopover(
  view: EditorView,
  path: string,
  hunk: DiffHunk,
  event: MouseEvent,
  actions: ChangeHunkActions,
): void {
  closeChangePopover(view);
  const root = document.createElement("section");
  root.className = "cm-hunk-popover";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", `Changes on lines ${hunk.fromLine} to ${hunk.toLine}`);

  const head = document.createElement("header");
  const title = document.createElement("b");
  title.textContent = hunk.fromLine === hunk.toLine
    ? `Line ${hunk.fromLine}`
    : `Lines ${hunk.fromLine}–${hunk.toLine}`;
  const actionsEl = document.createElement("span");

  const body = document.createElement("pre");
  body.className = "cm-hunk-preview";
  for (const row of hunk.preview.slice(0, 80)) {
    const line = document.createElement("span");
    line.className = `cm-hunk-row is-${row.kind}`;
    const number = document.createElement("i");
    number.textContent = String(row.after ?? row.before ?? "");
    const sign = document.createElement("b");
    sign.textContent = row.kind === "add" ? "+" : row.kind === "del" ? "−" : " ";
    const text = document.createElement("code");
    text.textContent = row.text;
    line.append(number, sign, text);
    body.append(line);
  }

  const note = document.createElement("small");
  note.className = "cm-hunk-note";

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener("pointerdown", dismiss, true);
    document.removeEventListener("keydown", escape, true);
    root.remove();
    openPopovers.delete(view);
  };
  const dismiss = (next: PointerEvent): void => {
    if (!root.contains(next.target as Node)) close();
  };
  const escape = (next: KeyboardEvent): void => {
    if (next.key === "Escape") close();
  };

  if (actions.stage) {
    const stage = document.createElement("button");
    stage.type = "button";
    stage.textContent = "Stage hunk";
    stage.addEventListener("click", () => {
      stage.disabled = true;
      note.textContent = "Staging…";
      void actions.stage!({ path, line: hunk.line }).then(() => {
        stage.textContent = "Staged";
        note.textContent = "This hunk is ready to commit.";
      }).catch((error) => {
        stage.disabled = false;
        note.textContent = errorText(error);
        actions.failed?.(errorText(error));
      });
    });
    actionsEl.append(stage);
  }

  const revert = document.createElement("button");
  revert.type = "button";
  revert.className = "is-danger";
  revert.textContent = "Revert hunk";
  revert.title = "Restore these lines from HEAD. Undo remains available.";
  revert.addEventListener("click", () => {
    const current = view.state.doc.toString();
    const next = revertedHunk(current, hunk);
    if (next !== current) view.dispatch({ changes: minimalChange(current, next) });
    close();
    view.focus();
  });
  actionsEl.append(revert);

  head.append(title, actionsEl);
  root.append(head, body, note);
  view.dom.append(root);
  openPopovers.set(view, close);

  const editor = view.dom.getBoundingClientRect();
  const box = root.getBoundingClientRect();
  const left = Math.max(6, Math.min(event.clientX - editor.left + 8, editor.width - box.width - 6));
  const top = Math.max(6, Math.min(event.clientY - editor.top - 10, editor.height - box.height - 6));
  root.style.left = `${left}px`;
  root.style.top = `${top}px`;
  window.setTimeout(() => {
    if (closed) return;
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", escape, true);
  });
}

export function changeGutter(path: string, actions: ChangeHunkActions): Extension {
  const field = StateField.define<ChangeModel>({
    create: () => ({ base: null, analysis: null, marks: RangeSet.empty }),
    update(value, transaction) {
      let next: ChangeModel = { ...value, marks: value.marks.map(transaction.changes) };
      for (const effect of transaction.effects) {
        if (!effect.is(setChangeBase)) continue;
        const base = effect.value;
        const analysis = base === null
          ? null
          : analyzeChanges(base, transaction.state.doc.toString());
        next = { base, analysis, marks: markerSet(transaction.state, analysis) };
      }
      return next;
    },
    provide: (source) =>
      gutter({
        class: "cm-change-gutter",
        markers: (view) => view.state.field(source).marks,
        initialSpacer: () => markers.modified,
        domEventHandlers: {
          mousedown(view, line, event) {
            if (!(event instanceof MouseEvent) || event.button !== 0) return false;
            const model = view.state.field(source);
            const number = view.state.doc.lineAt(line.from).number;
            const hunk = model.analysis ? hunkAt(model.analysis.hunks, number) : null;
            if (!hunk) return false;
            event.preventDefault();
            openPopover(view, path, hunk, event, actions);
            return true;
          },
        },
      }),
  });
  return [
    field,
    // The same marks, for the minimap's whole-file strip: a change scrolled off screen is still
    // a change, and the strip is where a long file says so.
    overviewSources.of((state) => {
      const found: OverviewMark[] = [];
      state.field(field).marks.between(0, state.doc.length, (from, _to, marker) => {
        found.push({ line: state.doc.lineAt(from).number, tone: (marker as ChangeMarker).kind });
      });
      return found;
    }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) closeChangePopover(update.view);
    }),
  ];
}

export function setChangeDocument(view: EditorView, base: string | null): void {
  closeChangePopover(view);
  view.dispatch({ effects: setChangeBase.of(base) });
}
