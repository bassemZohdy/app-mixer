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
    // Match against the semantics tree as assistive technology sees it, not against widget positions.
    // hasFlag is deprecated after 3.32 in favour of flagsCollection, whose shape is still changing; the pinned SDK supports both.
    // ignore: deprecated_member_use
    bool flag(SemanticsData data, SemanticsFlag value) => data.hasFlag(value);
    final nodes = <SemanticsData>[];
    void visit(SemanticsNode node) {nodes.add(node.getSemanticsData()); node.visitChildren((child) {visit(child); return true;});}
    visit(tester.getSemantics(find.byType(Scaffold)));
    final dump = nodes.map((data) => '[${data.label}|${data.value}|${data.hint}|h${data.headingLevel}|${flag(data, SemanticsFlag.isHeader) ? 'header ' : ''}${flag(data, SemanticsFlag.isButton) ? 'button ' : ''}${flag(data, SemanticsFlag.isTextField) ? 'field ' : ''}${flag(data, SemanticsFlag.isMultiline) ? 'multiline' : ''}]').join(' ');
    final summary = <String>[];
    for (final raw in fixture['semantics'] as List) {
      final expected = raw as Map<String, dynamic>, name = expected['name'] as String, role = expected['role'] as String;
      final matches = nodes.where((data) => switch (role) {
        'heading' => flag(data, SemanticsFlag.isHeader) && data.label == name,
        'button' => flag(data, SemanticsFlag.isButton) && data.label.contains(name),
        'textbox' => flag(data, SemanticsFlag.isTextField) && data.value == expected['value'],
        _ => data.label.contains(name),
      }).toList();
      expect(matches, hasLength(1), reason: '$name $role in $dump');
      final data = matches.single;
      if (role == 'text') {expect(flag(data, SemanticsFlag.isHeader) || flag(data, SemanticsFlag.isButton) || flag(data, SemanticsFlag.isTextField), isFalse, reason: '$name is plain text in $dump');}
      if (role == 'textbox') {expect('${data.label} ${data.hint}', contains(name), reason: '$name field label in $dump');}
      if (expected['level'] != null) expect(data.headingLevel, expected['level'], reason: '$name heading level in $dump');
      if (expected['multiline'] != null) expect(flag(data, SemanticsFlag.isMultiline), expected['multiline'], reason: '$name multiline in $dump');
      if (expected['enabled'] != null) {expect(flag(data, SemanticsFlag.hasEnabledState), isTrue, reason: '$name enabled state'); expect(flag(data, SemanticsFlag.isEnabled), expected['enabled'], reason: '$name enabled');}
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
