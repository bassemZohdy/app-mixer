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
    expect(() => store.apply(message('updateDataModel', {'surfaceId':'main','value':{}})), throwsFormatException);
    expect(store.snapshot().single?.text, 'Safe');
  });
}
