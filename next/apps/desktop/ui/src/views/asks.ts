/**
 * The ask widgets. Each one is the input kit plus the answer shape it owns:
 *
 *   pick    -> { id }          multi   -> { ids }        text -> { text }
 *   tier    -> { tier }        confirm -> { confirmed }
 *   document -> { path, contents }
 *   card    -> { [inputId]: <scalar from the nested input block> }
 *
 * `kind` is forced rather than trusted, because the registry falls back to `pick` for any kind
 * it doesn't know — and a widget that renders the wrong shape is worse than one that renders
 * the plain one.
 */

import type { AskSpec, AskWidget } from "../types";
import { arr, str } from "./dom";
import { renderCard } from "./card";
import { renderInput } from "./inputs";

const as = (spec: AskSpec, kind: string): AskSpec => {
  // MCP allows plain labels and marks the pick on the option; the kit wants {id,title} and `rec`.
  const options = arr(spec.options).map((option) =>
    typeof option === "string" ? { id: option, title: option } : option,
  );
  const marked = options.find(
    (option): option is Record<string, unknown> =>
      typeof option === "object" && option !== null && (option as Record<string, unknown>).recommended === true,
  );
  return {
    ...spec,
    kind,
    options,
    rec: str(spec.rec) || str(marked?.id),
    // MCP calls this `prompt`; protocol-native cards call it `ask`.
    ask: str(spec.ask) || str(spec.prompt),
  };
};

export const pickAsk: AskWidget = (spec, answer) =>
  renderInput(as(spec, "pick"), (value) => answer({ id: str(value) }));

export const multiAsk: AskWidget = (spec, answer) =>
  renderInput(as(spec, "multi"), (value) => answer({ ids: arr(value).map((id) => str(id)) }));

export const textAsk: AskWidget = (spec, answer) =>
  renderInput(as(spec, "text"), (value) => answer({ text: str(value) }));

export const tierAsk: AskWidget = (spec, answer) =>
  renderInput(as(spec, "tier"), (value) => answer({ tier: str(value) }));

export const confirmAsk: AskWidget = (spec, answer) =>
  renderInput(as(spec, "confirm"), (value) => answer({ confirmed: value === true }));

/** The same card as the display view — but its `input` block is armed. */
export const cardAsk: AskWidget = (spec, answer, ctx) =>
  renderCard(spec, ctx, (id, value) => answer({ [id]: value }));

/** A real editor handoff. The panel carries the reason; Work owns the document. */
export const documentAsk: AskWidget = (spec, answer, ctx) => {
  const root = document.createElement("article");
  root.className = "v-in v-in-document";
  const path = str(spec.path, ".panel/agent-input.md");
  const title = str(spec.title, "Work in document");
  const prompt = str(spec.prompt) || str(spec.ask) || str(spec.why);
  const draft = str(spec.draft);
  root.innerHTML = `
    <span class="v-doc-kicker">WORKBENCH HANDOFF</span>
    <h3></h3><p class="v-ask"></p><code></code>
    <small class="v-doc-status">Open this in Work, edit normally, then continue.</small>
    <div class="v-actions"><button class="v-doc-open" type="button">Open in Work</button><button class="v-go" type="button" disabled>Continue</button></div>`;
  root.querySelector("h3")!.textContent = title;
  root.querySelector(".v-ask")!.textContent = prompt;
  root.querySelector("code")!.textContent = path;
  const status = root.querySelector<HTMLElement>(".v-doc-status")!;
  const open = root.querySelector<HTMLButtonElement>(".v-doc-open")!;
  const finish = root.querySelector<HTMLButtonElement>(".v-go")!;
  let busy = false;

  open.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    open.disabled = true;
    status.textContent = "Opening the Work editor…";
    try {
      await ctx.openDocument(path, draft);
      open.textContent = "Back to document";
      open.disabled = false;
      finish.disabled = false;
      status.textContent = "Your edits stay in the project. Continue saves and returns them.";
    } catch (error) {
      open.disabled = false;
      status.textContent = String(error);
      root.classList.add("is-error");
    } finally {
      busy = false;
    }
  });

  finish.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    open.disabled = true;
    finish.disabled = true;
    status.textContent = "Saving…";
    try {
      const contents = await ctx.finishDocument(path);
      answer({ path, contents });
    } catch (error) {
      open.disabled = false;
      finish.disabled = false;
      status.textContent = String(error);
      root.classList.add("is-error");
    } finally {
      busy = false;
    }
  });
  return root;
};
