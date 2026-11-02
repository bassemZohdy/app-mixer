import 'package:app_mixer_flutter/app_mixer_flutter.dart';
import 'dart:convert';
import 'package:flutter/material.dart';
import '../signed_plan_fixture.dart';
import '../signed_registry_plan_fixture.dart';
import '../parity_scenario.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('literal text limit counts Unicode code points', verifyUnicodeTextLimit);
  test('identifier limit counts Unicode code points', verifyUnicodeIdentifierLimit);
  test('text and action context support root bindings', verifyRootValueBindings);
  test('field paths may contain line breaks', verifyLineBreakFieldPath);
  testWidgets('preserves isolated surfaces through updates and recreation', verifySurfaceParity);
  testWidgets('field labels do not include adjacent text in layouts', verifyAdjacentFieldSemantics);
  testWidgets('narrow row remains usable', verifyNarrowRowParity);
  testWidgets('narrow nested row remains usable', verifyNarrowNestedRowParity);
  testWidgets('card does not add layout margins or decoration', verifyCardLayoutParity);
  testWidgets('exposes the correct heading levels to web semantics', (tester) async {
    final semantics=tester.ensureSemantics();
    try {
      late void Function(Object?) receive;
      VoidCallback? subscribe(void Function(Object?) callback){receive=callback;return null;}
      final errors=<Object>[];
      await tester.pumpWidget(MaterialApp(home:Scaffold(body:AppMixerA2UI(subscribe:subscribe,onError:errors.add))));
      receive({'version':'v0.9.1','createSurface':{'surfaceId':'main','catalogId':appMixerCatalog}});
      receive({'version':'v0.9.1','updateComponents':{'surfaceId':'main','components':[
        {'id':'root','component':'Column','children':['h1','h2','h3','h4','h5','body','caption']},
        for(final variant in ['h1','h2','h3','h4','h5','body','caption'])
          {'id':variant,'component':'Text','text':'Text $variant','variant':variant}
      ]}});
      await tester.pump();
      for(var level=1;level<=5;level++) {
        final data=tester.getSemantics(find.text('Text h$level')).getSemanticsData();
        expect(data.flagsCollection.isHeader,isTrue);expect(data.headingLevel,level);
      }
      for(final variant in ['body','caption']) {
        final data=tester.getSemantics(find.text('Text $variant')).getSemanticsData();
        expect(data.flagsCollection.isHeader,isFalse);expect(data.headingLevel,0);
      }
      expect(errors,isEmpty);expect(tester.takeException(),isNull);
    } finally {semantics.dispose();}
  });
  testWidgets('root row uses its bounded width on the web', (tester) async {
    late void Function(Object?) receive;
    VoidCallback? subscribe(void Function(Object?) callback){receive=callback;return null;}
    final errors=<Object>[];
    await tester.pumpWidget(MaterialApp(home:Scaffold(body:Center(child:SizedBox(width:280,child:AppMixerA2UI(subscribe:subscribe,onError:errors.add))))));
    receive({'version':'v0.9.1','createSurface':{'surfaceId':'main','catalogId':appMixerCatalog}});
    receive({'version':'v0.9.1','updateComponents':{'surfaceId':'main','components':[
      {'id':'root','component':'Row','align':'start','justify':'spaceBetween','children':['left','right']},
      {'id':'left','component':'Text','text':'Left'}, {'id':'right','component':'Text','text':'Right'}
    ]}});
    await tester.pump();final row=tester.getRect(find.ancestor(of:find.text('Left'),matching:find.byType(Row)).first);
    expect(row.width,280);expect(tester.getRect(find.text('Left')).left,closeTo(row.left,0.01));expect(tester.getRect(find.text('Right')).right,closeTo(row.right,0.01));expect(errors,isEmpty);expect(tester.takeException(),isNull);
  });
  test('verifies the signed plan in a browser', () async {
    final component=FlutterExtensionComponent((context,props)=>const Text('Chart'),(value)=>true),installed=[FlutterInstalledExtension(id:'example.chart',version:'1.0.0',scope:'application',components:{'chart':component})];
    final keys={'test-key':base64Url.decode(base64Url.normalize(signedPlanPublicKey)),'registry-test-key':base64Url.decode(base64Url.normalize(signedRegistryPlanPublicKey))};
    await FlutterComponentRegistry.fromSignedPlan(signedPlanFixture,installed,tenantId:'tenant',environment:'production',applicationId:'demo',revision:0,trustedKeys:keys,clock:()=>200);
    final registry=await FlutterComponentRegistry.fromSignedPlan(signedRegistryPlanFixture,installed,tenantId:'tenant',environment:'production',applicationId:'demo',revision:0,trustedKeys:keys,clock:()=>200);
    final store=FlutterSurfaceStore(registry);store.apply({'version':'v0.9.1','createSurface':{'surfaceId':'main','catalogId':appMixerCatalog}});store.apply({'version':'v0.9.1','updateComponents':{'surfaceId':'main','components':[{'id':'root','component':'chart'}]}});expect(store.snapshot().single?.kind,'chart');
    await expectLater(FlutterComponentRegistry.fromSignedPlan({...signedRegistryPlanFixture,'keyId':'other'},installed,tenantId:'tenant',environment:'production',applicationId:'demo',revision:0,trustedKeys:keys,clock:()=>200),throwsFormatException);
  });
  testWidgets('edits a bound field and emits explicit action context', (tester) async {
    final semantics=tester.ensureSemantics();
    try {
    late void Function(Object?) receive;
    VoidCallback? subscribe(void Function(Object?) callback) {receive=callback;return null;}
    final actions=<Map<String,dynamic>>[], errors=<Object>[];
    await tester.pumpWidget(MaterialApp(home:Scaffold(body:AppMixerA2UI(subscribe:subscribe,onError:errors.add,onAction:actions.add))));
    receive({'version':'v0.9.1','createSurface':{'surfaceId':'main','catalogId':appMixerCatalog}});
    receive({'version':'v0.9.1','updateDataModel':{'surfaceId':'main','value':{'name':'Ada','secret':'private'}}});
    receive({'version':'v0.9.1','updateComponents':{'surfaceId':'main','components':[
      {'id':'root','component':'Column','children':['display','field','button']},
      {'id':'display','component':'Text','text':{'path':'/name'},'variant':'h1'},
      {'id':'field','component':'TextField','label':'Name','value':{'path':'/name'}},
      {'id':'button','component':'Button','child':'label','action':{'event':{'name':'save','context':{'name':{'path':'/name'}}}}},
      {'id':'label','component':'Text','text':'Save'}
    ]}});
    await tester.pump();expect(find.byWidgetPredicate((w)=>w is Text && w.data=='Ada'),findsOneWidget);
    final heading=tester.getSemantics(find.byWidgetPredicate((widget) => widget is Text && widget.data == 'Ada')).getSemanticsData();expect(heading.flagsCollection.isHeader,isTrue);expect(heading.label,'Ada');
    final field=tester.getSemantics(find.byType(EditableText)).getSemanticsData();expect(field.flagsCollection.isTextField,isTrue);expect(field.label,'Name');expect(field.value,'Ada');
    final button=tester.getSemantics(find.byType(TextButton)).getSemanticsData();expect(button.flagsCollection.isButton,isTrue);expect(button.flagsCollection.toStrings(),containsAll(['hasEnabledState','isEnabled']));expect(button.label,'Save');
    await tester.enterText(find.byType(TextField),'Grace');await tester.pump();expect(find.byWidgetPredicate((w)=>w is Text && w.data=='Grace'),findsOneWidget);
    await tester.tap(find.byType(TextButton));await tester.pump();
    expect((actions.single['action'] as Map)['context'],{'name':'Grace'});expect(errors,isEmpty);
    receive({'version':'v0.9.1','updateComponents':{'surfaceId':'main','components':[{'id':'label','component':'Text','text':'Save','variant':'h2'}]}});
    await tester.pump();final styled=tester.widget<Semantics>(find.ancestor(of:find.text('Save'),matching:find.byType(Semantics)).first);
    expect(styled.properties.header,isFalse);expect(styled.properties.headingLevel,isNull);
    final styledButton=tester.getSemantics(find.byType(TextButton)).getSemanticsData();expect(styledButton.flagsCollection.isButton,isTrue);expect(styledButton.flagsCollection.isHeader,isFalse);expect(styledButton.label,'Save');
    } finally {semantics.dispose();}
  });
}
