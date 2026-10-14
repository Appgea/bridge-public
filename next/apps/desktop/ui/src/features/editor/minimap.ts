/**
 * The minimap — Xcode's, not a grey smear.
 *
 * What it shows, left to right:
 *   - The code, greeked in its own syntax colours at a fixed scale (2px a line), so the SHAPE of a
 *     file — a block of strings, a wall of comments, a pink run of keywords — is recognisable.
 *     A long file scrolls the minimap proportionally instead of crushing every line into a
 *     hairline; the old one drew a 3,000-line file at a third of a pixel per line.
 *   - `// MARK:` sections as legible labels, the way Xcode titles its minimap.
 *   - The visible region as a soft box you can grab and drag.
 *   - An overview strip on the right edge that maps the WHOLE file: git changes, find matches,
 *     breakpoints, other uses of the caret's symbol, and the caret itself. That strip is the one
 *     place a long file says where everything is without being scrolled.
 *
 * Hover names the symbol under the pointer. Click centres that line; drag scrubs.
 *
 * Cost: a frame paints only the minimap rows on screen — a few hundred lines at most — from a
 * per-line run cache keyed by line text, so a keystroke re-lexes one line, not the file. Every
 * trigger funnels into one rAF; nothing runs while idle.
 */

import { Facet, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { getSearchQuery, searchPanelOpen } from "@codemirror/search";
import { currentMode, XCODE } from "./theme";
import { scopeAt, type OutlineItem } from "./outline";

/** What a strip mark means. The minimap owns the colour, so every source agrees on it. */
export type OverviewTone = "added" | "modified" | "deleted" | "breakpoint";
export type OverviewMark = { line: number; tone: OverviewTone };

/**
 * Other extensions contribute whole-file marks here (git changes, breakpoints) without the
 * minimap knowing they exist. Each source is a function of the state, read at paint time.
 */
export const overviewSources = Facet.define<(state: EditorState) => readonly OverviewMark[]>();

/** One buffer's outline, kept by the editor core and read here for MARK labels and hover names. */
export type OutlineSource = {
  /** The latest outline — a beat behind the text while typing, never recomputed per keystroke. */
  items(state: EditorState): readonly OutlineItem[];
  /** Read the outline again from this state. */
  refresh(state: EditorState): void;
};

export const outlineSource = Facet.define<OutlineSource, OutlineSource | null>({
  combine: (values) => values[0] ?? null,
});

const outlineOf = (state: EditorState): readonly OutlineItem[] => state.facet(outlineSource)?.items(state) ?? [];

const MINIMAP_WIDTH = 84;
/** Right padding on the scroller so the last characters clear the canvas. */
export const MINIMAP_PAD = 96;
/** Below this a minimap is clutter, not navigation. */
const MINIMAP_MIN_LINES = 40;
/** One document line, in CSS px. */
const ROW = 2;
const STRIP = 5;
const CODE_LEFT = 4;
const CODE_RIGHT = MINIMAP_WIDTH - STRIP - 3;
/** Past this a whole-file scan per caret move costs more than the marks are worth. */
const SCAN_LIMIT = 600_000;

const KEYWORDS = new Set(
  ("abstract actor as async await break case catch class const continue convenience def default defer " +
    "deinit del do dynamic elif else enum except export extends extension fallthrough false fileprivate " +
    "final finally fn for from func fun function get guard if impl import in init inout interface " +
    "internal is lambda late let match mod mut mutating new nil None null open operator override package " +
    "pass private protected protocol pub public raise required rethrows return self Self set some static " +
    "struct super switch this throw throws trait true True False try type typealias typeof undefined " +
    "unsafe use val var void weak where while with yield").split(" "),
);

/* Run tones. Indexes into the per-theme colour table below. */
const PLAIN = 0;
const KEYWORD = 1;
const STRING = 2;
const COMMENT = 3;
const NUMBER = 4;
const TYPE = 5;
const PUNCT = 6;
const MARKED = 7;

function toneColors(): string[] {
  const c = XCODE[currentMode()];
  return [c.plain, c.keyword, c.string, c.comment, c.number, c.otherType, c.plain, c.mark];
}

/**
 * One line as runs of [x, width, tone], x in columns from the line start. A lexer of the
 * cheapest kind — words, strings, numbers, a line comment — because the minimap's job is shape
 * and colour family, and it runs on text the parser may not have reached yet.
 */
function lex(text: string, tabSize: number, lineComment: string): number[] {
  const runs: number[] = [];
  let column = 0;
  let index = 0;
  while (index < text.length && (text[index] === " " || text[index] === "\t")) {
    column += text[index] === "\t" ? tabSize - (column % tabSize) : 1;
    index += 1;
  }
  const rest = text.slice(index);
  if (!rest) return runs;
  if (/^(?:\/\*|\*(?:\s|\/|$))/.test(rest)) {
    runs.push(column, rest.length, /\bMARK:/.test(rest) ? MARKED : COMMENT);
    return runs;
  }
  while (index < text.length) {
    const ch = text[index];
    if (ch === " " || ch === "\t") {
      column += ch === "\t" ? tabSize - (column % tabSize) : 1;
      index += 1;
      continue;
    }
    const start = index;
    let tone = PUNCT;
    if (lineComment && text.startsWith(lineComment, index)) {
      const body = text.slice(index);
      runs.push(column, body.length, /\b(?:MARK|TODO|FIXME):/.test(body) ? MARKED : COMMENT);
      return runs;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      index += 1;
      while (index < text.length && text[index] !== ch) index += text[index] === "\\" ? 2 : 1;
      index = Math.min(text.length, index + 1);
      tone = STRING;
    } else if (/[A-Za-z_$@#]/.test(ch)) {
      while (index < text.length && /[\w$]/.test(text[index])) index += 1;
      if (index === start) index += 1;
      const word = text.slice(start, index);
      tone = KEYWORDS.has(word) ? KEYWORD : /^[A-Z][a-z]/.test(word) ? TYPE : PLAIN;
    } else if (/[0-9]/.test(ch)) {
      while (index < text.length && /[\w.]/.test(text[index])) index += 1;
      tone = NUMBER;
    } else {
      while (index < text.length && /[^\w\s"'`$@#]/.test(text[index])) index += 1;
    }
    const width = index - start;
    // Neighbouring runs of one tone merge: fewer rectangles, same picture.
    const last = runs.length - 3;
    if (last >= 0 && runs[last + 2] === tone && runs[last] + runs[last + 1] === column) runs[last + 1] += width;
    else runs.push(column, width, tone);
    column += width;
  }
  return runs;
}

/** Every line holding `word` as a whole word, capped. Used for the caret-symbol marks. */
function wordLines(state: EditorState, word: string): number[] {
  if (state.doc.length > SCAN_LIMIT) return [];
  const pattern = new RegExp(`(?<![\\w$])${word.replace(/\$/g, "\\$")}(?![\\w$])`, "g");
  const lines: number[] = [];
  let last = -1;
  const text = state.doc.toString();
  for (const match of text.matchAll(pattern)) {
    const line = state.doc.lineAt(match.index).number;
    if (line !== last) lines.push(line);
    last = line;
    if (lines.length > 4000) break;
  }
  return lines;
}

function caretWord(state: EditorState): string | null {
  const range = state.selection.main;
  if (!range.empty) return null;
  const line = state.doc.lineAt(range.head);
  const at = range.head - line.from;
  let from = at;
  let to = at;
  while (from > 0 && /[\w$]/.test(line.text[from - 1])) from -= 1;
  while (to < line.text.length && /[\w$]/.test(line.text[to])) to += 1;
  const word = line.text.slice(from, to);
  return /^[A-Za-z_$][\w$]*$/.test(word) && word.length > 1 ? word : null;
}

/** Lines with a find match, while the find bar is open. Capped; past the cap the strip is full anyway. */
function findLines(state: EditorState): number[] {
  if (!searchPanelOpen(state)) return [];
  const query = getSearchQuery(state);
  if (!query.valid || !query.search) return [];
  const cursor = query.getCursor(state);
  const lines: number[] = [];
  let last = -1;
  for (let step = cursor.next(); !step.done; step = cursor.next()) {
    const line = state.doc.lineAt(step.value.from).number;
    if (line !== last) lines.push(line);
    last = line;
    if (lines.length > 4000) break;
  }
  return lines;
}

export function minimap(): Extension {
  return ViewPlugin.fromClass(
    class {
      private readonly view: EditorView;
      private readonly canvas = document.createElement("canvas");
      private readonly ctx: CanvasRenderingContext2D | null;
      private readonly label = document.createElement("div");
      private readonly resizer: ResizeObserver;
      private readonly onTheme = (): void => {
        this.tones = toneColors();
        this.tokens = null;
        this.schedule();
      };
      private readonly onScroll = (): void => this.schedule();
      private frameQueued = false;
      private shown = false;
      private cssH = 0;
      private dpr = 0;
      private tones = toneColors();
      /** CSS token colours for the strip, resolved once per theme. */
      private tokens: Record<string, string> | null = null;
      /** Line text → runs. Survives every keystroke that does not touch the line. */
      private runs = new Map<string, number[]>();
      /** Where the minimap's own scroll sits, in CSS px, as of the last paint. */
      private top = 0;
      private sliderY = 0;
      private sliderH = 0;
      private dragging = false;
      private grab = 0;
      private hoverY: number | null = null;
      private word: string | null = null;
      private wordMarks: number[] = [];
      private findKey = "";
      private findMarks: number[] = [];

      constructor(view: EditorView) {
        this.view = view;
        this.canvas.className = "cm-minimap";
        this.canvas.style.display = "none";
        this.canvas.style.width = `${MINIMAP_WIDTH}px`;
        this.ctx = this.canvas.getContext("2d");
        this.label.className = "cm-minimap-label";
        this.label.hidden = true;
        view.dom.append(this.canvas, this.label);
        this.bindPointer();
        this.resizer = new ResizeObserver(() => this.schedule());
        this.resizer.observe(view.scrollDOM);
        view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
        window.addEventListener("panel-theme-change", this.onTheme);
        this.schedule();
      }

      update(update: ViewUpdate): void {
        if (update.selectionSet || update.docChanged) {
          const word = caretWord(update.state);
          if (word !== this.word || update.docChanged) {
            this.word = word;
            this.wordMarks = word ? wordLines(update.state, word) : [];
          }
        }
        const query = getSearchQuery(update.state);
        const findKey = searchPanelOpen(update.state) ? `${query.search}\u0000${query.caseSensitive}${query.regexp}${query.wholeWord}` : "";
        if (findKey !== this.findKey || (findKey && update.docChanged)) {
          this.findKey = findKey;
          this.findMarks = findLines(update.state);
        }
        if (this.runs.size > 30_000) this.runs.clear();
        this.schedule();
      }

      destroy(): void {
        this.resizer.disconnect();
        this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
        window.removeEventListener("panel-theme-change", this.onTheme);
        this.canvas.remove();
        this.label.remove();
        this.view.scrollDOM.style.paddingRight = "";
      }

      /* ------------------------------------------------------------ geometry */

      private get docH(): number {
        return this.view.state.doc.lines * ROW;
      }

      /** Scroll progress, 0 at the top and 1 at the bottom. */
      private progress(): number {
        const scroller = this.view.scrollDOM;
        const range = scroller.scrollHeight - scroller.clientHeight;
        return range > 0 ? Math.max(0, Math.min(1, scroller.scrollTop / range)) : 0;
      }

      private lineAtY(y: number): number {
        const lines = this.view.state.doc.lines;
        return Math.max(1, Math.min(lines, Math.floor((y + this.top) / ROW) + 1));
      }

      /* -------------------------------------------------------------- pointer */

      private bindPointer(): void {
        const scrollTo = (sliderTop: number): void => {
          const span = Math.max(1, Math.min(this.docH, this.cssH) - this.sliderH);
          const scroller = this.view.scrollDOM;
          const target = Math.max(0, Math.min(1, sliderTop / span));
          scroller.scrollTop = target * (scroller.scrollHeight - scroller.clientHeight);
        };
        this.canvas.addEventListener("pointerdown", (event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          this.canvas.setPointerCapture(event.pointerId);
          this.dragging = true;
          this.label.hidden = true;
          const y = event.offsetY;
          if (y >= this.sliderY && y <= this.sliderY + this.sliderH) {
            this.grab = y - this.sliderY;
            return;
          }
          // Off the slider: land the clicked line in the middle, then keep dragging from there.
          const line = this.view.state.doc.line(this.lineAtY(y));
          this.view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: "center" }) });
          this.grab = this.sliderH / 2;
        });
        this.canvas.addEventListener("pointermove", (event) => {
          if (this.dragging) {
            scrollTo(event.offsetY - this.grab);
            return;
          }
          this.hoverY = event.offsetY;
          this.paintLabel(event.offsetY);
          this.schedule();
        });
        const release = (event: PointerEvent): void => {
          this.dragging = false;
          if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
        };
        this.canvas.addEventListener("pointerup", release);
        this.canvas.addEventListener("pointercancel", release);
        this.canvas.addEventListener("pointerleave", () => {
          this.hoverY = null;
          this.label.hidden = true;
          this.schedule();
        });
      }

      /** Name the symbol under the pointer, beside the minimap. */
      private paintLabel(y: number): void {
        const items = outlineOf(this.view.state);
        const line = this.lineAtY(y);
        const chain = scopeAt(items, line);
        const item = chain[chain.length - 1];
        if (!item) {
          this.label.hidden = true;
          return;
        }
        this.label.textContent = chain.map((entry) => entry.name).join(" › ");
        this.label.hidden = false;
        const top = this.canvas.offsetTop + Math.max(0, Math.min(this.cssH - 22, y - 11));
        this.label.style.top = `${top}px`;
        this.label.style.right = `${MINIMAP_WIDTH + 6}px`;
      }

      /* -------------------------------------------------------------- paint */

      private schedule(): void {
        if (this.frameQueued) return;
        this.frameQueued = true;
        requestAnimationFrame(() => {
          this.frameQueued = false;
          this.draw();
        });
      }

      private draw(): void {
        const { view, canvas, ctx } = this;
        if (!ctx) return;
        const lines = view.state.doc.lines;
        const show = lines >= MINIMAP_MIN_LINES;
        if (show !== this.shown) {
          this.shown = show;
          canvas.style.display = show ? "" : "none";
          view.scrollDOM.style.paddingRight = show ? `${MINIMAP_PAD}px` : "";
          if (!show) this.label.hidden = true;
        }
        if (!show) return;

        const cssH = view.scrollDOM.clientHeight;
        if (cssH <= 0) return;
        const dpr = window.devicePixelRatio || 1;
        if (cssH !== this.cssH || dpr !== this.dpr) {
          this.cssH = cssH;
          this.dpr = dpr;
          canvas.style.height = `${cssH}px`;
          canvas.style.top = `${view.scrollDOM.offsetTop}px`;
          canvas.width = Math.round(MINIMAP_WIDTH * dpr);
          canvas.height = Math.round(cssH * dpr);
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }

        const scroller = view.scrollDOM;
        const top = Math.max(0, scroller.scrollTop - view.documentPadding.top);
        const first = view.state.doc.lineAt(view.lineBlockAtHeight(top).from).number;
        const last = view.state.doc.lineAt(view.lineBlockAtHeight(top + scroller.clientHeight).from).number;
        this.top = this.docH > cssH ? this.progress() * (this.docH - cssH) : 0;
        this.sliderY = (first - 1) * ROW - this.top;
        this.sliderH = Math.max(ROW * 4, (last - first + 1) * ROW);

        ctx.clearRect(0, 0, MINIMAP_WIDTH, cssH);
        this.paintCode(ctx, cssH);
        this.paintSlider(ctx);
        this.paintMarks(ctx);
        this.paintStrip(ctx, cssH, first, last);
      }

      private paintCode(ctx: CanvasRenderingContext2D, height: number): void {
        const { state } = this.view;
        const doc = state.doc;
        const tabSize = state.tabSize;
        const lineComment = (state.languageDataAt<{ line?: string }>("commentTokens", 0)[0]?.line) ?? "";
        const firstLine = Math.max(1, Math.floor(this.top / ROW) + 1);
        const lastLine = Math.min(doc.lines, Math.ceil((this.top + height) / ROW) + 1);
        const blockH = ROW * 0.72;
        const maxCols = CODE_RIGHT - CODE_LEFT;
        let tone = -1;
        ctx.globalAlpha = 0.72;
        for (let number = firstLine; number <= lastLine; number++) {
          const text = doc.line(number).text;
          if (!text) continue;
          let runs = this.runs.get(text);
          if (!runs) {
            runs = lex(text.length > 400 ? text.slice(0, 400) : text, tabSize, lineComment);
            this.runs.set(text, runs);
          }
          const y = (number - 1) * ROW - this.top;
          for (let index = 0; index < runs.length; index += 3) {
            const x = runs[index];
            if (x >= maxCols) break;
            if (runs[index + 2] !== tone) {
              tone = runs[index + 2];
              ctx.fillStyle = this.tones[tone];
              ctx.globalAlpha = tone === PUNCT ? 0.4 : 0.72;
            }
            ctx.fillRect(CODE_LEFT + x, y, Math.min(runs[index + 1], maxCols - x), blockH);
          }
        }
        ctx.globalAlpha = 1;
      }

      /** The visible region: a soft box, brighter while the pointer is over the minimap. */
      private paintSlider(ctx: CanvasRenderingContext2D): void {
        const dark = currentMode() === "dark";
        const hovering = this.hoverY !== null || this.dragging;
        ctx.fillStyle = dark ? `rgba(255,255,255,${hovering ? 0.1 : 0.06})` : `rgba(0,0,0,${hovering ? 0.08 : 0.05})`;
        ctx.fillRect(0, this.sliderY, MINIMAP_WIDTH - STRIP - 1, this.sliderH);
        ctx.fillStyle = dark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.1)";
        ctx.fillRect(0, this.sliderY, MINIMAP_WIDTH - STRIP - 1, 1);
        ctx.fillRect(0, this.sliderY + this.sliderH - 1, MINIMAP_WIDTH - STRIP - 1, 1);
      }

      /** MARK sections as titles, each on a plate of editor ground so the code under it recedes. */
      private paintMarks(ctx: CanvasRenderingContext2D): void {
        const items = outlineOf(this.view.state);
        const c = XCODE[currentMode()];
        ctx.font = "700 9px -apple-system, system-ui, sans-serif";
        ctx.textBaseline = "top";
        let lastY = -Infinity;
        for (const item of items) {
          if (item.kind !== "mark") continue;
          const y = (item.line - 1) * ROW - this.top;
          if (y < -12 || y > this.cssH) continue;
          if (y - lastY < 12) continue;
          lastY = y;
          const text = item.name.length > 18 ? `${item.name.slice(0, 17)}…` : item.name;
          const width = Math.min(CODE_RIGHT - CODE_LEFT, ctx.measureText(text).width + 6);
          ctx.fillStyle = c.bg;
          ctx.globalAlpha = 0.9;
          ctx.fillRect(CODE_LEFT - 2, y - 1, width, 11);
          ctx.globalAlpha = 1;
          if (item.separator) {
            ctx.fillStyle = c.mark;
            ctx.globalAlpha = 0.35;
            ctx.fillRect(CODE_LEFT - 2, y - 2, CODE_RIGHT - CODE_LEFT + 2, 1);
            ctx.globalAlpha = 1;
          }
          ctx.fillStyle = c.mark;
          ctx.fillText(text, CODE_LEFT + 1, y, CODE_RIGHT - CODE_LEFT - 2);
        }
      }

      private token(name: string): string {
        if (!this.tokens) {
          const style = getComputedStyle(this.view.dom);
          const read = (key: string, fallback: string): string => style.getPropertyValue(key).trim() || fallback;
          this.tokens = {
            added: read("--ok", "#67d99a"),
            modified: read("--warn", "#e8c66a"),
            deleted: read("--risk", "#ff6b81"),
            breakpoint: read("--cm-breakpoint", "#3a7ee8"),
          };
        }
        return this.tokens[name] ?? "#888";
      }

      /** The whole file in the canvas height. Proportional, so a mark here is a place there. */
      private paintStrip(ctx: CanvasRenderingContext2D, height: number, firstVisible: number, lastVisible: number): void {
        const { state } = this.view;
        const lines = state.doc.lines;
        const x = MINIMAP_WIDTH - STRIP;
        const dark = currentMode() === "dark";
        const yOf = (line: number): number => Math.floor(((line - 1) / lines) * (height - 2));
        ctx.fillStyle = dark ? "rgba(255,255,255,0.035)" : "rgba(0,0,0,0.035)";
        ctx.fillRect(x, 0, STRIP, height);

        // Visible window, so the strip reads as a map of the scroll as well.
        ctx.fillStyle = dark ? "rgba(255,255,255,0.09)" : "rgba(0,0,0,0.08)";
        ctx.fillRect(x, yOf(firstVisible), STRIP, Math.max(2, yOf(lastVisible) - yOf(firstVisible)));

        ctx.fillStyle = dark ? "rgba(255,255,255,0.32)" : "rgba(0,0,0,0.28)";
        for (const line of this.wordMarks) ctx.fillRect(x + 1, yOf(line), STRIP - 2, 2);

        for (const source of state.facet(overviewSources)) {
          for (const mark of source(state)) {
            ctx.fillStyle = this.token(mark.tone);
            if (mark.tone === "breakpoint") ctx.fillRect(x, yOf(mark.line), STRIP, 3);
            else ctx.fillRect(x, yOf(mark.line), 2, 2);
          }
        }

        ctx.fillStyle = XCODE[currentMode()].findCurrent;
        for (const line of this.findMarks) ctx.fillRect(x + 1, yOf(line), STRIP - 1, 2);

        const caret = state.doc.lineAt(state.selection.main.head).number;
        ctx.fillStyle = dark ? "#ffffff" : "#000000";
        ctx.fillRect(x, yOf(caret), STRIP, 1);
      }
    },
  );
}
