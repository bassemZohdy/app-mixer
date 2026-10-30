import 'package:app_mixer_flutter/app_mixer_flutter.dart';
import 'dart:convert';
import 'package:flutter/material.dart';
import '../signed_plan_fixture.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('verifies the signed plan in a browser', () async {
    final component=FlutterExtensionComponent((context,props)=>const Text('Chart'),(value)=>true),installed=[FlutterInstalledExtension(id:'example.chart',version:'1.0.0',scope:'application',components:{'chart':component})];
    final registry=await FlutterComponentRegistry.fromSignedPlan(signedPlanFixture,installed,tenantId:'tenant',environment:'production',applicationId:'demo',revision:0,trustedKeys:{'test-key':base64Url.decode(base64Url.normalize(signedPlanPublicKey))},clock:()=>200);
    final store=FlutterSurfaceStore(registry);store.apply({'version':'v0.9.1','createSurface':{'surfaceId':'main','catalogId':appMixerCatalog}});store.apply({'version':'v0.9.1','updateComponents':{'surfaceId':'main','components':[{'id':'root','component':'chart'}]}});expect(store.snapshot().single?.kind,'chart');
    await expectLater(FlutterComponentRegistry.fromSignedPlan({...signedPlanFixture,'keyId':'other'},installed,tenantId:'tenant',environment:'production',applicationId:'demo',revision:0,trustedKeys:{'test-key':base64Url.decode(base64Url.normalize(signedPlanPublicKey))},clock:()=>200),throwsFormatException);
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
    final button=tester.getSemantics(find.byType(TextButton)).getSemanticsData();expect(button.flagsCollection.isButton,isTrue);expect(button.flagsCollection.isEnabled,isTrue);expect(button.label,'Save');
    await tester.enterText(find.byType(TextField),'Grace');await tester.pump();expect(find.byWidgetPredicate((w)=>w is Text && w.data=='Grace'),findsOneWidget);
    await tester.tap(find.byType(TextButton));await tester.pump();
    expect((actions.single['action'] as Map)['context'],{'name':'Grace'});expect(errors,isEmpty);
    } finally {semantics.dispose();}
  });
}
