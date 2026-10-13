/** Nested scope headers pinned above the first visible source line. */

import type { Extension } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { highlightTree } from "@lezer/highlight";
import type { SyntaxNode } from "@lezer/common";
import { currentMode, highlightStyles } from "./theme";

type Header = { line: number; text: string };

/**
 * The header line, with the same token classes the buffer paints it in. A pinned header in
 * plain grey read as a different file; this walks the live syntax tree over just that line and
 * emits the same scoped class names the theme already has rules for.
 */
function highlightedLine(view: EditorView, line: number): HTMLElement {
  const code = document.createElement("code");
  const doc = view.state.doc;
  const range = doc.line(line);
  const text = range.text;
  const lead = text.search(/\S|$/);
  const from = range.from + lead;
  let at = from;
  const push = (to: number, classes: string | null): void => {
    if (to <= at) return;
    const chunk = doc.sliceString(at, to);
    if (classes) {
      const span = document.createElement("span");
      span.className = classes;
      span.textContent = chunk;
      code.append(span);
    } else {
      code.append(chunk);
    }
    at = to;
  };
  highlightTree(
    syntaxTree(view.state),
    highlightStyles[currentMode()],
    (start, end, classes) => {
      push(Math.max(start, from), null);
      push(Math.min(end, range.to), classes);
    },
    from,
    range.to,
  );
  push(range.to, null);
  return code;
}

const ROOT_NODES = /^(Document|Program|Script|SourceFile|JsonText|MarkdownDocument)$/;
const ONLY_PUNCTUATION = /^[\s{}()[\],;:]+$/;

function useful(text: string): boolean {
  const clean = text.trim();
  return Boolean(clean) && clean.length <= 180 && !ONLY_PUNCTUATION.test(clean);
}

function syntaxHeaders(view: EditorView, firstLine: number): Header[] {
  const doc = view.state.doc;
  const visible = doc.line(firstLine);
  const position = Math.min(visible.to, visible.from + (visible.text.search(/\S|$/) || 0));
  const found = new Map<number, Header>();
  let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(position, 1);
  while (node) {
    if (!ROOT_NODES.test(node.name) && node.from < visible.from && node.to > visible.from) {
      let line = doc.lineAt(node.from);
      // Some grammars start a block node on a brace-only line. The declaration just above it
      // is the header readers need.
      if (!useful(line.text)) {
        for (let back = 1; back <= 2 && line.number > 1; back += 1) {
          const candidate = doc.line(line.number - 1);
          line = candidate;
          if (useful(candidate.text)) break;
        }
      }
      if (line.number < firstLine && useful(line.text)) {
        found.set(line.number, { line: line.number, text: line.text.trim() });
      }
    }
    node = node.parent;
  }
  return [...found.values()].sort((a, b) => a.line - b.line).slice(-3);
}

function indentation(text: string): number {
  let columns = 0;
  for (const character of text) {
    if (character === " ") columns += 1;
    else if (character === "\t") columns += 4;
    else break;
  }
  return columns;
}

/** Stream parsers have a shallow tree. Indentation gives those languages an honest fallback. */
function indentationHeaders(view: EditorView, firstLine: number): Header[] {
  const doc = view.state.doc;
  let target = indentation(doc.line(firstLine).text);
  const found: Header[] = [];
  for (let number = firstLine - 1; number >= Math.max(1, firstLine - 600); number -= 1) {
    const text = doc.line(number).text;
    const clean = text.trim();
    if (!clean || indentation(text) >= target) continue;
    if (!/[{:][\s,]*(?:\/\/.*)?$/.test(clean)) continue;
    found.unshift({ line: number, text: clean });
    target = indentation(text);
    if (found.length === 3 || target === 0) break;
  }
  return found;
}

function headers(view: EditorView): Header[] {
  if (!view.state.doc.length) return [];
  const top = Math.max(0, view.scrollDOM.scrollTop - view.documentPadding.top + 1);
  const firstLine = view.state.doc.lineAt(view.lineBlockAtHeight(top).from).number;
  if (firstLine <= 1) return [];
  const syntax = syntaxHeaders(view, firstLine);
  return syntax.length ? syntax : indentationHeaders(view, firstLine);
}

export function stickyScroll(): Extension {
  return ViewPlugin.fromClass(
    class {
      private readonly root = document.createElement("div");
      private frame = 0;
      private signature = "";
      /** Where the content edge sits inside the editor. Measured on geometry changes, never on scroll. */
      private left = 0;
      private top = 0;
      private readonly onScroll = (): void => this.schedule();
      private readonly onTheme = (): void => {
        this.signature = "";
        this.schedule();
      };

      constructor(private readonly view: EditorView) {
        this.root.className = "cm-sticky-scroll";
        this.root.hidden = true;
        view.dom.append(this.root);
        view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
        window.addEventListener("panel-theme-change", this.onTheme);
        this.measure();
        this.schedule();
      }

      update(update: ViewUpdate): void {
        if (update.geometryChanged) this.measure();
        if (update.docChanged || update.viewportChanged || update.geometryChanged) this.schedule();
      }

      destroy(): void {
        cancelAnimationFrame(this.frame);
        this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
        window.removeEventListener("panel-theme-change", this.onTheme);
        this.root.remove();
      }

      /** Two rect reads. They used to run on every scroll frame, forcing layout mid-scroll. */
      private measure(): void {
        const editorBox = this.view.dom.getBoundingClientRect();
        const contentBox = this.view.contentDOM.getBoundingClientRect();
        this.left = Math.max(0, contentBox.left - editorBox.left);
        this.top = this.view.scrollDOM.offsetTop;
        this.root.style.top = `${this.top}px`;
        this.root.style.left = `${this.left}px`;
      }

      private schedule(): void {
        if (this.frame) return;
        this.frame = requestAnimationFrame(() => {
          this.frame = 0;
          this.paint();
        });
      }

      private paint(): void {
        const next = headers(this.view);
        const signature = next.map((header) => `${header.line}:${header.text}`).join("\n");
        if (signature === this.signature) {
          this.root.hidden = !next.length;
          return;
        }
        this.signature = signature;
        const fragment = document.createDocumentFragment();
        for (const header of next) {
          const row = document.createElement("button");
          row.type = "button";
          row.className = "cm-sticky-row";
          row.title = `Go to line ${header.line}`;
          const number = document.createElement("span");
          number.textContent = String(header.line);
          row.append(number, highlightedLine(this.view, header.line));
          row.addEventListener("click", () => {
            const line = this.view.state.doc.line(header.line);
            this.view.dispatch({
              selection: { anchor: line.from },
              effects: EditorView.scrollIntoView(line.from, { y: "start" }),
            });
            this.view.focus();
          });
          fragment.append(row);
        }
        this.root.replaceChildren(fragment);
        this.root.hidden = !next.length;
      }
    },
  );
}
