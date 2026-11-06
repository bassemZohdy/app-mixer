import 'dart:convert';
import 'package:app_mixer_flutter/app_mixer_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';
import 'accessibility_fixture.dart';

/// Renders the shared accessibility reference and checks every expected node against the Flutter semantics tree,
/// and every text variant against its rendered style. Used by the VM test and the Android and iOS device tests.
Future<List<String>> expectAccessibilityParity(WidgetTester tester) async {
  final fixture = jsonDecode(accessibilityFixtureJson) as Map<String, dynamic>;
  final handle = tester.ensureSemantics();
  try {
    late void Function(Object?) receive;
    VoidCallback? subscribe(void Function(Object?) callback) {receive = callback; return null;}
    final errors = <Object>[];
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: SingleChildScrollView(child: AppMixerA2UI(subscribe: subscribe, onError: errors.add, onAction: (_) {})))));
    for (final message in fixture['messages'] as List) {receive(message);}
    await tester.pumpAndSettle();
    final summary = <String>[];
    for (final raw in fixture['semantics'] as List) {
      final expected = raw as Map<String, dynamic>, name = expected['name'] as String, role = expected['role'] as String;
      final finder = switch (role) {
        'textbox' => find.ancestor(of: find.text(name), matching: find.byType(TextField)),
        'button' => find.ancestor(of: find.text(name), matching: find.byType(TextButton)),
        _ => find.text(name),
      };
      expect(finder, findsOneWidget, reason: name);
      final data = tester.getSemantics(finder).getSemanticsData();
      // hasFlag is deprecated after 3.32 in favour of flagsCollection, whose shape is still changing; the pinned SDK supports both.
      // ignore: deprecated_member_use
      bool flag(SemanticsFlag value) => data.hasFlag(value);
      expect(flag(SemanticsFlag.isHeader), role == 'heading', reason: '$name heading');
      expect(flag(SemanticsFlag.isButton), role == 'button', reason: '$name button');
      expect(flag(SemanticsFlag.isTextField), role == 'textbox', reason: '$name text field');
      expect(data.label, contains(name), reason: '$name label');
      if (expected['level'] != null) expect(data.headingLevel, expected['level'], reason: '$name heading level');
      if (expected['value'] != null) expect(data.value, expected['value'], reason: '$name value');
      if (expected['multiline'] != null) expect(flag(SemanticsFlag.isMultiline), expected['multiline'], reason: '$name multiline');
      if (expected['enabled'] != null) {expect(flag(SemanticsFlag.hasEnabledState), isTrue, reason: '$name enabled state'); expect(flag(SemanticsFlag.isEnabled), expected['enabled'], reason: '$name enabled');}
      summary.add('$name: $role${expected['level'] == null ? '' : ' ${data.headingLevel}'}');
    }
    for (final raw in fixture['typography'] as List) {
      final expected = raw as Map<String, dynamic>, text = expected['text'] as String;
      final style = tester.widget<Text>(find.text(text)).style;
      expect(style?.fontSize, closeTo((expected['fontSize'] as num).toDouble(), 0.001), reason: '$text font size');
      expect(style?.fontWeight == FontWeight.bold, expected['bold'], reason: '$text weight');
    }
    expect(errors, isEmpty);
    expect(tester.takeException(), isNull);
    return summary;
  } finally {
    handle.dispose();
  }
}
