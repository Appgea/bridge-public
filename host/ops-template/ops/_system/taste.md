# Taste model — the human's eye, in two layers

Two different jobs, kept separate so the human's attention is never spent on the obvious:
- **Layer 0 — Competence gate (OBJECTIVE):** baseline UI/UX/flow competence. Not taste — just
  right vs wrong. The agent catches and FIXES these itself; it must NOT pull the human in.
- **Layer 1 — Taste (SUBJECTIVE):** the human's actual eye. Only what passes the gate AND is
  genuinely a judgment/brand/feel call reaches the owner — pre-digested so they act in seconds.

This is Tier-1 personal data. It LEARNS: every override appends to Calibration and nudges weights.
The `taste` skill reads this file.

## Layer 0 — Competence gate (the agent fixes these; never escalates)
Run as ONE cheap pass (low reasoning effort, NO subagents) before shipping any UI/flow change and
before drafting any taste call. If a flaw here exists, FIX it (reversible UI/code) and note it in
one line — do not ask. These are the "obvious things" that must stop pulling the human in.

**Visual competence** — fails the eye for objective reasons:
- low contrast / unreadable text · misalignment · inconsistent spacing or rhythm
- no clear hierarchy or focal point · cramped / colliding / overflowing elements
- default-unstyled or mismatched components · broken responsive / cut-off content · janky motion

**Flow & intelligence** — dumb by construction:
- more taps/steps/fields than the goal needs · primary action hidden or competing with clutter
- dead ends · no feedback on an action · missing empty / loading / error state
- destructive action with no guard · asks the user to do work the app should do · non-obvious next step

If a fix is genuinely a judgment call (two competent designs, a brand/feel question), it is NOT a
gate item — it graduates to Layer 1.

## Layer 1 — The six taste axes (the owner's eye — human-gated)
Score each 1–5 (5 = strongly satisfies). Their domain: TikTok content + apps + store creatives.

| axis | what it means | high (5) | low (1) |
|---|---|---|---|
| **purity** | clean, one clear idea, no clutter | distilled, confident, nothing extra | busy, derivative, trying too hard |
| **visual demand** | satisfies the eye — composition, contrast, focal point, craft | a human *wants* to look | flat, off, amateur (NEEDS HUMAN EYES) |
| **path length** | steps/taps/seconds to the payoff | instant, frictionless | long, buried, makes you work |
| **hook** | first-moment grab (first second / first screen) | stop-scroll, can't-not-look | slow, generic, no reason to stay |
| **interaction** | invites action, feels alive | pulls you in to do something | inert, watch-only |
| **attention keeping** | holds to the end — pacing, no dead spots | retains, rewards staying | sags, predictable, drops off |

## Weights  (learned by use — NOT seeded upfront)
All start 1.0 = equal. Tuned over time from the owner's actual choices/overrides (Calibration), never by
asking them to seed. Until they diverge, report per-axis honestly and keep confidence modest.

```
purity: 1.0   visual_demand: 1.0   path_length: 1.0
hook: 1.0     interaction: 1.0     attention_keeping: 1.0
```

## The judging panel (distinct lenses — only when a call warrants it)
For a CLOSE or CONSEQUENTIAL subjective call, convene a SMALL panel of DISTINCT lenses — never N
identical voters (that just burns tokens). Each returns a 2-line verdict, run in parallel:
- **Hook** — first-second / first-screen grab.
- **Flow** — friction, step count, obvious path, smart defaults, dead ends.
- **Craft** — hierarchy, spacing, contrast, focal point, polish.
- **Brand / purity** — on-brand, one clear idea, nothing extra.
Most calls need only the single proxy pass. Panel = 2–4 lenses max, short. The lenses overlap the
six axes on purpose — they are how the axes get *judged* when one pass isn't enough.

## Token discipline (wasting tokens harms the nature)
- Cheapest sufficient method first. The gate is one low-effort pass with no agents.
- Spawn judge agents ONLY when cost-of-being-wrong is real or the call is genuinely close.
- Distinct lenses only — each must add a different failure angle; no redundant voters.
- Short verdicts, not essays. Reuse the `impeccable` skill's heuristics for the gate; don't re-derive.

## Hard anti-patterns (auto-flag, regardless of score — feed the gate)
- (CALIBRATE) clutter, fake urgency, generic stock feel, slow first second, more taps than needed.
  Add the things the owner reliably rejects.

## Calibration (learning log — grows from the owner's overrides)
Each: what the proxy picked, what the owner actually chose, the one-line reason. Few-shot for future runs.

<!-- Empty on purpose. Entries start with your first override. -->
