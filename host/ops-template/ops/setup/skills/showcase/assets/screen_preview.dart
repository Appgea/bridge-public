// Reusable Flutter widget-test renderer for fast visual iteration.
// Install as test/support/showcase_preview.dart.

import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart' show FontLoader, rootBundle;
import 'package:flutter_test/flutter_test.dart';

class PreviewDevice {
  final String name;
  final Size logicalSize;
  final double devicePixelRatio;
  final EdgeInsets padding;

  const PreviewDevice(
    this.name,
    this.logicalSize,
    this.devicePixelRatio,
    this.padding,
  );

  static const iPhonePro = PreviewDevice(
    'iPhone Pro',
    Size(402, 874),
    3,
    EdgeInsets.only(top: 59, bottom: 34),
  );

  static const iPhoneCompact = PreviewDevice(
    'iPhone compact',
    Size(375, 667),
    2,
    EdgeInsets.zero,
  );

  static const androidPhone = PreviewDevice(
    'Android phone',
    Size(412, 915),
    2.625,
    EdgeInsets.only(top: 28, bottom: 24),
  );

  static const tablet = PreviewDevice(
    '11-inch tablet',
    Size(834, 1194),
    2,
    EdgeInsets.only(top: 24, bottom: 20),
  );
}

typedef PreviewAppBuilder = Widget Function(Widget home);

// Intentionally per-process: one test binary renders one app, so caching the
// family count is safe. If a suite ever loads multiple apps, reset this first.
int? _loadedTextFamilies;

/// Loads fonts declared by the app. Returns the number of non-icon families.
Future<int> loadShowcaseFonts() async {
  final cachedCount = _loadedTextFamilies;
  if (cachedCount != null) return cachedCount;

  var textFamilies = 0;
  try {
    final raw = await rootBundle.loadString('FontManifest.json');
    final manifest = jsonDecode(raw) as List<dynamic>;
    for (final entry in manifest.cast<Map<String, dynamic>>()) {
      final family = entry['family'] as String;
      final fonts = (entry['fonts'] as List<dynamic>)
          .cast<Map<String, dynamic>>();
      final loader = FontLoader(family);
      for (final font in fonts) {
        loader.addFont(rootBundle.load(font['asset'] as String));
      }
      await loader.load();
      if (family != 'MaterialIcons' && family != 'CupertinoIcons') {
        textFamilies++;
      }
    }
  } catch (error) {
    debugPrint('SHOWCASE FONT WARNING: $error');
  }

  _loadedTextFamilies = textFamilies;
  if (textFamilies == 0) {
    debugPrint(
      'SHOWCASE FONT WARNING: no app text font was loaded; '
      'verify typography on a simulator.',
    );
  }
  return textFamilies;
}

/// Pumps [screen] at an exact viewport while preserving the app's real shell.
Future<GlobalKey> pumpShowcasePreview(
  WidgetTester tester, {
  required Widget screen,
  required PreviewAppBuilder buildApp,
  PreviewDevice device = PreviewDevice.iPhonePro,
  double textScale = 1,
  Brightness brightness = Brightness.light,
}) async {
  await loadShowcaseFonts();

  tester.view.devicePixelRatio = device.devicePixelRatio;
  tester.view.physicalSize = device.logicalSize * device.devicePixelRatio;
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);

  final boundaryKey = GlobalKey();
  final boundary = RepaintBoundary(key: boundaryKey, child: screen);

  await tester.pumpWidget(
    buildApp(
      Builder(
        builder: (context) {
          final media = MediaQuery.of(context).copyWith(
            size: device.logicalSize,
            devicePixelRatio: device.devicePixelRatio,
            padding: device.padding,
            viewPadding: device.padding,
            platformBrightness: brightness,
            textScaler: TextScaler.linear(textScale),
          );
          return MediaQuery(data: media, child: boundary);
        },
      ),
    ),
  );
  return boundaryKey;
}

Future<void> pumpPreviewFrames(
  WidgetTester tester, {
  int frames = 1,
  Duration step = const Duration(milliseconds: 16),
}) async {
  for (var i = 0; i < frames; i++) {
    await tester.pump(step);
  }
}

Future<String> captureShowcasePreview(
  WidgetTester tester,
  GlobalKey boundaryKey,
  String name, {
  String outputDirectory = '/tmp/showcase',
}) async {
  late String path;
  await tester.runAsync(() async {
    final boundary =
        boundaryKey.currentContext!.findRenderObject() as RenderRepaintBoundary;
    final image = await boundary.toImage(
      pixelRatio: tester.view.devicePixelRatio,
    );
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    final directory = Directory(outputDirectory)..createSync(recursive: true);
    final file = File('${directory.path}/$name.png');
    await file.writeAsBytes(bytes!.buffer.asUint8List(), flush: true);
    path = file.path;
    debugPrint('WROTE $path');
  });
  return path;
}
