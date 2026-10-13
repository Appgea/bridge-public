/**
 * `trace` — a replayable walk through code the agent read.
 *
 * The point is auditability: the human scans the rail top-to-bottom, sees HOW the agent got
 * from the controller to the DB, and catches the wrong turn. So every step's `ref` is a live
 * jump into the editor — the trace is a set of doors, not a paragraph about doors.
 */

import type { Payload, RenderCtx, ViewRenderer } from "../types";
import { arr, el, obj, refButton, str } from "./dom";

export const traceView: ViewRenderer = (payload: Payload, ctx: RenderCtx): HTMLElement => {
  const root = el("article", "v v-trace");

  const header = el("header", "v-head");
  header.append(el("i", "v-eyebrow", "trace"));
  header.append(el("h3", "v-title", str(payload.title, "walkthrough")));
  root.append(header);

  const steps = arr(payload.steps).map(obj);
  const list = el("ol", "v-walk");

  steps.forEach((step, index) => {
    const row = el("li", "v-walk-step");
    row.style.setProperty("--i", String(index));

    const rail = el("div", "v-walk-rail");
    rail.append(el("i", "v-walk-dot", String(index + 1)));
    row.append(rail);

    const body = el("div", "v-walk-body");
    body.append(el("b", "v-walk-label", str(step.label)));

    const ref = str(step.ref);
    if (ref) body.append(refButton(ref, ctx));

    const detail = str(step.detail);
    if (detail) body.append(el("small", "v-walk-detail", detail));

    row.append(body);
    list.append(row);
  });

  if (!steps.length) list.append(el("li", "v-empty", "no steps"));
  root.append(list);
  return root;
};
