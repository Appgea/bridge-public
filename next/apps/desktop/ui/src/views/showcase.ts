/**
 * `showcase` — the agent's visual argument, in order.
 *
 * It used to draw coloured rectangles that stood in for phones. That was a diagram of a
 * screenshot set, not the set — and Panel can render the real files, so it should. This is a
 * projector: ONE shot at a time, big, with the rail underneath and the caption below it. A strip
 * of thumbnails answers "how many"; a projector answers "what does it look like", which is the
 * only question a showcase is ever asked.
 *
 * The same renderer serves three boxes at three sizes — the Inbox post, a tile on the terminal
 * wall, and that tile zoomed to the whole screen — because a presentation that looks different
 * depending on where you opened it is two presentations to maintain and one of them is wrong.
 *
 * Nothing here steals focus. On the wall the caret belongs to a terminal, and a picture that
 * swallowed the next keystroke would be worse than no picture at all: the arrow keys work only
 * once you have actually clicked the showcase.
 */

import { projectImage } from "../project-assets";
import type { Payload, RenderCtx, ViewRenderer } from "../types";
import { arr, el, obj, str } from "./dom";
import { showLightbox, type LightboxShot } from "./lightbox";

/** Only accept a colour we can vouch for. An arbitrary string in a style is an injection vector. */
function safeColor(value: unknown): string | null {
  const color = str(value).trim();
  return /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : null;
}

type Shot = {
  /** Project-relative path to a real image, or "" for a mockup shot. */
  path: string;
  title: string;
  caption: string;
  color: string | null;
};

const basename = (path: string): string => path.replaceAll("\\", "/").split("/").pop() || path;

/**
 * The agent may say `shots` or `images`, and either may hold bare strings or objects. A shot
 * needs a picture OR something to draw instead; anything with neither is not a shot and is
 * dropped rather than rendered as an empty frame.
 */
function shotsOf(payload: Payload): Shot[] {
  const source = arr(payload.shots).length ? arr(payload.shots) : arr(payload.images);
  return source
    .map((item): Shot => {
      if (typeof item === "string") return { path: item, title: "", caption: "", color: null };
      const shot = obj(item);
      return {
        path: str(shot.path),
        title: str(shot.title),
        caption: str(shot.caption, str(shot.cap)),
        color: safeColor(shot.color),
      };
    })
    .filter((shot) => shot.path || shot.title || shot.color);
}

export type ShowcaseHandle = {
  root: HTMLElement;
  /** How many shots it ended up with — 0 means there was nothing to show. */
  count: number;
  /** Move the projector. Wraps, so ← on the first shot lands on the last. */
  go(delta: number): void;
};

export type ShowcaseOptions = {
  /** Fill the box top to bottom instead of sizing to the picture — the wall tile and the stage. */
  fill?: boolean;
};

/**
 * Build a projector. Returns the handle rather than the element so a host that owns arrow keys
 * of its own (the zoomed wall tile) can drive it without reaching into the DOM.
 */
export function buildShowcase(
  payload: Payload,
  ctx: RenderCtx,
  options: ShowcaseOptions = {},
): ShowcaseHandle {
  const root = el("article", `v v-showcase${options.fill ? " is-fill" : ""}`);
  const project = str(payload._panel_project);
  const shots = shotsOf(payload);
  let at = 0;

  const head = el("header", "v-head v-sc-head");
  head.append(el("i", "v-eyebrow", "showcase"));
  head.append(el("h3", "v-title", str(payload.title, "Shots")));
  const counter = el("span", "v-sc-count");
  head.append(counter);
  /** Every real file in this show, in order — what the lightbox walks. */
  const lightboxShots = (): LightboxShot[] =>
    shots
      .filter((shot) => shot.path)
      .map((shot) => ({ project, path: shot.path, caption: shot.caption || shot.title }));
  /** Where the current shot sits once the mockup-only entries are dropped. */
  const lightboxIndex = (): number =>
    shots.slice(0, at + 1).filter((shot) => shot.path).length - 1;
  // There used to be a ⤢ here too. It duplicated what a click on the picture already does, and
  // it did so through a 12px glyph parked 4px from a DIFFERENT 12px glyph that navigates away —
  // the two hardest-to-hit, easiest-to-confuse targets in the view, one of them redundant.
  // The one door out. Expanding is what a click on the picture does, so opening the FILE is the
  // only thing left that needs a button — and it gets a real one, with a word on it.
  const open = el("button", "v-sc-open", "↗") as HTMLButtonElement;
  open.type = "button";
  open.title = "Open this file in the editor";
  open.setAttribute("aria-label", "Open this file in the editor");
  open.addEventListener("click", () => {
    const path = shots[at]?.path;
    if (path) ctx.openRef(path);
  });
  head.append(open);
  root.append(head);

  if (!shots.length) {
    root.append(el("p", "v-empty", "no shots"));
    return { root, count: 0, go: () => {} };
  }

  const stage = el("div", "v-sc-stage");
  const frame = el("figure", "v-sc-frame");
  const caption = el("figcaption", "v-sc-cap");
  const rail = el("div", "v-sc-rail");

  /** A shot with a file behind it draws the file; one without falls back to the old mockup, so a
   *  payload written against the previous showcase still renders as something. */
  const paintFrame = (shot: Shot): HTMLElement => {
    if (shot.path && project) {
      const image = projectImage(project, shot.path, shot.caption || basename(shot.path));
      image.className = "v-sc-img";
      // The projector's picture IS the view. Lazy-loading the one thing the box exists to show
      // buys nothing and costs a visible pop-in; the rail thumbnails stay lazy.
      image.loading = "eager";
      return image;
    }
    const screen = el("div", "v-screen");
    if (shot.color) screen.style.setProperty("--shot", shot.color);
    else screen.classList.add("is-flat");
    if (shot.title) screen.append(el("b", "v-screen-title", shot.title));
    screen.append(el("i", "v-screen-notch"));
    return screen;
  };

  const paint = (): void => {
    const shot = shots[at];
    counter.textContent = shots.length > 1 ? `${at + 1} / ${shots.length}` : "";
    open.hidden = !shot.path;
    frame.replaceChildren(paintFrame(shot));
    const words = shot.caption || shot.title;
    caption.textContent = words;
    caption.hidden = !words;
    rail.querySelectorAll<HTMLElement>(".v-sc-thumb").forEach((thumb, index) => {
      thumb.classList.toggle("is-on", index === at);
    });
  };

  const go = (delta: number): void => {
    if (shots.length < 2) return;
    at = (((at + delta) % shots.length) + shots.length) % shots.length;
    paint();
  };

  // Tapping the picture EXPANDS it. On the wall a showcase tile is a few hundred pixels tall and
  // the thing you actually want from it is "let me see that properly" — advancing the show is
  // what the chevrons, the thumbnails and ←/→ are for. Clicking a picture to skip past it was
  // the wall tile's most annoying habit.
  frame.addEventListener("click", () => {
    const list = lightboxShots();
    if (list.length) showLightbox(list, Math.max(lightboxIndex(), 0));
    else go(1);
  });
  frame.classList.add("is-clickable");
  stage.append(frame);

  if (shots.length > 1) {
    const back = el("button", "v-sc-nav is-back", "‹") as HTMLButtonElement;
    back.type = "button";
    back.title = "previous shot";
    back.addEventListener("click", (event) => {
      event.stopPropagation();
      go(-1);
    });
    const next = el("button", "v-sc-nav is-next", "›") as HTMLButtonElement;
    next.type = "button";
    next.title = "next shot";
    next.addEventListener("click", (event) => {
      event.stopPropagation();
      go(1);
    });
    stage.append(back, next);

    shots.forEach((shot, index) => {
      const thumb = el("button", "v-sc-thumb") as HTMLButtonElement;
      thumb.type = "button";
      thumb.title = shot.caption || shot.title || basename(shot.path);
      thumb.style.setProperty("--i", String(index));
      if (shot.path && project) {
        const image = projectImage(project, shot.path, "");
        image.className = "v-sc-thumb-img";
        thumb.append(image);
      } else {
        thumb.append(el("i", "v-sc-thumb-dot", String(index + 1)));
      }
      thumb.addEventListener("click", () => {
        at = index;
        paint();
      });
      rail.append(thumb);
    });
  }

  root.append(stage, caption);
  if (shots.length > 1) root.append(rail);

  // Arrows only once this showcase has been clicked into. Focus is never taken — on the wall it
  // belongs to a terminal, and a presentation is not worth a dropped keystroke. The flip side of
  // never taking focus is that nothing announces having it, so the ring (see .v-showcase:
  // focus-visible) is the whole signal that ←/→ are live now.
  root.tabIndex = 0;
  if (shots.length > 1) {
    root.setAttribute("aria-label", `${str(payload.title, "Shots")} — ${shots.length} shots, arrow keys to walk them`);
  }
  root.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    go(event.key === "ArrowRight" ? 1 : -1);
  });

  paint();
  return { root, count: shots.length, go };
}

export const showcaseView: ViewRenderer = (payload, ctx) => buildShowcase(payload, ctx).root;
