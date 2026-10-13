# Flutter rendering ladder

Use the cheapest level that can faithfully answer the current visual question.

## Level 1 — widget-test preview

Use for layout, typography hierarchy, spacing, responsive behavior, deterministic states, and
screenshot-only compositions. It avoids builds and simulators and should be the default inner loop.

Install the reusable harness once from the skill directory:

```bash
scripts/install_flutter_preview.sh <app-root>
```

The installer refuses to overwrite a changed harness unless passed `--force`.

Create and keep `test/showcase_preview_test.dart`; do not rewrite throwaway tests every session.
Make it select a scene using a compile-time value:

```dart
const sceneId = String.fromEnvironment('SHOWCASE_SCENE', defaultValue: 'home');
const variant = String.fromEnvironment('SHOWCASE_VARIANT', defaultValue: 'current');
```

Run only the requested scene:

```bash
flutter test test/showcase_preview_test.dart \
  --dart-define=SHOWCASE_SCENE=home \
  --dart-define=SHOWCASE_VARIANT=current
```

Build the preview with the real app shell so theme, locale, localization delegates, and fonts match:

```dart
final key = await pumpShowcasePreview(
  tester,
  screen: scene.build(),
  device: PreviewDevice.iPhonePro,
  buildApp: (home) => MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: AppTheme.light,
    locale: const Locale('en'),
    localizationsDelegates: AppLocalizations.localizationsDelegates,
    supportedLocales: AppLocalizations.supportedLocales,
    home: home,
  ),
);
await pumpPreviewFrames(tester, frames: scene.frames);
await captureShowcasePreview(tester, key, scene.id);
```

The bundled harness loads fonts declared in `FontManifest.json`. If it reports no text fonts, do not
trust exact typography width; use the simulator before approving typography-sensitive work.

## Shared scene registry

When preview and integration capture use the same state, extract an app-specific registry such as
`test/support/showcase_scenes.dart`. Keep it free of output/capture logic.

A useful scene contains:

```dart
class ShowcaseScene {
  const ShowcaseScene({
    required this.id,
    required this.build,
    this.setUp,
    this.frames = 1,
    this.scrollTarget,
  });

  final String id;
  final Widget Function() build;
  final Future<void> Function()? setUp;
  final int frames;
  final Key? scrollTarget;
}
```

Use the registry only when two consumers exist. For a one-off production screen preview, direct
construction is simpler.

## Level 2 — simulator hot restart

Use when the scene depends on Flame/game loops, shaders, blur fidelity, native fonts, maps, plugins,
platform views, or real-time animation.

Create one reusable dev entrypoint that accepts the same scene id as the registry. Do not duplicate
scene arguments in the entrypoint.

```bash
flutter run -d <device> \
  --dart-define=SCREENSHOT_MODE=true \
  --dart-define=SHOWCASE_SCENE=<scene> \
  -t lib/main_showcase.dart
```

Loop: edit → hot restart (`R` when initialization must rerun) → capture → inspect. Capture quickly
for real-time scenes; final integration timing is authoritative.

## Level 3 — targeted integration proof

After direction is approved, render one slot and locale:

```bash
flutter drive \
  --driver=test_driver/integration_test.dart \
  --target=integration_test/screenshot_test.dart \
  --dart-define=SCREENSHOT_MODE=true \
  --dart-define=SCREENSHOT_LOCALES=en-US \
  --dart-define=SCREENSHOT_ONLY=<slot> \
  -d <device>
```

Add `SCREENSHOT_ONLY` if absent. Prefer one `testWidgets` per slot so one failure does not block the
rest. Pump a deterministic number of frames rather than `pumpAndSettle()` for action scenes.

## Risk-based stress pass

Do this only after visual direction is accepted:

- target device;
- one compact device;
- one change-specific risk: long locale, RTL, dark mode, large text, or tablet.

Do not multiply every axis. Pick the smallest matrix that could disprove the layout.
