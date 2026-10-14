/**
 * Nested scope headers pinned above the first visible source line.
 *
 * A pinned header has to be indistinguishable from the line it repeats: same column, same
 * indentation, same line height, same colours, the number in the gutter where numbers live.
 * The first version sat inside the content edge with its own 32px number column, a fixed 22px
 * row and its indentation trimmed, so every header was shifted against the code under it —
 * the eye read it as a different file. Now the row spans the editor, the number is placed on
 * the line-number gutter's own right edge, and the text keeps its leading whitespace.
 */

import type { Extension } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { highlightTree } from "@lezer/highlight";
import { currentMode, highlightStyles } from "./theme";
import { refreshSymbols, roleClass, roleHighlighter, roleOf, symbolSource } from "./semantic";
import { outlineSource } from "./minimap";
import { scopeAt, type OutlineItem } from "./outline";

type Header = { line: number; text: string; end: number };

/**
 * The header line, painted by the same two highlighters the buffer uses — the token theme and
 * the identifier roles — so a pinned name is the colour it is below.
 */
function highlightedLine(view: EditorView, line: number): HTMLElement {
  const code = document.createElement("code");
  const { state } = view;
  const range = state.doc.line(line);
  const table = state.facet(symbolSource)();
  let at = range.from;
  const push = (to: number, classes: string | null): void => {
    if (to <= at) return;
    const chunk = state.doc.sliceString(at, to);
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
    syntaxTree(state),
    [highlightStyles[currentMode()], roleHighlighter],
    (start, end, classes) => {
      push(Math.max(start, range.from), null);
      const role = roleOf(classes);
      const style = classes.split(" ").filter((part) => !part.startsWith("xr-"));
      if (role) {
        const after = /\S/.exec(state.doc.sliceString(end, Math.min(range.to, end + 24)))?.[0] ?? "";
        const semantic = roleClass(role, state.doc.sliceString(start, end), after, table);
        if (semantic) style.push(semantic);
      }
      push(Math.min(end, range.to), style.join(" ") || null);
    },
    range.from,
    range.to,
  );
  push(range.to, null);
  return code;
}

/** More than this and the pins start to hide the code they introduce. */
const MAX_HEADERS = 3;

/**
 * The scope pinned at each row.
 *
 * Row i repeats the i-th scope around the line that sits at that row's top, as long as the
 * scope's own declaration has already scrolled past it. Asking per row, and not once for the line
 * under all the pins, is what keeps a closing scope from flickering in and out: the pin stays
 * while any of its body is level with it. Scopes come from the outline, the same rule the jump
 * bar and the minimap use, so the three can never disagree about where you are.
 */
function headers(view: EditorView): Header[] {
  const { state } = view;
  if (!state.doc.length) return [];
  const items = state.facet(outlineSource)?.items(state) ?? [];
  if (!items.length) return [];
  const row = view.defaultLineHeight;
  const top = Math.max(0, view.scrollDOM.scrollTop - view.documentPadding.top);
  const chain: OutlineItem[] = [];
  for (let index = 0; index < MAX_HEADERS; index += 1) {
    const line = state.doc.lineAt(view.lineBlockAtHeight(top + index * row + 1).from).number;
    const around = scopeAt(items, line).filter((item) => item.line < line && item.line <= state.doc.lines);
    // A different outer scope at this depth means the one above ended in between. Stop there.
    if (around.length <= index || chain.some((item, at) => around[at] !== item)) break;
    chain.push(around[index]);
  }
  return chain.map((item) => ({ line: item.line, text: state.doc.line(item.line).text, end: Math.min(item.end, state.doc.lines) }));
}

/**
 * How far each row rides up as its scope runs out. A pin never covers code from outside its own
 * scope: as the closing line comes up under it, the row is pushed up by the closing line, the
 * way the next section's title pushes the last one off in a native list.
 */
function pushes(view: EditorView, rows: readonly Header[]): number[] {
  const row = view.defaultLineHeight;
  const top = view.scrollDOM.scrollTop - view.documentPadding.top;
  let shift = 0;
  return rows.map((header, index) => {
    const bottom = view.lineBlockAt(view.state.doc.line(header.end).from).bottom - top;
    shift = Math.min(shift, bottom - (index + 1) * row);
    return Math.round(shift);
  });
}

export function stickyScroll(): Extension {
  return ViewPlugin.fromClass(
    class {
      private readonly root = document.createElement("div");
      private frame = 0;
      private signature = "";
      /** Measured on geometry changes, never on scroll. */
      private numberRight = 0;
      private codeLeft = 0;
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
        if (update.geometryChanged) {
          this.measure();
          this.signature = "";
        }
        const recoloured = update.transactions.some((tr) => tr.effects.some((effect) => effect.is(refreshSymbols)));
        if (update.docChanged || recoloured) this.signature = "";
        // Any transaction may carry a fresh outline. Repainting is a string compare when nothing moved.
        if (update.transactions.length || update.viewportChanged || update.geometryChanged) this.schedule();
      }

      destroy(): void {
        cancelAnimationFrame(this.frame);
        this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
        window.removeEventListener("panel-theme-change", this.onTheme);
        this.root.remove();
      }

      /** Where the gutter's numbers end and where line text begins, relative to the editor. */
      private measure(): void {
        const { view } = this;
        const editorBox = view.dom.getBoundingClientRect();
        const numbers = view.dom.querySelector<HTMLElement>(".cm-lineNumbers");
        const firstLine = view.contentDOM.querySelector<HTMLElement>(".cm-line");
        const contentBox = view.contentDOM.getBoundingClientRect();
        const pad = firstLine ? parseFloat(getComputedStyle(firstLine).paddingLeft) || 0 : 0;
        this.numberRight = numbers ? numbers.getBoundingClientRect().right - editorBox.left : 0;
        this.codeLeft = Math.max(0, contentBox.left - editorBox.left + pad + view.scrollDOM.scrollLeft);
        this.root.style.top = `${view.scrollDOM.offsetTop}px`;
        this.root.style.setProperty("--sticky-row", `${view.defaultLineHeight}px`);
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
        // Horizontal scroll moves the code, never the gutter — the pinned text follows.
        this.root.style.setProperty("--sticky-shift", `${-this.view.scrollDOM.scrollLeft}px`);
        const signature = next.map((header) => `${header.line}:${header.text}`).join("\n");
        if (signature !== this.signature) {
          this.signature = signature;
          this.build(next);
        }
        this.root.hidden = !next.length;
        this.place(next);
      }

      /** Rows ride up as their scopes close. Only transforms and one height change per frame. */
      private place(next: readonly Header[]): void {
        if (!next.length) return;
        const shifts = pushes(this.view, next);
        const rows = this.root.children;
        for (let index = 0; index < rows.length; index += 1) {
          const shift = shifts[index] ?? 0;
          (rows[index] as HTMLElement).style.transform = shift ? `translateY(${shift}px)` : "";
        }
        const height = next.length * this.view.defaultLineHeight + (shifts[shifts.length - 1] ?? 0);
        this.root.style.height = `${Math.max(0, height)}px`;
      }

      private build(next: readonly Header[]): void {
        const fragment = document.createDocumentFragment();
        for (const [index, header] of next.entries()) {
          const row = document.createElement("button");
          row.type = "button";
          row.className = "cm-sticky-row";
          // An inner row riding up slides under the one above it, never over it.
          row.style.zIndex = String(MAX_HEADERS - index);
          row.title = `Go to line ${header.line}`;
          const number = document.createElement("span");
          number.className = "cm-sticky-num";
          number.style.width = `${Math.max(0, this.numberRight - 6)}px`;
          number.textContent = String(header.line);
          const code = highlightedLine(this.view, header.line);
          code.style.left = `${this.codeLeft}px`;
          row.append(number, code);
          row.addEventListener("click", () => {
            const line = this.view.state.doc.line(header.line);
            this.view.dispatch({
              selection: { anchor: line.from + (line.text.search(/\S|$/) || 0) },
              effects: EditorView.scrollIntoView(line.from, { y: "start" }),
            });
            this.view.focus();
          });
          fragment.append(row);
        }
        this.root.replaceChildren(fragment);
      }
    },
  );
}
