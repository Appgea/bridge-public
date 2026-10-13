/**
 * Registration. Importing this file IS the wiring — `main.ts` does `import "./views"` and
 * nothing else in the app knows a single one of these names.
 *
 * Adding an expression type is one line here plus its renderer. Rust does not change, main.ts
 * does not change, the registry does not change. That is the whole design.
 */

import { registerAsk, registerView } from "../registry";
import type { ViewRenderer } from "../types";
import { cardAsk, confirmAsk, documentAsk, multiAsk, pickAsk, textAsk, tierAsk } from "./asks";
import { renderCard } from "./card";
import { educateView } from "./educate";
import { messageView } from "./message";
import { showcaseView } from "./showcase";
import { simView } from "./sim";
import { structureView } from "./structure";
import { traceView } from "./trace";
import "./views.css";

const cardView: ViewRenderer = (payload, ctx) => renderCard(payload, ctx, null);

registerView("trace", traceView);
registerView("card", cardView); // also the fallback for any type with no renderer
registerView("structure", structureView);
registerView("showcase", showcaseView);
registerView("educate", educateView);
registerView("message", messageView);
registerView("sim", simView);

registerAsk("pick", pickAsk);
registerAsk("choice", pickAsk);
registerAsk("multi", multiAsk);
registerAsk("text", textAsk);
registerAsk("tier", tierAsk);
registerAsk("confirm", confirmAsk);
registerAsk("card", cardAsk);
registerAsk("document", documentAsk);
