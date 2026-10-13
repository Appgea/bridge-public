---
name: taste
description: Catch obvious bad UI/UX/flow automatically AND pre-digest genuine taste calls for the human. Invoke automatically—even when not named—on any UI, UX, screen-flow, screenshot, video hook, copy, or "which one / is this good enough" work. Two modes — a cheap OBJECTIVE competence gate that fixes ugly/dumb design itself (low contrast, clutter, dead ends, too many taps, no hierarchy) without bugging the owner, and a SUBJECTIVE proxy/panel that drafts a ready-to-approve template only for real judgment/brand/feel calls. Token-frugal; never the final word on their taste.
---

# taste — competence gate + the human's taste proxy

Two jobs. Read the model first: `ops/_system/taste.md` (gate checklist, axes, weights, panel,
calibration). Pull the latest weights/calibration from there every run.

1. **GATE (automatic, cheap, no human):** catch OBJECTIVE ugly/dumb UI/UX/flow and fix it yourself.
2. **DECIDE (human-gated):** for genuine subjective/brand/feel calls, draft for the owner — single proxy,
   or a small distinct-lens panel when the call is close or consequential.

The point: obvious bad design must NOT reach the owner. They are the layer for taste, not for competence.

## Mode A — Gate  (runs on any UI/flow work: before shipping, and before any escalation)
1. Read `taste.md` Layer 0. Do ONE cheap pass — low reasoning effort, NO subagents.
2. Any objective failure (contrast, alignment, hierarchy, clutter, dead end, missing state, extra
   taps, hidden primary action) → **FIX it** (reversible UI/code) and note it in one line. Don't ask.
3. Only what SURVIVES the gate and is genuinely a judgment/brand/feel call goes to Mode B.
If nothing subjective remains, you're done — report the fixes, don't manufacture a taste question.

## Mode B — Decide  (only for what passed the gate AND is subjective)
1. Apply the six axes + current weights; score each candidate 1–5 with a terse reason.
2. Check hard anti-patterns; flag any hit regardless of score.
3. If the call is CLOSE or CONSEQUENTIAL, convene the panel (distinct lenses, parallel, 2 lines
   each — see `taste.md`). Otherwise the single proxy pass is enough. Never redundant voters.
4. Pick the proxy favorite + confidence (LOW when it leans on visual craft you can't see, or weights
   are untuned). Draft a response in their voice.

### Output template (Mode B — always this shape, Slack-short)
```
DECISION: <one line>     [gate: fixed <n> objective issues — <list, if any>]
CANDIDATES: A — <label>, B — <label>, …

TASTE READ (proxy — not final):
| axis           | A | B | note |
| purity         | n | n | … |
| visual demand  | n | n | … (human eyes if unsure) |
| path length    | n | n | … |
| hook           | n | n | … |
| interaction    | n | n | … |
| attention      | n | n | … |
| weighted total | n | n | |
[PANEL (if convened): Hook <v> · Flow <v> · Craft <v> · Brand <v>]

PROXY PICK: <A> · confidence <low/med/high> · because <one line>
WATCH-OUT: <where this could be wrong / what needs your eyes>

DRAFTED RESPONSE (yours to send or approve):
"<1–2 lines in their voice>"

→ Approve, or override in one line.
```

## Token discipline (he asked — wasting tokens harms the nature)
- Cheapest sufficient method first; gate before panel; single proxy before panel.
- Judge agents ONLY when cost-of-being-wrong is real or the call is close. Distinct lenses, no
  redundant voters. Short verdicts. Reuse `impeccable` heuristics for the gate.

## Learning (ambient — the model improves itself)
- On OVERRIDE or any clear reaction ("too busy", "love it", "shorter", "weak hook") append one line
  to Calibration in `taste.md`: `- <date> | <decision> | proxy: X | chose/said: Y | because <words>`.
- A reliable reject → add to anti-patterns (and, if objective, to the Layer-0 gate).
- A repeating axis preference → PROPOSE a weight nudge, ask once. Distill Calibration at ~20 lines.
Silent for appends; pause only to confirm weight changes. Never interrogate.

## Rules
- The gate FIXES objective issues autonomously; the proxy NEVER decides subjective taste for the owner.
- Be honest about confidence; don't fake certainty on craft you can't see. Close call → "needs your eye".
- Keep it tight — this saves the owner time. As models improve, the gate should absorb more, and what
  reaches the owner should shrink toward only the true taste calls.
