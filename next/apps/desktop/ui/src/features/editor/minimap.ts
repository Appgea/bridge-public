/**
 * A VSCode-style minimap on the editor's right edge, built on two canvases:
 *
 *   - The OFFSCREEN canvas holds the greeked document — each line drawn as thin ink blocks,
 *     comments in the comment hue. It is rebuilt only when the doc, the geometry, or the
 *     theme changes. Iterating every line is paid there, once, never per scroll.
 *   - The VISIBLE canvas is the cheap path: on scroll it just blits the offscreen and draws
 *     the viewport slider on top. All draws funnel through one coalesced rAF; nothing runs
 *     while idle.
 *
 * Click or drag on it scrubs the document. Tiny docs hide it (and give the padding back).
 */

import type { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { currentMode } from "./theme";

/**
 * A VSCode-style minimap on the editor's right edge, built on two canvases:
 *
 *   - The OFFSCREEN canvas holds the greeked document — each line drawn as thin ink blocks,
 *     comments in the comment hue. It is rebuilt only when the doc, the geometry, or the
 *     theme changes. Iterating every line is paid there, once, never per scroll.
 *   - The VISIBLE canvas is the cheap path: on scroll it just blits the offscreen and draws
 *     the viewport slider on top. All draws funnel through one coalesced rAF; nothing runs
 *     while idle.
 *
 * Click or drag on it scrubs the document. Tiny docs hide it (and give the padding back).
 */

const MINIMAP_WIDTH = 72;
/** Right padding on the scroller so the last characters clear the canvas. */
const MINIMAP_PAD = 84;
/** Below this a minimap is clutter, not navigation. */
const MINIMAP_MIN_LINES = 40;
/** Above this, skip per-run greeking — one bar per line. */
const MINIMAP_SIMPLE_LINES = 6000;
/** Above this, sample every Nth line so the rebuild stays bounded. */
const MINIMAP_MAX_ROWS = 20000;

const MINIMAP_COLORS = {
  dark: {
    ink: "rgba(255, 255, 255, 0.34)",
    comment: "rgba(108, 121, 134, 0.5)",
    sliderFill: "rgba(154, 136, 255, 0.14)",
    sliderLine: "rgba(154, 136, 255, 0.5)",
    edge: "rgba(255, 255, 255, 0.06)",
  },
  light: {
    ink: "rgba(0, 0, 0, 0.3)",
    comment: "rgba(93, 108, 121, 0.5)",
    sliderFill: "rgba(106, 82, 230, 0.12)",
    sliderLine: "rgba(106, 82, 230, 0.55)",
    edge: "rgba(0, 0, 0, 0.08)",
  },
} as const;

const COMMENT_MARKS = ["//", "#", "/*", "*", "<!--", "--"];

function looksLikeComment(trimmed: string): boolean {
  for (const mark of COMMENT_MARKS) if (trimmed.startsWith(mark)) return true;
  return false;
}

export function minimap(): Extension {
  return ViewPlugin.fromClass(
    class {
      private readonly view: EditorView;
      private readonly canvas = document.createElement("canvas");
      private readonly off = document.createElement("canvas");
      private readonly ctx: CanvasRenderingContext2D | null;
      private readonly offCtx: CanvasRenderingContext2D | null;
      private readonly resizer: ResizeObserver;
      private readonly onTheme = (): void => {
        this.offDirty = true;
        this.schedule();
      };
      private readonly onScroll = (): void => this.schedule();
      private frameQueued = false;
      private offDirty = true;
      private shown = false;
      private cssH = 0;
      private dpr = 0;
      private rowH = 1;

      constructor(view: EditorView) {
        this.view = view;
        this.canvas.className = "cm-minimap";
        this.canvas.style.display = "none";
        this.ctx = this.canvas.getContext("2d");
        this.offCtx = this.off.getContext("2d");
        view.dom.appendChild(this.canvas);
        this.bindPointer();
        this.resizer = new ResizeObserver(() => this.schedule());
        this.resizer.observe(view.scrollDOM);
        view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
        window.addEventListener("panel-theme-change", this.onTheme);
        this.schedule();
      }

      update(update: ViewUpdate): void {
        if (update.docChanged) this.offDirty = true;
        if (update.docChanged || update.geometryChanged) this.schedule();
      }

      destroy(): void {
        this.resizer.disconnect();
        this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
        window.removeEventListener("panel-theme-change", this.onTheme);
        this.canvas.remove();
        this.view.scrollDOM.style.paddingRight = "";
      }

      /** Click lands you there; hold and move to scrub. */
      private bindPointer(): void {
        const jump = (event: PointerEvent): void => {
          const doc = this.view.state.doc;
          const line = Math.max(1, Math.min(doc.lines, Math.floor(event.offsetY / this.rowH) + 1));
          this.view.dispatch({
            effects: EditorView.scrollIntoView(doc.line(line).from, { y: "center" }),
          });
        };
        let dragging = false;
        this.canvas.addEventListener("pointerdown", (event) => {
          event.preventDefault();
          dragging = true;
          this.canvas.setPointerCapture(event.pointerId);
          jump(event);
        });
        this.canvas.addEventListener("pointermove", (event) => {
          if (dragging) jump(event);
        });
        const release = (event: PointerEvent): void => {
          dragging = false;
          if (this.canvas.hasPointerCapture(event.pointerId)) {
            this.canvas.releasePointerCapture(event.pointerId);
          }
        };
        this.canvas.addEventListener("pointerup", release);
        this.canvas.addEventListener("pointercancel", release);
      }

      /** Every trigger funnels here; one frame per burst, no idle loop. */
      private schedule(): void {
        if (this.frameQueued) return;
        this.frameQueued = true;
        requestAnimationFrame(() => {
          this.frameQueued = false;
          this.draw();
        });
      }

      private draw(): void {
        const { view, canvas, ctx, offCtx } = this;
        if (!ctx || !offCtx) return;

        const lines = view.state.doc.lines;
        const show = lines >= MINIMAP_MIN_LINES;
        if (show !== this.shown) {
          this.shown = show;
          canvas.style.display = show ? "" : "none";
          view.scrollDOM.style.paddingRight = show ? `${MINIMAP_PAD}px` : "";
        }
        if (!show) return;

        const cssH = view.scrollDOM.clientHeight;
        if (cssH <= 0) return;
        const dpr = window.devicePixelRatio || 1;
        if (cssH !== this.cssH || dpr !== this.dpr) {
          this.cssH = cssH;
          this.dpr = dpr;
          canvas.style.height = `${cssH}px`;
          for (const c of [canvas, this.off]) {
            c.width = Math.round(MINIMAP_WIDTH * dpr);
            c.height = Math.round(cssH * dpr);
          }
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          offCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
          this.offDirty = true;
        }
        this.rowH = Math.min(3, cssH / lines);

        if (this.offDirty) {
          this.offDirty = false;
          this.paintDocument(offCtx, MINIMAP_WIDTH, cssH);
        }
        ctx.clearRect(0, 0, MINIMAP_WIDTH, cssH);
        ctx.drawImage(this.off, 0, 0, MINIMAP_WIDTH, cssH);
        this.paintSlider(ctx, MINIMAP_WIDTH);
      }

      /** The expensive pass — the whole doc, greeked. Runs only on doc/geometry/theme change. */
      private paintDocument(ctx: CanvasRenderingContext2D, w: number, h: number): void {
        const doc = this.view.state.doc;
        const lines = doc.lines;
        const colors = MINIMAP_COLORS[currentMode()];
        const rowH = Math.min(3, h / lines);
        const blockH = Math.max(0.6, rowH * 0.7);
        const left = 3;
        const maxW = w - left - 3;
        const simple = lines > MINIMAP_SIMPLE_LINES;
        const step = lines > MINIMAP_MAX_ROWS ? Math.ceil(lines / MINIMAP_MAX_ROWS) : 1;

        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = colors.edge;
        ctx.fillRect(0, 0, 1, h);

        for (let n = 1; n <= lines; n += step) {
          const text = doc.line(n).text;
          if (!text) continue;
          const lead = /^[\t ]*/.exec(text)?.[0] ?? "";
          const trimmed = text.slice(lead.length);
          if (!trimmed) continue;
          let indent = 0;
          for (let i = 0; i < lead.length; i++) indent += lead.charCodeAt(i) === 9 ? 4 : 1;

          const y = (n - 1) * rowH;
          ctx.fillStyle = looksLikeComment(trimmed) ? colors.comment : colors.ink;

          if (simple) {
            const x = left + Math.min(indent, maxW - 2);
            const width = Math.min(trimmed.length, maxW - (x - left));
            if (width > 0) ctx.fillRect(x, y, width, blockH);
            continue;
          }
          const runs = /\S+/g;
          let run: RegExpExecArray | null;
          while ((run = runs.exec(trimmed))) {
            const x = left + indent + run.index;
            if (x >= left + maxW) break;
            const width = Math.min(run[0].length, left + maxW - x);
            ctx.fillRect(x, y, width, blockH);
          }
        }
      }

      /** The "you are here" — visible line range as a translucent accent window. */
      private paintSlider(ctx: CanvasRenderingContext2D, w: number): void {
        const { view } = this;
        const colors = MINIMAP_COLORS[currentMode()];
        const scroller = view.scrollDOM;
        const top = Math.max(0, scroller.scrollTop - view.documentPadding.top);
        const doc = view.state.doc;
        const first = doc.lineAt(view.lineBlockAtHeight(top).from).number;
        const last = doc.lineAt(view.lineBlockAtHeight(top + scroller.clientHeight).from).number;
        const y = (first - 1) * this.rowH;
        const height = Math.max(this.rowH * (last - first + 1), 4);
        ctx.fillStyle = colors.sliderFill;
        ctx.fillRect(0, y, w, height);
        ctx.strokeStyle = colors.sliderLine;
        ctx.lineWidth = 1;
        ctx.strokeRect(0.5, y + 0.5, w - 1, height - 1);
      }
    },
  );
}

