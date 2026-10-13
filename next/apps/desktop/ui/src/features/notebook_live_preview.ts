/** Obsidian-style live Markdown inside the editable CodeMirror surface. */

import type { Extension, Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";

class TaskWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly from: number,
  ) {
    super();
  }

  eq(other: TaskWidget): boolean {
    return other.checked === this.checked && other.from === this.from;
  }

  toDOM(view: EditorView): HTMLElement {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = this.checked;
    input.className = "note-live-task";
    input.addEventListener("mousedown", (event) => event.stopPropagation());
    input.addEventListener("change", () => {
      view.dispatch({
        changes: {
          from: this.from,
          to: this.from + 3,
          insert: input.checked ? "[x]" : "[ ]",
        },
      });
    });
    return input;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

const hidden = Decoration.replace({});
const inlineToken = /(\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*]+\*|_[^_]+_)/g;

function inline(
  ranges: Range<Decoration>[],
  text: string,
  from: number,
  preview: boolean,
): void {
  for (const match of text.matchAll(inlineToken)) {
    const token = match[0];
    const start = from + (match.index ?? 0);
    let edge = 1;
    let className = "note-live-em";
    if (token.startsWith("**") || token.startsWith("__")) {
      edge = 2;
      className = "note-live-strong";
    } else if (token.startsWith("~~")) {
      edge = 2;
      className = "note-live-strike";
    } else if (token.startsWith("`")) {
      className = "note-live-code";
    } else if (token.startsWith("[")) {
      const split = token.indexOf("](");
      if (split < 0) continue;
      ranges.push(
        Decoration.mark({ class: "note-live-link" }).range(start + 1, start + split),
      );
      if (preview) {
        ranges.push(hidden.range(start, start + 1));
        ranges.push(hidden.range(start + split, start + token.length));
      }
      continue;
    }
    ranges.push(
      Decoration.mark({ class: className }).range(start + edge, start + token.length - edge),
    );
    if (preview) {
      ranges.push(hidden.range(start, start + edge));
      ranges.push(hidden.range(start + token.length - edge, start + token.length));
    }
  }
}

function decorations(view: EditorView, preview: boolean): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  let fenced = false;

  for (let number = 1; number <= view.state.doc.lines; number += 1) {
    const line = view.state.doc.line(number);
    const text = line.text;
    let contentAt = 0;

    const fence = /^\s*```/.exec(text);
    if (fence) {
      ranges.push(Decoration.line({ class: "note-live-fence" }).range(line.from));
      if (preview) ranges.push(hidden.range(line.from, line.to));
      fenced = !fenced;
    } else if (fenced) {
      ranges.push(Decoration.line({ class: "note-live-codeblock" }).range(line.from));
    } else {
      const heading = /^(#{1,6})\s+/.exec(text);
      if (heading) {
        ranges.push(
          Decoration.line({ class: `note-live-heading note-live-h${heading[1].length}` }).range(
            line.from,
          ),
        );
        contentAt = heading[0].length;
        if (preview) ranges.push(hidden.range(line.from, line.from + contentAt));
      }

      const quote = /^\s*>\s?/.exec(text);
      if (quote) {
        ranges.push(Decoration.line({ class: "note-live-quote" }).range(line.from));
        contentAt = quote[0].length;
        if (preview) ranges.push(hidden.range(line.from, line.from + contentAt));
      }

      const task = /^(\s*[-*+]\s+)(\[[ xX]\])\s+/.exec(text);
      if (task) {
        const taskFrom = line.from + task[1].length;
        ranges.push(preview
          ? Decoration.replace({
              widget: new TaskWidget(task[2].toLowerCase() === "[x]", taskFrom),
            }).range(taskFrom, taskFrom + 3)
          : Decoration.mark({ class: "note-live-task-mark" }).range(taskFrom, taskFrom + 3));
        contentAt = task[0].length;
      }

      if (/^\s*(---+|___+|\*\*\*+)\s*$/.test(text)) {
        ranges.push(Decoration.line({ class: "note-live-rule" }).range(line.from));
        if (preview) ranges.push(hidden.range(line.from, line.to));
      } else {
        inline(ranges, text.slice(contentAt), line.from + contentAt, preview);
      }
    }
  }

  ranges.sort((left, right) => left.from - right.from || left.to - right.to);
  return Decoration.set(ranges, true);
}

export function notebookLivePreview(preview: boolean): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = decorations(view, preview);
      }

      update(update: ViewUpdate): void {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = decorations(update.view, preview);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}
