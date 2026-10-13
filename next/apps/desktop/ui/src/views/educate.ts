/**
 * `educate` — a durable map of a subsystem, so ownership survives the LLM leaving.
 *
 * Collapsed, it is a scannable index: name, layer, one line of purpose. Expanded, it answers
 * the only two questions that matter for ownership — what it IS, and what BREAKS if it fails.
 * The failure line is the payload's `f`; it gets the risk tone because that is the sentence the
 * human will be reading at 2am.
 */

import type { Payload, RenderCtx, ViewRenderer } from "../types";
import { arr, el, obj, refButton, str } from "./dom";

export const educateView: ViewRenderer = (payload: Payload, ctx: RenderCtx): HTMLElement => {
  const root = el("article", "v v-educate");

  const header = el("header", "v-head");
  header.append(el("i", "v-eyebrow", "map"));
  header.append(el("h3", "v-title", str(payload.title, "how this works")));
  root.append(header);

  const classes = arr(payload.classes).map(obj);
  const list = el("div", "v-classes");

  classes.forEach((entry, index) => {
    const row = el("div", "v-class");
    row.style.setProperty("--i", String(index));

    const toggle = el("button", "v-class-head");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", "false");
    toggle.append(el("i", "v-caret", "›"));
    toggle.append(el("b", "v-class-name", str(entry.n)));
    const layer = str(entry.l);
    if (layer) toggle.append(el("span", "v-class-layer", layer));
    toggle.append(el("small", "v-class-purpose", str(entry.p)));
    row.append(toggle);

    const body = el("div", "v-class-body");
    body.hidden = true;

    const purpose = str(entry.p);
    if (purpose) body.append(fact("is", purpose, ""));
    const fails = str(entry.f);
    if (fails) body.append(fact("if it fails", fails, "t-risk"));
    const touches = str(entry.t);
    if (touches) body.append(fact("talks to", touches, ""));

    const file = str(entry.file);
    if (file) {
      const line = el("div", "v-fact");
      line.append(el("i", undefined, "lives in"));
      line.append(refButton(file, ctx));
      body.append(line);
    }
    row.append(body);

    toggle.addEventListener("click", () => {
      const open = body.hidden === true;
      body.hidden = !open;
      row.classList.toggle("is-open", open);
      toggle.setAttribute("aria-expanded", String(open));
    });

    list.append(row);
  });

  if (!classes.length) list.append(el("p", "v-empty", "nothing mapped"));
  root.append(list);
  return root;
};

function fact(label: string, value: string, tone: string): HTMLElement {
  const node = el("div", "v-fact");
  node.append(el("i", undefined, label));
  node.append(el("span", tone, value));
  return node;
}
