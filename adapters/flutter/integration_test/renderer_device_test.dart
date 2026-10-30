import 'package:app_mixer_flutter/app_mixer_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('renders, edits and sends an action on a mobile device', (tester) async {
    final semantics = tester.ensureSemantics();
    addTearDown(semantics.dispose);
    late void Function(Object?) receive;
    VoidCallback? subscribe(void Function(Object?) callback) {
      receive = callback;
      return null;
    }

    final actions = <Map<String, dynamic>>[];
    final errors = <Object>[];
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(body: AppMixerA2UI(subscribe: subscribe, onError: errors.add, onAction: actions.add)),
    ));
    receive({'version': 'v0.9.1', 'createSurface': {'surfaceId': 'main', 'catalogId': appMixerCatalog}});
    receive({'version': 'v0.9.1', 'updateDataModel': {'surfaceId': 'main', 'value': {'name': 'Ada', 'secret': 'private'}}});
    receive({'version': 'v0.9.1', 'updateComponents': {'surfaceId': 'main', 'components': [
      {'id': 'root', 'component': 'Column', 'children': ['display', 'field', 'button']},
      {'id': 'display', 'component': 'Text', 'text': {'path': '/name'}, 'variant': 'h1'},
      {'id': 'field', 'component': 'TextField', 'label': 'Name', 'value': {'path': '/name'}},
      {'id': 'button', 'component': 'Button', 'child': 'label', 'action': {'event': {'name': 'save', 'context': {'name': {'path': '/name'}}}}},
      {'id': 'label', 'component': 'Text', 'text': 'Save'}
    ]}});
    await tester.pumpAndSettle();
    expect(find.byWidgetPredicate((widget) => widget is Text && widget.data == 'Ada'), findsOneWidget);
    final heading = tester.getSemantics(find.text('Ada')).getSemanticsData();
    expect(heading.flagsCollection.isHeader, isTrue);expect(heading.label, 'Ada');
    final field = tester.getSemantics(find.byType(TextField)).getSemanticsData();
    expect(field.flagsCollection.isTextField, isTrue);expect(field.label, 'Name');expect(field.value, 'Ada');
    final enabled = tester.getSemantics(find.byType(TextButton)).getSemanticsData();
    expect(enabled.flagsCollection.isButton, isTrue);expect(enabled.flagsCollection.isEnabled, isTrue);expect(enabled.label, 'Save');
    await tester.enterText(find.byType(TextField), 'Grace');
    await tester.pumpAndSettle();
    expect(find.byWidgetPredicate((widget) => widget is Text && widget.data == 'Grace'), findsOneWidget);
    await tester.tap(find.byType(TextButton));
    await tester.pumpAndSettle();
    expect((actions.single['action'] as Map)['context'], {'name': 'Grace'});
    expect(tester.getSemantics(find.byType(TextField)).getSemanticsData().value, 'Grace');
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: AppMixerA2UI(subscribe: subscribe, onError: errors.add))));
    await tester.pumpAndSettle();
    final disabled = tester.getSemantics(find.byType(TextButton)).getSemanticsData();
    expect(disabled.flagsCollection.isButton, isTrue);expect(disabled.flagsCollection.hasEnabledState, isTrue);expect(disabled.flagsCollection.isEnabled, isFalse);expect(disabled.label, 'Save');
    expect(errors, isEmpty);
    expect(tester.takeException(), isNull);
  });
}
