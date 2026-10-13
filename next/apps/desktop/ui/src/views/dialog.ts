/**
 * In-app confirm / alert / prompt.
 *
 * The webview (wry) does not implement the native JavaScript dialog panels, so `window.confirm`
 * returns false without asking, `window.alert` shows nothing, and `window.prompt` returns null.
 * That silently killed every guarded action — closing a running session tab, discarding changes,
 * a store release — because `if (!window.confirm(...)) return;` always took the early return.
 *
 * These replace them. They are async — a modal cannot block the JS event loop the way the native
 * ones did, so callers `await` instead. Enter confirms, Escape cancels, clicking the backdrop
 * cancels; focus lands on the input (prompt) or the primary button.
 */

import "./dialog.css";

type ConfirmOpts = {
  okLabel?: string;
  cancelLabel?: string;
  /** Paint the primary button as destructive (red). */
  danger?: boolean;
};

function open(label: string, build: (card: HTMLElement, resolve: () => void) => void): void {
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const wrap = document.createElement("div");
  wrap.className = "dlg-wrap";
  const card = document.createElement("div");
  card.className = "dlg-card mo-rise";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-label", label);
  wrap.append(card);

  let closed = false;
  const done = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey, true);
    wrap.remove();
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      card.dispatchEvent(new CustomEvent("dlg-cancel"));
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...card.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    )].filter((node) => !node.hidden);
    if (!focusable.length) {
      event.preventDefault();
      card.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  document.addEventListener("keydown", onKey, true);
  wrap.addEventListener("mousedown", (event) => {
    if (event.target === wrap) card.dispatchEvent(new CustomEvent("dlg-cancel"));
  });

  build(card, done);
  document.body.append(wrap);
}

function message(text: string): HTMLParagraphElement {
  const p = document.createElement("p");
  p.className = "dlg-msg";
  // Author-supplied strings carry \n and may contain names/paths — set as text, never HTML.
  p.textContent = text;
  return p;
}

/** Ask a yes/no. Resolves true only on the primary button (or Enter). */
export function confirmDialog(text: string, opts: ConfirmOpts = {}): Promise<boolean> {
  return new Promise((resolve) => {
    open("Confirmation", (card, done) => {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "dlg-btn";
      cancel.textContent = opts.cancelLabel ?? "Cancel";

      const ok = document.createElement("button");
      ok.type = "button";
      ok.className = opts.danger ? "dlg-btn dlg-danger" : "dlg-btn dlg-primary";
      ok.textContent = opts.okLabel ?? "OK";

      const settle = (value: boolean) => {
        done();
        resolve(value);
      };
      cancel.addEventListener("click", () => settle(false));
      ok.addEventListener("click", () => settle(true));
      card.addEventListener("dlg-cancel", () => settle(false));

      const row = document.createElement("div");
      row.className = "dlg-row";
      row.append(cancel, ok);
      card.append(message(text), row);
      card.tabIndex = -1;
      requestAnimationFrame(() => ok.focus());
    });
  });
}

export type ChecklistItem = {
  id: string;
  label: string;
  /** Right-aligned hint (e.g. prior state). */
  note?: string;
  /** Defaults to checked when omitted. */
  checked?: boolean;
  /** Rendered dimmed, cannot be toggled, never returned. */
  disabled?: boolean;
};

/**
 * Confirm an action AND pick a subset in one modal. Resolves null on cancel, or the array of
 * checked (non-disabled) ids on the primary button. Same danger styling as confirmDialog.
 */
export function checklistDialog(
  text: string,
  choices: ChecklistItem[],
  opts: ConfirmOpts = {},
): Promise<string[] | null> {
  return new Promise((resolve) => {
    open("Checklist", (card, done) => {
      const list = document.createElement("div");
      list.className = "dlg-checklist";
      const inputs = new Map<string, HTMLInputElement>();
      for (const choice of choices) {
        const label = document.createElement("label");
        label.className = choice.disabled ? "dlg-check is-disabled" : "dlg-check";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = choice.checked ?? true;
        input.disabled = !!choice.disabled;
        inputs.set(choice.id, input);
        const span = document.createElement("span");
        span.textContent = choice.label;
        label.append(input, span);
        if (choice.note) {
          const note = document.createElement("small");
          note.textContent = choice.note;
          label.append(note);
        }
        list.append(label);
      }

      const selected = (): string[] =>
        choices
          .filter((choice) => !choice.disabled && inputs.get(choice.id)!.checked)
          .map((choice) => choice.id);

      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "dlg-btn";
      cancel.textContent = opts.cancelLabel ?? "Cancel";

      const ok = document.createElement("button");
      ok.type = "button";
      ok.className = opts.danger ? "dlg-btn dlg-danger" : "dlg-btn dlg-primary";
      ok.textContent = opts.okLabel ?? "OK";

      const settle = (value: string[] | null) => {
        done();
        resolve(value);
      };
      cancel.addEventListener("click", () => settle(null));
      ok.addEventListener("click", () => settle(selected()));
      card.addEventListener("dlg-cancel", () => settle(null));

      const row = document.createElement("div");
      row.className = "dlg-row";
      row.append(cancel, ok);
      card.append(message(text), list, row);
      card.tabIndex = -1;
      requestAnimationFrame(() => ok.focus());
    });
  });
}

/** Say something and wait for acknowledgement. */
export function alertDialog(text: string): Promise<void> {
  return new Promise((resolve) => {
    open("Alert", (card, done) => {
      const ok = document.createElement("button");
      ok.type = "button";
      ok.className = "dlg-btn dlg-primary";
      ok.textContent = "OK";
      const settle = () => {
        done();
        resolve();
      };
      ok.addEventListener("click", settle);
      card.addEventListener("dlg-cancel", settle);

      const row = document.createElement("div");
      row.className = "dlg-row";
      row.append(ok);
      card.append(message(text), row);
      card.tabIndex = -1;
      requestAnimationFrame(() => ok.focus());
    });
  });
}

/** Ask for one line of text. Resolves null on cancel, the string (possibly empty) on OK. */
export function promptDialog(label: string, value = ""): Promise<string | null> {
  return new Promise((resolve) => {
    open("Prompt", (card, done) => {
      const input = document.createElement("input");
      input.type = "text";
      input.className = "dlg-input";
      input.value = value;
      input.setAttribute("aria-label", label);

      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "dlg-btn";
      cancel.textContent = "Cancel";

      const ok = document.createElement("button");
      ok.type = "button";
      ok.className = "dlg-btn dlg-primary";
      ok.textContent = "OK";

      const settle = (result: string | null) => {
        done();
        resolve(result);
      };
      cancel.addEventListener("click", () => settle(null));
      ok.addEventListener("click", () => settle(input.value));
      card.addEventListener("dlg-cancel", () => settle(null));
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") settle(input.value);
      });

      const row = document.createElement("div");
      row.className = "dlg-row";
      row.append(cancel, ok);
      card.append(message(label), input, row);
      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
    });
  });
}
