# Capture and staging

## Stage the real screen first

Prefer production screens with deterministic data and test arguments. Seed plausible hero content,
select the strongest real state, suppress ads/dialogs/audio under `SCREENSHOT_MODE`, and control the
frame count. Reset mutable state before every scene.

If a production screen cannot reach the required composition, build a test-only showcase widget
from the app's real cards, painters, typography, and theme. Keep it under `integration_test/`,
`test/`, or a dedicated entrypoint that production navigation cannot reach.

Never hand-draw fake app UI for a store screenshot. Marketing decoration around a truthful app
render is allowed.

## Useful staging dials

- Deterministic seed and hero data.
- Named scene plus density/count controls.
- Pump frame count for peak action.
- Existing palette, theme, weather, or level selection.
- Scroll target for below-fold content.
- Locale-aware strings for any text inside the app render.

Production hooks inject state/configuration, not new draw behavior. Gate them behind
`SCREENSHOT_MODE` or test-only arguments.

## Raw capture

Use when the existing app screen is already sufficient or the stack is not Flutter.

Before capture: seed content, navigate directly, set locale/appearance, dismiss popups, enable DND,
and clean the status bar. Capture at the target device's native resolution; do not upscale.

```bash
# iOS simulator
xcrun simctl io booted screenshot /tmp/showcase/current.png

# Android emulator
adb exec-out screencap -p > /tmp/showcase/current.png

# Web
chrome --headless --screenshot=/tmp/showcase/current.png \
  --window-size=<width>,<height> <url>
```

For final store output, verify current platform screenshot specifications before selecting devices.

## Review artifacts

Keep temporary review files outside the repo:

```text
/tmp/showcase/<app>/<scene>/
├── previous.png
├── current.png
├── thumb.png
└── variants/        # only when A/B is useful
```

Create the thumbnail with:

```bash
sips -Z 300 current.png --out thumb.png
```

Inspect full size and thumbnail. Check focal point, clipping, half-loaded content, debug/ad/dialog
chrome, credible data, and whether the explicit change is visible. Open only the meaningful
checkpoint for the human: one image for one scene, a folder/contact sheet for a set.

## Final batch

Run all locales/devices, framing, copying, and packaging only after the target scene is approved.
Store upload, publishing, or paid placement remains human-gated.
