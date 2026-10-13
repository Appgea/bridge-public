/** Visible-only indentation guides. No document marks, no full-file pass. */

import { RangeSetBuilder, type Extension } from "@codemirror/state";
import { getIndentUnit } from "@codemirror/language";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";

function indentation(text: string, tabSize: number): number {
  let columns = 0;
  for (const character of text) {
    if (character === " ") columns += 1;
    else if (character === "\t") columns += tabSize - (columns % tabSize);
    else break;
  }
  return columns;
}

function guides(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const unit = Math.max(1, getIndentUnit(view.state));
  const tabSize = view.state.tabSize;
  for (const range of view.visibleRanges) {
    let position = range.from;
    while (position <= range.to) {
      const line = view.state.doc.lineAt(position);
      const columns = indentation(line.text, tabSize);
      if (columns >= unit) {
        builder.add(
          line.from,
          line.from,
          Decoration.line({
            class: "cm-indent-guided",
            attributes: {
              style: `--cm-indent-columns:${columns};--cm-indent-unit:${unit}`,
            },
          }),
        );
      }
      if (line.to >= range.to || line.to === view.state.doc.length) break;
      position = line.to + 1;
    }
  }
  return builder.finish();
}

export function indentGuides(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = guides(view);
      }

      update(update: ViewUpdate): void {
        if (update.docChanged || update.viewportChanged) this.decorations = guides(update.view);
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}
