import 'dart:ui' show SemanticsFlag;
import 'package:app_mixer_flutter/app_mixer_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('edits a bound field and emits explicit action context', (tester) async {
    final semantics=tester.ensureSemantics();addTearDown(semantics.dispose);
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
    final heading=tester.getSemantics(find.text('Ada')).getSemanticsData();expect(heading.hasFlag(SemanticsFlag.isHeader),isTrue);expect(heading.label,'Ada');
    final field=tester.getSemantics(find.byType(TextField)).getSemanticsData();expect(field.hasFlag(SemanticsFlag.isTextField),isTrue);expect(field.label,'Name');expect(field.value,'Ada');
    final button=tester.getSemantics(find.byType(TextButton)).getSemanticsData();expect(button.hasFlag(SemanticsFlag.isButton),isTrue);expect(button.hasFlag(SemanticsFlag.isEnabled),isTrue);expect(button.label,'Save');
    await tester.enterText(find.byType(TextField),'Grace');await tester.pump();expect(find.byWidgetPredicate((w)=>w is Text && w.data=='Grace'),findsOneWidget);
    await tester.tap(find.byType(TextButton));await tester.pump();
    expect((actions.single['action'] as Map)['context'],{'name':'Grace'});expect(errors,isEmpty);
  });
}
