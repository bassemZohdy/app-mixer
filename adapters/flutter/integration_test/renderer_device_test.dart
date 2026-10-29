import 'package:app_mixer_flutter/app_mixer_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('renders, edits and sends an action on a mobile device', (tester) async {
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
    await tester.enterText(find.byType(TextField), 'Grace');
    await tester.pumpAndSettle();
    expect(find.byWidgetPredicate((widget) => widget is Text && widget.data == 'Grace'), findsOneWidget);
    await tester.tap(find.byType(TextButton));
    await tester.pumpAndSettle();
    expect((actions.single['action'] as Map)['context'], {'name': 'Grace'});
    expect(errors, isEmpty);
    expect(tester.takeException(), isNull);
  });
}
