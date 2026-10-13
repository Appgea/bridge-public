/**
 * The lightbox — one image, as big as the window allows, and nothing else.
 *
 * Agent screenshots used to be dead ends: a 240px thumbnail in a post, or a tile on the wall
 * that you could zoom only by zooming the whole tile. Both answered "there is a picture" and
 * neither answered "what does it look like", which is the only reason a screenshot is attached.
 *
 * So every surface that draws a project image shares this one overlay. Tap the picture, it
 * fills the screen, letterboxed — never cropped, never upscaled past the window. ←/→ walk the
 * set it belongs to, Esc or a click on the mat closes it, and nothing under it is disturbed:
 * the overlay is a sibling of the app root, owns the keyboard only while it is up, and hands
 * focus back to whatever had it.
 *
 * Fit is not enough on its own. A phone grab is ~1290px wide and the window is not, so "fits the
 * screen" means a third of actual size — every label in it unreadable, which is usually the exact
 * thing you opened it to check. So the picture has a second state: 100%, its own pixels, with the
 * figure turned into a viewport you drag around. Click toggles, `0` toggles, walking to another
 * shot drops back to fit.
 *
 * Deliberately not a router destination. Looking at a picture must never cost you your place.
 */

import { projectAssetUrl, projectImage } from "../project-assets";

export type LightboxShot = {
  /** The project the path is resolved against. */
  project: string;
  /** Project-relative (or absolute) path the agent named. */
  path: string;
  /** Shown under the picture. Falls back to the file name. */
  caption?: string;
};

const basename = (path: string): string => path.replaceAll("\\", "/").split("/").pop() || path;

/** How far a pointer may travel while panning before the release stops counting as a click. */
const DRAG_SLOP = 4;

let openLightbox: (() => void) | null = null;

/**
 * True while a picture is filling the window. The app's global chords (the wall's zoom and tab
 * walk, ⌘F terminal search, the ⌘-digit ladder) register on `window` long before this overlay
 * exists, so capture order alone cannot keep them out — every one of them asks this instead.
 */
export const isLightboxOpen = (): boolean => openLightbox !== null;

/**
 * Put `shots` on screen starting at `at`. Calling it while another lightbox is up replaces it,
 * so a double tap can never stack two mats.
 */
export function showLightbox(shots: LightboxShot[], at = 0): void {
  const list = shots.filter((shot) => shot.path);
  if (!list.length) return;
  openLightbox?.();

  let index = Math.min(Math.max(at, 0), list.length - 1);
  let zoomed = false;
  /** Bumped every paint, so a slow decode for a shot you already walked past is dropped. */
  let token = 0;
  const restore = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const root = document.createElement("div");
  root.className = "lightbox";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "Image viewer");
  root.tabIndex = -1;

  const stage = document.createElement("div");
  stage.className = "lightbox-stage";
  // The chevrons hang off the PICTURE, not the window. On a wide display a phone screenshot is a
  // narrow column in the middle, and buttons pinned to the window edges are a mouse trip away
  // from the thing they act on. The frame shrink-wraps the image and carries them.
  const frame = document.createElement("div");
  frame.className = "lightbox-frame";
  const figure = document.createElement("figure");
  figure.className = "lightbox-figure";
  const caption = document.createElement("figcaption");
  caption.className = "lightbox-cap";

  const close = document.createElement("button");
  close.type = "button";
  close.className = "lightbox-close";
  close.title = "Close (Esc)";
  close.textContent = "✕";

  const counter = document.createElement("span");
  counter.className = "lightbox-count";

  /** Only offered when there is something to magnify — see `paint`. */
  const zoom = document.createElement("button");
  zoom.type = "button";
  zoom.className = "lightbox-zoom";
  zoom.hidden = true;

  const back = document.createElement("button");
  back.type = "button";
  back.className = "lightbox-nav is-back";
  back.title = "Previous (←)";
  back.textContent = "‹";
  const next = document.createElement("button");
  next.type = "button";
  next.className = "lightbox-nav is-next";
  next.title = "Next (→)";
  next.textContent = "›";

  const current = (): HTMLImageElement | null =>
    figure.querySelector<HTMLImageElement>(".lightbox-img");

  /**
   * Fit obeys the window; 100% obeys the file. Two states, no slider — a screenshot is either
   * "show me the whole thing" or "let me read that label", and nothing in between is a question
   * anyone asks. `origin` keeps whatever you clicked under the pointer instead of dumping you at
   * the top-left corner of a 2796px image.
   */
  const applyZoom = (origin?: { x: number; y: number }): void => {
    const image = current();
    if (!image) return;
    frame.classList.toggle("is-zoomed", zoomed);
    figure.classList.toggle("is-zoomed", zoomed);
    zoom.textContent = zoomed ? "Fit" : "100%";
    zoom.title = zoomed ? "Fit to window (0)" : "Actual size (0)";
    if (!zoomed) {
      image.style.width = "";
      image.style.height = "";
      figure.scrollTo(0, 0);
      return;
    }
    const before = image.getBoundingClientRect();
    image.style.width = `${image.naturalWidth}px`;
    image.style.height = `${image.naturalHeight}px`;
    const box = figure.getBoundingClientRect();
    const px = origin ? (origin.x - before.left) / Math.max(before.width, 1) : 0.5;
    const py = origin ? (origin.y - before.top) / Math.max(before.height, 1) : 0.5;
    figure.scrollLeft = px * image.naturalWidth - box.width / 2;
    figure.scrollTop = py * image.naturalHeight - box.height / 2;
  };

  /**
   * Pin the frame to the picture's RENDERED width, so the chevrons hug the image. CSS cannot do
   * this on its own: a shrink-wrapped frame sizes to the image's intrinsic width, while a tall
   * screenshot is drawn height-capped and much narrower — the buttons would float in dead space.
   */
  const fitFrame = (): void => {
    const image = current();
    frame.style.width = "";
    if (!image || zoomed) return;
    const box = image.getBoundingClientRect();
    if (box.width) frame.style.width = `${Math.round(box.width)}px`;
  };
  const onResize = (): void => fitFrame();

  /** Warm the neighbours so ←/→ is a swap, not a fetch. */
  const warmed = new Set<string>();
  const prefetch = (nth: number): void => {
    if (list.length < 2) return;
    const shot = list[(((nth % list.length) + list.length) % list.length)];
    const url = projectAssetUrl(shot.project, shot.path);
    if (warmed.has(url)) return;
    warmed.add(url);
    const ghost = new Image();
    ghost.decoding = "async";
    ghost.src = url;
  };

  const paint = async (): Promise<void> => {
    const mine = ++token;
    const shot = list[index];
    const image = projectImage(shot.project, shot.path, shot.caption || basename(shot.path));
    image.className = "lightbox-img";
    image.loading = "eager";
    image.decoding = "sync";
    counter.textContent = list.length > 1 ? `${index + 1} / ${list.length}` : "";
    counter.hidden = list.length < 2;
    // Hold the picture you are looking at until the next one can be drawn in one go. Swapping in
    // an undecoded <img> is what made walking a set flash an empty mat on every arrow press.
    try {
      await image.decode();
    } catch {
      /* missing file — projectImage retries, then draws the path that failed */
    }
    if (mine !== token) return;
    zoomed = false;
    figure.replaceChildren(image);
    // The name is what you are looking for; the full path is a tooltip, not a headline.
    caption.textContent = shot.caption || basename(shot.path);
    caption.title = shot.path;
    applyZoom();
    fitFrame();
    // Nothing to magnify when the file is already showing every pixel it has.
    const box = image.getBoundingClientRect();
    zoom.hidden = !image.naturalWidth || image.naturalWidth <= Math.ceil(box.width) + 1;
    prefetch(index + 1);
    prefetch(index - 1);
  };

  const go = (delta: number): void => {
    if (list.length < 2) return;
    index = (((index + delta) % list.length) + list.length) % list.length;
    void paint();
  };

  const dismiss = (): void => {
    if (openLightbox !== dismiss) return;
    openLightbox = null;
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", onResize);
    document.removeEventListener("focusin", keepFocus, true);
    root.remove();
    restore?.focus?.();
  };

  // Capture, so the workspace's own chords (zoom, tab walk) never fire behind an open picture.
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      event.stopPropagation();
      go(event.key === "ArrowRight" ? 1 : -1);
      return;
    }
    if (event.key === "0" && !zoom.hidden) {
      event.preventDefault();
      event.stopPropagation();
      zoomed = !zoomed;
      applyZoom();
      fitFrame();
    }
  };

  /**
   * `aria-modal` is a claim, not a mechanism. Without this, Tab walks out of the overlay and into
   * the terminal wall behind it — the caret ends up somewhere you cannot see while a picture
   * covers the screen. Pull it back; the overlay's own buttons then cycle.
   */
  const keepFocus = (event: FocusEvent): void => {
    if (event.target instanceof Node && !root.contains(event.target)) {
      event.stopPropagation();
      root.focus();
    }
  };

  // The mat closes; the picture does not — closing on a click you meant as "look here" is the
  // classic misfire. A drag that ENDS on the mat is a pan that overshot, not a dismissal.
  let onMat = false;
  const isMat = (target: EventTarget | null): boolean =>
    target === root || target === stage || target === frame;
  root.addEventListener("pointerdown", (event) => {
    onMat = isMat(event.target);
  });
  root.addEventListener("click", (event) => {
    const wasMat = onMat;
    onMat = false;
    if (wasMat && isMat(event.target)) dismiss();
  });

  // Drag to pan while zoomed. Pointer capture so leaving the figure mid-drag does not strand it.
  let panning = false;
  let travelled = 0;
  let from = { x: 0, y: 0, left: 0, top: 0 };
  figure.addEventListener("pointerdown", (event) => {
    if (!zoomed || event.button !== 0) return;
    panning = true;
    travelled = 0;
    from = { x: event.clientX, y: event.clientY, left: figure.scrollLeft, top: figure.scrollTop };
    figure.setPointerCapture(event.pointerId);
    figure.classList.add("is-panning");
    event.preventDefault();
  });
  figure.addEventListener("pointermove", (event) => {
    if (!panning) return;
    const dx = event.clientX - from.x;
    const dy = event.clientY - from.y;
    travelled = Math.max(travelled, Math.abs(dx) + Math.abs(dy));
    figure.scrollLeft = from.left - dx;
    figure.scrollTop = from.top - dy;
  });
  const endPan = (event: PointerEvent): void => {
    if (!panning) return;
    panning = false;
    figure.classList.remove("is-panning");
    if (figure.hasPointerCapture(event.pointerId)) figure.releasePointerCapture(event.pointerId);
  };
  figure.addEventListener("pointerup", endPan);
  figure.addEventListener("pointercancel", endPan);

  figure.addEventListener("click", (event) => {
    event.stopPropagation();
    // A pan that ended where it started is a click; one that moved is not.
    if (travelled > DRAG_SLOP) {
      travelled = 0;
      return;
    }
    if (zoom.hidden && !zoomed) return;
    zoomed = !zoomed;
    applyZoom({ x: event.clientX, y: event.clientY });
    fitFrame();
  });

  zoom.addEventListener("click", (event) => {
    event.stopPropagation();
    zoomed = !zoomed;
    applyZoom();
    fitFrame();
  });
  close.addEventListener("click", dismiss);
  back.addEventListener("click", (event) => {
    event.stopPropagation();
    go(-1);
  });
  next.addEventListener("click", (event) => {
    event.stopPropagation();
    go(1);
  });

  frame.append(figure);
  if (list.length > 1) frame.append(back, next);
  stage.append(frame);
  root.append(close, counter, zoom, stage, caption);
  document.body.append(root);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", onResize);
  document.addEventListener("focusin", keepFocus, true);
  openLightbox = dismiss;
  void paint();
  root.focus();
}

/** Make any element open the lightbox on click, without disturbing its other listeners. */
export function expandOnClick(
  node: HTMLElement,
  shots: () => { shots: LightboxShot[]; at: number },
): void {
  node.classList.add("is-expandable");
  node.title = node.title || "Click to expand";
  node.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const { shots: list, at } = shots();
    showLightbox(list, at);
  });
}
