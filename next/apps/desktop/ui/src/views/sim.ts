/**
 * The `sim` status card — a simulator run's resting face on the Stage.
 *
 * It renders the current lifecycle state (launching / running / reloaded / error) and carries the
 * three controls the human reaches for: hot reload, hot restart, and bring-the-sim-to-front. Reload
 * is not a special backend path — the run is a real PTY, so "reload" is literally writing `r` into
 * it, exactly what typing `r` in the terminal deck does. One persistent card per project; `main.ts`
 * updates it in place rather than stacking a new one per status event.
 */

import { invoke } from "@tauri-apps/api/core";
import type { Payload, ViewRenderer } from "../types";

export const simView: ViewRenderer = (payload) => {
  const terminalId = String(payload.terminalId ?? "");
  const stateName = String(payload.state ?? "…");
  const device = String(payload.device ?? "");
  const kind = String(payload.kind ?? "");
  const ms = typeof payload.ms === "number" ? ` · ${payload.ms}ms` : "";

  const card = document.createElement("div");
  card.className = `sim-card sim-${stateName}`;
  card.innerHTML = `
    <div class="sim-head">
      <span class="sim-ic">📱</span>
      <span class="sim-dev"></span>
      <span class="sim-state"></span>
    </div>
    <div class="sim-sub"></div>
    <div class="sim-acts">
      <button class="sim-btn sim-primary" data-do="r" type="button">↻ Hot reload</button>
      <button class="sim-btn" data-do="R" type="button">⟳ Restart</button>
      <button class="sim-btn" data-do="front" type="button">⤒ Front</button>
    </div>`;

  card.querySelector(".sim-dev")!.textContent = device || "simulator";
  card.querySelector(".sim-state")!.textContent = stateName;
  card.querySelector(".sim-sub")!.textContent = [kind, ms].filter(Boolean).join("").trim();

  card.querySelectorAll<HTMLButtonElement>("[data-do]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.do;
      if (action === "front") {
        void invoke("sim_focus");
        return;
      }
      // `r` hot reload / `R` hot restart — a write to the run's PTY, same as the terminal keypress.
      if (terminalId) {
        void invoke("write_terminal", { terminalId, data: action === "R" ? "R" : "r" });
      }
    });
  });

  return card;
};

/** Re-export the payload type so callers importing this module type the update cleanly. */
export type SimPayload = Payload;
