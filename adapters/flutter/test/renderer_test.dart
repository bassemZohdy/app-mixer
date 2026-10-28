import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:app_mixer_flutter/app_mixer_flutter.dart';

Map<String, Object?> message(String kind, Object payload) => {'version':'v0.9.1',kind:payload};
void main() {
  testWidgets('renders updates atomically and ignores messages after cleanup', (tester) async {
    late void Function(Object?) receive;
    var unsubscribed = 0;
    final errors = <Object>[];
    VoidCallback? subscribe(void Function(Object?) callback) {receive = callback; return () {unsubscribed++;};}
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: AppMixerA2UI(subscribe:subscribe, onError:errors.add))));
    receive(message('createSurface', {'surfaceId':'main','catalogId':appMixerCatalog}));
    receive(message('updateComponents', {'surfaceId':'main','components':[
      {'id':'root','component':'Column','children':['title','card']},
      {'id':'title','component':'Text','text':'Hello'},
      {'id':'card','component':'Card','child':'item'},
      {'id':'item','component':'Text','text':'World'}
    ]}));
    await tester.pump();
    expect(find.text('Hello'), findsOneWidget);expect(find.text('World'), findsOneWidget);
    receive(message('updateComponents', {'surfaceId':'main','components':[{'id':'root','component':'Column','children':['root']}]}));
    await tester.pump();expect(errors, hasLength(1));expect(find.text('Hello'), findsOneWidget);
    receive(message('updateComponents', {'surfaceId':'main','components':[{'id':'title','component':'Text','text':'Updated'}]}));
    await tester.pump();expect(find.text('Updated'), findsOneWidget);
    final lateReceive = receive;
    await tester.pumpWidget(const SizedBox.shrink());expect(unsubscribed, 1);
    lateReceive({'version':'bad'});expect(errors, hasLength(1));
  });
  test('rejects unsupported data without mutating the previous surface', () {
    final store=FlutterSurfaceStore();
    store.apply(message('createSurface', {'surfaceId':'main','catalogId':appMixerCatalog}));
    store.apply(message('updateComponents', {'surfaceId':'main','components':[{'id':'root','component':'Text','text':'Safe'}]}));
    expect(() => store.apply(message('updateDataModel', {'surfaceId':'main','path':'/__proto__/x','value':'bad'})), throwsFormatException);
    expect(store.snapshot().single?.text, 'Safe');
  });
  testWidgets('updates bound text after nested model changes', (tester) async {
    late void Function(Object?) receive;
    VoidCallback? subscribe(void Function(Object?) callback) {receive=callback;return null;}
    final errors=<Object>[];
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: AppMixerA2UI(subscribe:subscribe,onError:errors.add))));
    receive(message('createSurface', {'surfaceId':'main','catalogId':appMixerCatalog}));
    receive(message('updateComponents', {'surfaceId':'main','components':[{'id':'root','component':'Text','text':{'path':'/person/name'}}]}));
    receive(message('updateDataModel', {'surfaceId':'main','path':'/person/name','value':'Ada'}));
    await tester.pump();expect(find.text('Ada'), findsOneWidget);
    receive(message('updateDataModel', {'surfaceId':'main','path':'/person/name','value':'Grace'}));
    await tester.pump();expect(find.text('Grace'), findsOneWidget);
    receive(message('updateDataModel', {'surfaceId':'main','path':'/person/name'}));
    await tester.pump();expect(find.text('Grace'), findsNothing);expect(errors, isEmpty);
  });

  test('shared binding fixture matches expected output', () {
    final steps=jsonDecode(File('test/fixtures/bindings.json').readAsStringSync()) as List;
    final store=FlutterSurfaceStore();
    for(final step in steps){store.apply(step['message']);expect(store.snapshot().single?.text, step['text']);}
  });

  testWidgets('field changes update button context and external updates refresh the field', (tester) async {
    late void Function(Object?) receive;
    VoidCallback? subscribe(void Function(Object?) callback) {receive=callback;return null;}
    final errors=<Object>[],actions=<Map<String,dynamic>>[];
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: AppMixerA2UI(subscribe:subscribe,onError:errors.add,onAction:actions.add))));
    receive(message('createSurface', {'surfaceId':'main','catalogId':appMixerCatalog}));
    receive(message('updateDataModel', {'surfaceId':'main','value':{'form':{'name':'Ada','secret':'private'}}}));
    receive(message('updateComponents', {'surfaceId':'main','components':[
      {'id':'root','component':'Column','children':['field','button']},
      {'id':'field','component':'TextField','label':'Name','value':{'path':'/form/name'}},
      {'id':'button','component':'Button','child':'label','action':{'event':{'name':'save','context':{'name':{'path':'/form/name'}}}}},
      {'id':'label','component':'Text','text':'Save'}
    ]}));
    await tester.pump();await tester.enterText(find.byType(TextField),'Grace');await tester.pump();
    await tester.tap(find.byType(TextButton));await tester.pump();
    expect((actions.single['action'] as Map)['context'], {'name':'Grace'});expect(errors,isEmpty);
    receive(message('updateDataModel', {'surfaceId':'main','path':'/form/name','value':'Lin'}));await tester.pump();
    expect(tester.widget<TextField>(find.byType(TextField)).controller?.text,'Lin');
  });
  test('rejects stale field and button events', () {
    final store=FlutterSurfaceStore();store.apply(message('createSurface',{'surfaceId':'main','catalogId':appMixerCatalog}));
    store.apply(message('updateComponents',{'surfaceId':'main','components':[
      {'id':'root','component':'Column','children':['field','button']},
      {'id':'field','component':'TextField','label':'Name','value':{'path':'/name'}},
      {'id':'button','component':'Button','child':'label','action':{'event':{'name':'save'}}},
      {'id':'label','component':'Text','text':'Save'}
    ]}));
    final revision=store.views().single.revision;store.writeField('main','field',revision,'Ada');
    expect((store.action('main','button',revision)['action'] as Map)['name'],'save');
    store.apply(message('updateComponents',{'surfaceId':'main','components':[{'id':'label','component':'Text','text':'Changed'}]}));
    expect(()=>store.writeField('main','field',revision,'stale'),throwsFormatException);
    expect(()=>store.action('main','button',revision),throwsFormatException);
  });

}
