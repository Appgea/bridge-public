---
name: showcase
description: Rapidly stage, render, inspect, and iteratively refine UI screens, screen flows, and visual artifacts with the human directing subjective changes. Invoke automatically—even when not named—when the user asks to work on, improve, inspect, or verify a visible screen/flow; for visual development, render-to-see previews, store screenshots, marketing/social creatives, staged app scenes, screenshot slots, and clean raw captures. Select the cheapest faithful renderer, automate objective quality fixes, and checkpoint with the current image plus 2–3 concrete suggested changes. The human owns art direction and final approval.
---

# Showcase

Treat UI rendering as a fast collaborative workbench. The human owns art direction;
the agent owns rendering mechanics, objective competence, and concise suggestions.

## Collaboration contract

- If the request names a concrete change, implement it without reconfirming.
- If the request is broad (`improve this`, `make it better`, `work on the visuals`), render or
  inspect the current state first. Before subjective edits, ask one focused question and include
  2–3 specific suggestions based on the image. Mark one recommendation and explain it briefly.
- After each requested change, run a bounded internal loop of at most three renders. Fix only
  objective failures: overflow, clipping, unreadable contrast, broken hierarchy, inconsistent
  spacing, accidental clutter, missing state, or failure to match the explicit request.
- Do not autonomously change style, brand, mood, composition, or product behavior. Offer those as
  suggestions at the checkpoint.
- Keep checkpoints meaningful. Do not ask between mechanical fixes or reopen the same artifact.

Use this checkpoint shape:

```text
CHANGED: <what is visibly different>
CURRENT: <opened image/path>

SUGGESTED NEXT:
1. <recommended concrete change> — <expected benefit>
2. <alternative> — <tradeoff>
3. <optional alternative> — <tradeoff>

What would you like changed next?
```

Omit weak suggestions. One good recommendation is better than three filler items.

## Start from evidence

1. Read the existing screen, screenshot test, scene hooks, theme, and design-system components.
2. Render a baseline before changing visuals when it costs under ten seconds. Otherwise inspect the
   latest trustworthy screenshot and render immediately after the first requested change.
3. Keep `previous.png`, `current.png`, and `thumb.png` under `/tmp/showcase/<app>/<scene>/` so the
   comparison is visible without polluting the repository.
4. Run the `taste` competence gate before each human checkpoint. Escalate only subjective choices.

## Business-logic review integration

- Use showcase when the review question depends on the real visible screen, navigation, interaction,
  animation, responsive layout, or visual state. Render the current state or the smallest meaningful
  variants; do not debate a visible choice only in prose.
- Keep the plain-language semantic envelope alongside the image. A render demonstrates experience;
  it does not authorize a new product rule or conceal an unresolved consequential ambiguity.
- If the human edited a linked review `.txt`/`.md`, reread and evaluate that file before rerendering.
  Render only the states affected by the edited rules, reusing the same scene/session.
- Do not invoke showcase for backend/state logic when an editable text or compact scheme is clearer.

## Choose the cheapest faithful renderer

| Need | Renderer | Typical use |
|---|---|---|
| Static Flutter layout/composition | widget-test preview | spacing, hierarchy, responsive layout, A/B variants |
| Animation, shader, plugin, map, platform view | simulator + hot restart | motion timing and device fidelity |
| Existing non-Flutter screen | OS/browser capture | native, React Native, web, desktop |
| Approved store slot | targeted integration screenshot | exact scene, locale, frame timing |
| Approved complete set | batch pipeline | all devices/locales, framing, packaging |

Start at the first sufficient row. Escalate fidelity only when the cheaper renderer cannot prove the
change. Never run a full locale/device batch during visual iteration.

For Flutter preview setup and commands, read [references/flutter-rendering.md](references/flutter-rendering.md).
For native iOS (SwiftUI), read `common/IOS_SCREENSHOTS_GUIDE.md`. Native apps render in process via
ScreenshotKit — one app launch covers every scene and locale. Never reach for XCUITest first.
For raw capture and final artifact rules, read [references/capture-and-staging.md](references/capture-and-staging.md).

## Keep one scene definition

Do not duplicate screen arguments, fake data, frame counts, or seed logic across preview and final
capture entrypoints. Extract a small app-owned scene registry when a scene is used more than once.
Each scene should define only what it needs: `id`, widget builder, deterministic seed/setup, pump
duration/frame count, and optional scroll target.

Consume the same scene from:

- a committed `test/showcase_preview_test.dart` for the fast loop;
- `integration_test/screenshot_test.dart` for the authoritative capture.

Prefer parameterized scene hooks such as `scene`, `density`, `palette`, and `seed` over one-off hacks.
Gate production-side staging behind `SCREENSHOT_MODE` or test-only constructor arguments.

## Iterate efficiently

- One target device, locale, and state until direction is approved; the preview harness for all
  layout work, hot restart only for effects it can't render, `flutter drive` once for final proof.
- Close subjective call? Render two named variants in one run and show them together — don't debate
  what you can show.
- Inspect full size plus a 300 px thumbnail (store users see the thumbnail first).
- After direction is approved, stress one risk case drawn from the actual change (long locale, dark
  mode, large text, compact device) — never a full locale/device batch during iteration.

## Honesty boundaries

- The app render is always real — reuse real widgets and real data/state; never fake a capability.
  Marketing/social may add taglines, framing, and mockups *around* that truthful render.
- Change production UI only when requested; test-only compositions stay out of production
  navigation, and production visuals/behavior stay identical when screenshot mode is off.

## Completion

Before handoff, verify the explicit request, objective competence, target-device rendering, and any
changed Dart with `flutter analyze`. Full locale runs, framing, upload, commit, and publishing require
an explicit request. Always finish a visual checkpoint by showing the result and asking what the
human wants changed next, with focused suggestions alongside the question.
