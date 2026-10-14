---
name: showcase
description: Stage and capture explicitly requested visuals from real app UI, simulators, emulators or the Flutter screenshot pipeline.
---

# Showcase

For a requested render or visual deliverable. `visual-work` holds the general facts about renders.
Store or social packaging: the store and social references of the `design` skill.

- Find the app's capture instructions, runner, slots and staging controls first. Flutter: the screenshot test, driver, Makefile.
- Take the direct route to the requested screen. Resolve the real target device, locale and state.
- Keep per-slot state deterministic. Production behavior stays independent of staging.
- An animation that cannot settle: capture the intended moment explicitly.
- Explicit raw-image paths. Preserve prior output. Frame only when asked. Restore simulator settings after.
- Demo data is not public proof.

Flutter preview harness: `scripts/install_flutter_preview.sh`, widget in `assets/`.
Mechanics on demand: `references/capture-and-staging.md`, `references/flutter-rendering.md`.
