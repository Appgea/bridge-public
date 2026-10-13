/**
 * The input kit. ONE implementation of every question, used from two places:
 *
 *   - the ask panel   -> `commit` is wired to the socket; a real agent thread is parked on it
 *   - a card's `input` block -> live inside a card ask, inert inside a card display view
 *
 * `commit` is the whole contract. Non-null means live; null means draw it, don't arm it.
 * It fires AT MOST ONCE — after that the subtree is dead, because the thread on the other end
 * has already moved on and a second answer has nowhere to go.
 *
 * Each widget commits its NATURAL SCALAR (an option id, an id list, a string, a tier, a bool).
 * The wrapping into `{id}` / `{ids}` / `{text}` / `{tier}` / `{confirmed}` happens in asks.ts —
 * so a card input can carry the same scalar under its own key without a second code path.
 */

import type { AskSpec } from "../types";
import { arr, bool, disable, el, num, obj, prose, str } from "./dom";

export type Commit = (value: unknown) => void;

export function renderInput(spec: AskSpec, commit: Commit | null): HTMLElement {
  const kind = str(spec.kind, "pick");
  const root = el("div", `v-in v-in-${kind}`);
  const fire = commit ? once(root, commit) : null;

  switch (kind) {
    case "multi":
      multi(root, spec, fire);
      break;
    case "text":
      freeText(root, spec, fire);
      break;
    case "tier":
      tier(root, spec, fire);
      break;
    case "confirm":
      confirmGate(root, spec, fire);
      break;
    default:
      pick(root, spec, fire);
      break;
  }

  if (!fire) {
    // A display card shows the question the agent asked, but there is nothing to answer to.
    root.classList.add("is-inert");
    disable(root);
  }
  return root;
}

/** One answer, ever. Then the controls die. */
function once(root: HTMLElement, commit: Commit): Commit {
  let spent = false;
  return (value: unknown) => {
    if (spent) return;
    spent = true;
    root.classList.add("is-locked");
    disable(root);
    commit(value);
  };
}

/* ----------------------------------------------------------------- shared */

function question(root: HTMLElement, text: string): void {
  if (text) root.append(el("p", "v-ask", text));
}

/**
 * The signature. `rec` + `why` is the agent putting its name on an answer — it is the most
 * valuable thing in the widget, so it sits directly under the question, above the options.
 */
function signature(root: HTMLElement, recLabel: string, why: string): void {
  if (!recLabel && !why) return;
  const node = el("div", "v-sign");
  node.append(el("i", "v-sign-tag", "recommends"));
  if (recLabel) node.append(el("b", undefined, recLabel));
  if (why) node.append(prose(why, "v-sign-why"));
  root.append(node);
}

function actions(root: HTMLElement): HTMLElement {
  const bar = el("div", "v-actions");
  root.append(bar);
  return bar;
}

function button(label: string, className: string): HTMLButtonElement {
  const node = el("button", className, label);
  node.type = "button";
  return node;
}

/* ------------------------------------------------------------------- pick */

function pick(root: HTMLElement, spec: AskSpec, fire: Commit | null): void {
  const options = arr(spec.options).map(obj);
  const rec = str(spec.rec);
  const recOption = options.find((option) => str(option.id) === rec);

  question(root, str(spec.ask));
  signature(root, recOption ? str(recOption.title, rec) : rec, str(spec.why));

  const list = el("div", "v-opts");
  for (const option of options) {
    const id = str(option.id);
    const node = button("", "v-opt");
    node.append(el("b", undefined, str(option.title, id)));
    const desc = str(option.desc);
    if (desc) node.append(el("small", undefined, desc));
    if (id === rec) {
      node.classList.add("is-rec");
      node.append(el("i", "v-chip", "rec"));
    }
    node.addEventListener("click", () => {
      node.classList.add("is-chosen");
      fire?.(id);
    });
    list.append(node);
  }
  root.append(list);
}

/* ------------------------------------------------------------------ multi */

function multi(root: HTMLElement, spec: AskSpec, fire: Commit | null): void {
  const options = arr(spec.options).map(obj);
  const rec = arr(spec.rec).map((id) => str(id));
  const min = num(spec.min, 0);
  const max = num(spec.max, options.length || Number.MAX_SAFE_INTEGER);

  question(root, str(spec.ask));
  const recTitles = rec
    .map((id) => {
      const option = options.find((candidate) => str(candidate.id) === id);
      return option ? str(option.title, id) : id;
    })
    .join(", ");
  signature(root, recTitles, str(spec.why));

  const chosen = new Set(rec.filter((id) => options.some((option) => str(option.id) === id)));
  const list = el("div", "v-opts");
  const nodes = new Map<string, HTMLButtonElement>();

  for (const option of options) {
    const id = str(option.id);
    const node = button("", "v-opt v-opt-multi");
    node.setAttribute("aria-pressed", String(chosen.has(id)));
    node.append(el("i", "v-box"));
    const body = el("span", "v-opt-body");
    body.append(el("b", undefined, str(option.title, id)));
    const desc = str(option.desc);
    if (desc) body.append(el("small", undefined, desc));
    node.append(body);
    node.addEventListener("click", () => {
      if (chosen.has(id)) chosen.delete(id);
      else chosen.add(id);
      node.setAttribute("aria-pressed", String(chosen.has(id)));
      sync();
    });
    nodes.set(id, node);
    list.append(node);
  }
  root.append(list);

  const bar = actions(root);
  const count = el("small", "v-count");
  const submit = button("Confirm", "v-go");
  bar.append(count, submit);

  function sync(): void {
    const size = chosen.size;
    const ok = size >= min && size <= max;
    const bound = min > 0 ? ` · pick at least ${min}` : "";
    count.textContent = `${size} selected${ok ? "" : bound}`;
    count.classList.toggle("is-short", !ok);
    submit.disabled = !ok;
  }
  sync();

  submit.addEventListener("click", () => {
    const ids = options.map((option) => str(option.id)).filter((id) => chosen.has(id));
    for (const [id, node] of nodes) node.classList.toggle("is-chosen", chosen.has(id));
    fire?.(ids);
  });
}

/* ------------------------------------------------------------------- text */

function freeText(root: HTMLElement, spec: AskSpec, fire: Commit | null): void {
  const draft = str(spec.draft);
  const multiline = bool(spec.multiline) || draft.includes("\n");

  question(root, str(spec.ask));
  const why = str(spec.why);
  if (draft || why) {
    const note = el("div", "v-sign");
    note.append(el("i", "v-sign-tag", draft ? "draft" : "recommends"));
    note.append(prose(why || "the agent's draft — accept it or edit it", "v-sign-why"));
    root.append(note);
  }

  const field: HTMLInputElement | HTMLTextAreaElement = multiline
    ? el("textarea", "v-field")
    : el("input", "v-field");
  if (field instanceof HTMLInputElement) field.type = "text";
  if (field instanceof HTMLTextAreaElement) field.rows = 3;
  field.value = draft;
  const placeholder = str(spec.placeholder);
  if (placeholder) field.placeholder = placeholder;
  root.append(field);

  const bar = actions(root);
  const submit = button("Send", "v-go");
  bar.append(el("small", "v-count", multiline ? "⇧⏎ for a new line" : ""), submit);

  const send = (): void => fire?.(field.value);
  submit.addEventListener("click", send);
  field.addEventListener("keydown", (raw: Event) => {
    const event = raw as KeyboardEvent;
    if (event.key !== "Enter") return;
    if (multiline && event.shiftKey) return;
    event.preventDefault();
    send();
  });
}

/* ------------------------------------------------------------------- tier */

function tier(root: HTMLElement, spec: AskSpec, fire: Commit | null): void {
  const tiers = arr(spec.tiers).map((value) => str(value));
  const rec = str(spec.rec);

  question(root, str(spec.ask));
  signature(root, rec, str(spec.why));

  const scale = el("div", "v-scale");
  tiers.forEach((label, index) => {
    const node = button(label, "v-tier");
    node.style.setProperty("--i", String(index));
    if (label === rec) {
      node.classList.add("is-rec");
      node.append(el("i", "v-chip", "rec"));
    }
    node.addEventListener("click", () => {
      node.classList.add("is-chosen");
      fire?.(label);
    });
    scale.append(node);
  });
  root.append(scale);
}

/* ---------------------------------------------------------------- confirm */

/**
 * The STOP gate. Publish, spend, credentials — things the human cannot take back.
 *
 * When `danger` is set the approve button ARMS before it fires: two deliberate clicks, the
 * second one red and explicit. Asking at all is the recommendation; the button must never be
 * something you hit on the way to somewhere else.
 */
function confirmGate(root: HTMLElement, spec: AskSpec, fire: Commit | null): void {
  const danger = bool(spec.danger);
  if (danger) root.classList.add("is-danger");

  const meta = el("div", "v-gate-meta");
  meta.append(el("i", "v-gate-dot"));
  meta.append(el("span", undefined, danger ? "stop-tier · hard to reverse" : "approval"));
  root.append(meta);

  question(root, str(spec.action) || str(spec.ask));
  const detail = str(spec.detail);
  if (detail) root.append(prose(detail, "v-gate-detail"));

  const bar = actions(root);
  const no = button("No", "v-no");
  const yes = button(danger ? "Approve" : "Yes", danger ? "v-yes is-danger" : "v-yes");
  bar.append(no, yes);

  no.addEventListener("click", () => {
    no.classList.add("is-chosen");
    fire?.(false);
  });

  let armed = false;
  yes.addEventListener("click", () => {
    if (danger && !armed) {
      armed = true;
      yes.classList.add("is-armed");
      yes.textContent = "Confirm — irreversible";
      return;
    }
    yes.classList.add("is-chosen");
    fire?.(true);
  });
}
