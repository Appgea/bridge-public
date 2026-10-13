/**
 * Standards — what this app is supposed to have, and what it still does not.
 *
 * A standard is a markdown file in `ops/standards/`, written by the human or by an agent. The
 * module derives conformance at call time; nothing about it is stored, here or anywhere else.
 * The card is therefore always current and never needs a refresh button.
 *
 * The card exists because drift is invisible. One app gets the new thing, five wait for their
 * next release, and the wait is where it is forgotten. Seeing "2 open" on the screen you already
 * open every day is the whole intervention.
 */

import { moduleGet } from "./modules";

const M = "/m/standards";

type Row = { id: string; title: string; state: "pass" | "fail" | "?"; note: string; fixable: boolean };
type AppStandards = { registered: boolean; key?: string; rows: Row[]; open: Row[]; passing: number };

const esc = (value: unknown): string =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      (({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }) as Record<string, string>)[c] ?? c,
  );

/** The open standards for one project, or null when it is not in the portfolio spine. */
export async function readStandards(path: string): Promise<AppStandards | null> {
  try {
    const data = await moduleGet<AppStandards>(`${M}/app?root=${encodeURIComponent(path)}`);
    return data.registered ? data : null;
  } catch {
    return null;
  }
}

/**
 * What the card hands the agent. One standard at a time on purpose: "fix everything" is how an
 * agent ends up rewriting six apps at once, and every one of these is a real change to a shipped
 * product.
 */
export function standardPrompt(projectPath: string, row: Row): string {
  return [
    `This app fails the portfolio standard "${row.id}" — ${row.title}.`,
    row.note ? `The check says: ${row.note}.` : "",
    `Read ~/.appgeapanel/ops/standards/${row.id}.md for what the standard means and why it exists.`,
    `Bring ${projectPath} up to it, then re-run \`python3 ~/.appgeapanel/ops/_system/standards.py ${row.id}\` and paste the line for this app.`,
    "Change nothing else. Do not release, submit, or bump a version.",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Paint the dashboard card. `hand` runs one standard as an agent task; the caller owns how a
 * prompt reaches a terminal, exactly as the Git card does.
 */
export async function paintStandardsCard(
  path: string,
  host: HTMLElement,
  hand: (prompt: string) => void,
): Promise<void> {
  host.innerHTML = `<div class="std-loading">reading standards…</div>`;
  const data = await readStandards(path);
  if (!data) {
    host.innerHTML = `<div class="std-empty"><small>Not in the portfolio spine.</small></div>`;
    return;
  }
  if (!data.open.length) {
    host.innerHTML = `<div class="std-empty"><small>Meets all ${data.passing} standards.</small></div>`;
    return;
  }
  host.innerHTML = `
    <ul class="std-list">
      ${data.open
        .map(
          (row) => `
        <li class="std-row is-${row.state === "?" ? "unknown" : "fail"}">
          <button class="std-fix" type="button" data-id="${esc(row.id)}">
            <span class="std-mark" aria-hidden="true">${row.state === "?" ? "?" : "×"}</span>
            <span class="std-title">${esc(row.title)}</span>
            ${row.note ? `<span class="std-note">${esc(row.note)}</span>` : ""}
          </button>
        </li>`,
        )
        .join("")}
    </ul>`;
  for (const button of host.querySelectorAll<HTMLButtonElement>(".std-fix")) {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const row = data.open.find((r) => r.id === button.dataset.id);
      if (row) hand(standardPrompt(path, row));
    });
  }
}
