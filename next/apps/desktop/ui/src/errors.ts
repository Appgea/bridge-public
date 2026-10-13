/**
 * What a failure says to the person looking at it.
 *
 * Rust answers a failed command with a sentence written for people ("no ops tree — set opsRoot in
 * config.json"), and that sentence is the most useful thing on screen. A thrown JS exception is a
 * Panel bug: "TypeError: Cannot read properties of null" tells the user nothing they can act on,
 * so it goes behind a Details toggle and to the console, never into the headline.
 */

const BUG = /^(TypeError|ReferenceError|RangeError|SyntaxError|InternalError)\b/;

export function describeError(error: unknown): { reason: string; details: string } {
  if (error instanceof Error) return { reason: "", details: `${error.name}: ${error.message}` };
  const text = String(error).trim();
  return BUG.test(text) ? { reason: "", details: text } : { reason: text, details: "" };
}

/** The reason when there is one a person can use, else the fallback sentence. */
export function errorText(error: unknown, fallback: string): string {
  const { reason, details } = describeError(error);
  if (details) console.error(fallback, details);
  return reason || fallback;
}

/**
 * A failed screen: one plain sentence, the backend's reason if it wrote one, Retry when the caller
 * can retry, and the raw error folded away for a bug report.
 */
export function errorNote(lead: string, error: unknown, retry?: () => void): HTMLElement {
  const { reason, details } = describeError(error);
  if (details) console.error(lead, details);
  const note = document.createElement("div");
  note.className = "error-note";
  note.setAttribute("role", "alert");
  const head = document.createElement("p");
  head.className = "error-note-lead";
  head.textContent = lead;
  note.append(head);
  if (reason) {
    const why = document.createElement("p");
    why.className = "error-note-reason";
    why.textContent = reason;
    note.append(why);
  }
  if (retry) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Try again";
    button.addEventListener("click", retry, { once: true });
    note.append(button);
  }
  if (details) {
    const fold = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Details";
    const pre = document.createElement("pre");
    pre.textContent = details;
    fold.append(summary, pre);
    note.append(fold);
  }
  return note;
}
