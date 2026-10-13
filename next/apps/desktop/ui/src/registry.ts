/**
 * Two registries, one rule: the type name is the only coupling.
 *
 * Rust never inspects a view payload or an ask spec — it routes them by string. So adding
 * a visual or a question kind is a `registerView` / `registerAsk` call here and nothing
 * else, anywhere. Unknown types must still render: they fall back to the generic card,
 * because a missing renderer is a cosmetic gap, never a dropped message from the agent.
 */

import type { AskSpec, AskWidget, Payload, RenderCtx, ViewRenderer } from "./types";

const views = new Map<string, ViewRenderer>();
const asks = new Map<string, AskWidget>();

export function registerView(type: string, render: ViewRenderer): void {
  views.set(type, render);
}

export function registerAsk(kind: string, widget: AskWidget): void {
  asks.set(kind, widget);
}

/** Route a view by type, falling back to `card`, then to a last-resort dump. */
export function renderView(type: string, payload: Payload, ctx: RenderCtx): HTMLElement {
  const render = views.get(type) ?? views.get("card");
  if (!render) return fallback(type, payload);
  try {
    return render(payload, ctx);
  } catch (error) {
    return fallback(type, payload, error);
  }
}

/**
 * Route a question by kind. `kind` is optional in the MCP tool, and the tool promises that an
 * unknown one renders as a text prompt — so options decide the default, and text is the floor.
 */
export function renderAsk(
  spec: AskSpec,
  answer: (value: unknown) => void,
  ctx: RenderCtx,
): HTMLElement {
  const kind = spec.kind ?? (Array.isArray(spec.options) && spec.options.length ? "pick" : "text");
  const widget = asks.get(kind) ?? asks.get("text");
  if (!widget) return fallback(kind, spec);
  try {
    return widget(spec, answer, ctx);
  } catch (error) {
    return fallback(kind, spec, error);
  }
}

/**
 * Never swallow the agent's message. If a renderer is missing or throws, show the raw
 * payload — an ugly card beats a silent one, because silence looks like the agent said
 * nothing when in fact we dropped it.
 */
function fallback(type: string, payload: unknown, error?: unknown): HTMLElement {
  const node = document.createElement("article");
  node.className = "view view-raw";
  const head = document.createElement("header");
  head.textContent = error ? `${type} — renderer failed` : type;
  const body = document.createElement("pre");
  body.textContent = JSON.stringify(payload, null, 2);
  node.append(head, body);
  return node;
}
