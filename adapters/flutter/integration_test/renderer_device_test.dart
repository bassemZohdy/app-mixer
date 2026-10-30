import 'dart:convert';
import 'package:app_mixer_flutter/app_mixer_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import '../test/signed_plan_fixture.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('verifies a signed extension plan and renders its approved widget on a mobile device', (tester) async {
    final component=FlutterExtensionComponent((context,props)=>const Text('Signed chart'),(value)=>true);
    final installed=[FlutterInstalledExtension(id:'example.chart',version:'1.0.0',scope:'application',components:{'chart':component,'extra':component})];
    final keys={'test-key':base64Url.decode(base64Url.normalize(signedPlanPublicKey))};
    Future<FlutterComponentRegistry> verify(Object? value,{String tenant='tenant',int now=200}) => FlutterComponentRegistry.fromSignedPlan(value,installed,tenantId:tenant,environment:'production',applicationId:'demo',revision:0,trustedKeys:keys,clock:()=>now);
    final registry=await tester.runAsync(() async {
      final valid=await verify(signedPlanFixture);
      final signature=signedPlanFixture['signature'] as String;
      final bad=(signature.startsWith('A')?'B':'A')+signature.substring(1);
      await expectLater(verify({...signedPlanFixture,'signature':bad}),throwsFormatException);
      await expectLater(verify(signedPlanFixture,tenant:'other'),throwsFormatException);
      await expectLater(verify(signedPlanFixture,now:10000),throwsFormatException);
      return valid;
    });
    expect(registry,isNotNull);
    late void Function(Object?) receive;
    VoidCallback? subscribe(void Function(Object?) callback){receive=callback;return null;}
    final errors=<Object>[];
    await tester.pumpWidget(MaterialApp(home:Scaffold(body:AppMixerA2UI(subscribe:subscribe,onError:errors.add,extensions:registry))));
    receive({'version':'v0.9.1','createSurface':{'surfaceId':'main','catalogId':appMixerCatalog}});
    receive({'version':'v0.9.1','updateComponents':{'surfaceId':'main','components':[{'id':'root','component':'chart'}]}});
    await tester.pumpAndSettle();
    expect(find.text('Signed chart'),findsOneWidget);
    receive({'version':'v0.9.1','updateComponents':{'surfaceId':'main','components':[{'id':'root','component':'extra'}]}});
    await tester.pumpAndSettle();
    expect(errors,hasLength(1));expect(find.text('Signed chart'),findsOneWidget);
  });

  testWidgets('renders, edits and sends an action on a mobile device', (tester) async {
    final semantics = tester.ensureSemantics();
    // enterText injects editing updates; do not let a real IME race those updates.
    tester.testTextInput.register();
    try {
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
    final heading = tester.getSemantics(find.byWidgetPredicate((widget) => widget is Text && widget.data == 'Ada')).getSemanticsData();
    expect(heading.flagsCollection.isHeader, isTrue);expect(heading.label, 'Ada');
    final field = tester.getSemantics(find.byType(EditableText)).getSemanticsData();
    expect(field.flagsCollection.isTextField, isTrue);expect(field.label, 'Name');expect(field.value, 'Ada');
    final enabled = tester.getSemantics(find.byType(TextButton)).getSemanticsData();
    expect(enabled.flagsCollection.isButton, isTrue);expect(enabled.flagsCollection.isEnabled, isTrue);expect(enabled.label, 'Save');
    await tester.enterText(find.byType(TextField), 'Grace');
    await tester.pumpAndSettle();
    expect(find.byWidgetPredicate((widget) => widget is Text && widget.data == 'Grace'), findsOneWidget);
    expect(tester.widget<EditableText>(find.byType(EditableText)).controller.text, 'Grace');
    expect(tester.getSemantics(find.byType(EditableText)).getSemanticsData().value, 'Grace', reason: 'Edited value must be available to assistive technology before submit');
    await tester.tap(find.byType(TextButton));
    await tester.pumpAndSettle();
    expect((actions.single['action'] as Map)['context'], {'name': 'Grace'});
    expect(tester.widget<EditableText>(find.byType(EditableText)).controller.text, 'Grace', reason: 'Submitted field must retain the edited value');
    expect(tester.getSemantics(find.byType(EditableText)).getSemanticsData().value, 'Grace', reason: 'Edited value must remain accessible after submit');
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: AppMixerA2UI(subscribe: subscribe, onError: errors.add))));
    await tester.pumpAndSettle();
    final disabled = tester.getSemantics(find.byType(TextButton)).getSemanticsData();
    expect(disabled.flagsCollection.isButton, isTrue);expect(disabled.flagsCollection.hasEnabledState, isTrue);expect(disabled.flagsCollection.isEnabled, isFalse);expect(disabled.label, 'Save');
    expect(errors, isEmpty);
    expect(tester.takeException(), isNull);
    } finally {tester.testTextInput.unregister();semantics.dispose();}
  });
}
