import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:app_mixer_flutter/app_mixer_flutter.dart';

Map<String, Object?> message(String kind, Object payload) => {'version':'v0.9.1',kind:payload};
void main() {
  testWidgets('renders isolated trusted extensions and preserves the surface on invalid updates', (tester) async {
    final registry=FlutterComponentRegistry();
    registry.register('chart', (context, props) => Text((props['options'] as Map)['label'] as String),
      (component) => component['options'] is Map && (component['options'] as Map)['label'] is String);
    expect(() => registry.register('chart', (context, props) => const SizedBox(), (component) => true), throwsArgumentError);
    expect(() => registry.register('Text', (context, props) => const SizedBox(), (component) => true), throwsArgumentError);
    late void Function(Object?) receive;
    VoidCallback? subscribe(void Function(Object?) callback) {receive=callback;return null;}
    final errors=<Object>[];
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: AppMixerA2UI(subscribe:subscribe,onError:errors.add,extensions:registry))));
    receive(message('createSurface', {'surfaceId':'main','catalogId':appMixerCatalog}));
    final options={'label':'Chart'};
    receive(message('updateComponents', {'surfaceId':'main','components':[{'id':'root','component':'chart','options':options,'text':{'unexpected':'value'}}]}));
    options['label']='Changed outside';
    await tester.pump();expect(find.text('Chart'),findsOneWidget);
    receive(message('updateComponents', {'surfaceId':'main','components':[{'id':'root','component':'chart','options':{'label':42}}]}));
    await tester.pump();expect(errors,hasLength(1));expect(find.text('Chart'),findsOneWidget);
    receive(message('updateComponents', {'surfaceId':'main','components':[{'id':'root','component':'chart','children':[],'options':{'label':'No'}}]}));
    await tester.pump();expect(errors,hasLength(2));expect(find.text('Chart'),findsOneWidget);
  });
  testWidgets('replaces the subscription when the host replaces its registry', (tester) async {
    final first=FlutterComponentRegistry(), second=FlutterComponentRegistry();
    first.register('chart', (context, props) => const Text('First'), (component) => true);
    second.register('chart', (context, props) => const Text('Second'), (component) => true);
    var stops=0;
    final receivers=<void Function(Object?)>[];
    VoidCallback? subscribe(void Function(Object?) callback) {
      receivers.add(callback);
      callback(message('createSurface', {'surfaceId':'main','catalogId':appMixerCatalog}));
      callback(message('updateComponents', {'surfaceId':'main','components':[{'id':'root','component':'chart'}]}));
      return () {stops++;};
    }
    final errors=<Object>[];
    Widget screen(FlutterComponentRegistry registry) => MaterialApp(home: Scaffold(body: AppMixerA2UI(subscribe:subscribe,onError:errors.add,extensions:registry)));
    await tester.pumpWidget(screen(first));await tester.pump();expect(find.text('First'),findsOneWidget);
    await tester.pumpWidget(screen(second));await tester.pump();expect(stops,1);expect(find.text('Second'),findsOneWidget);
    receivers.first({'version':'invalid'});expect(errors,isEmpty);
  });
  test('extension registries are captured and validators cannot mutate stored values', () {
    final registry=FlutterComponentRegistry();
    registry.register('chart', (context, props) => const SizedBox(), (component) {
      (component['options'] as Map)['label']='validator mutation';return true;
    });
    final store=FlutterSurfaceStore(registry);
    registry.register('later', (context, props) => const SizedBox(), (component) => true);
    store.apply(message('createSurface', {'surfaceId':'main','catalogId':appMixerCatalog}));
    store.apply(message('updateComponents', {'surfaceId':'main','components':[{'id':'root','component':'chart','options':{'label':'original'}}]}));
    final props=store.snapshot().single!.extensionProps!;
    expect((props['options'] as Map)['label'],'original');
    (props['options'] as Map)['label']='caller mutation';
    expect((store.snapshot().single!.extensionProps!['options'] as Map)['label'],'original');
    expect(() => store.apply(message('updateComponents', {'surfaceId':'main','components':[{'id':'root','component':'later'}]})),throwsFormatException);
    expect((store.snapshot().single!.extensionProps!['options'] as Map)['label'],'original');
  });
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

  test('shared action fixture resolves explicit context', () {
    final fixture=jsonDecode(File('test/fixtures/actions.json').readAsStringSync()) as Map;
    final store=FlutterSurfaceStore();
    for(final message in fixture['messages'] as List){store.apply(message);}
    final action=Map<String,dynamic>.from(store.action('main','root',store.views().single.revision)['action'] as Map)..remove('timestamp');
    expect(action,fixture['action']);
  });

  test('shared layout fixture matches expected component hierarchy', () {
    const styles={'start':'flex-start','center':'center','end':'flex-end','stretch':'stretch','spaceBetween':'space-between','spaceAround':'space-around','spaceEvenly':'space-evenly'};
    Map<String,dynamic> tree(NativeNode node) => {
      'kind':node.kind,
      if(node.kind=='Text') 'text':node.text,
      if(node.kind=='Row'||node.kind=='Column') ...{'justify':styles[node.justify],'align':styles[node.align]},
      'children':node.children.map(tree).toList()
    };
    final steps=jsonDecode(File('test/fixtures/layout.json').readAsStringSync()) as List;
    final store=FlutterSurfaceStore();
    for(final step in steps){store.apply(step['message']);final root=store.snapshot().single;expect(root==null?null:tree(root),step['tree']);}
  });

  test('bounds and isolates data model updates', () {
    final store=FlutterSurfaceStore();
    store.apply(message('createSurface', {'surfaceId':'main','catalogId':appMixerCatalog}));
    store.apply(message('updateComponents', {'surfaceId':'main','components':[{'id':'root','component':'Text','text':{'path':'/name'}}]}));
    store.apply(message('updateDataModel', {'surfaceId':'main','value':{'name':'Safe'}}));
    expect(() => store.apply(message('updateDataModel', {'surfaceId':'main','path':'/extra','value':List.filled(10001, 1)})), throwsFormatException);
    expect(() => store.apply(message('updateDataModel', {'surfaceId':'main','path':'/extra','value':{'__proto__':{'x':1}}})), throwsFormatException);
    final cyclic=<dynamic>[];cyclic.add(cyclic);
    expect(() => store.apply(message('updateDataModel', {'surfaceId':'main','path':'/extra','value':cyclic})), throwsFormatException);
    expect(store.snapshot().single?.text,'Safe');
  });

  test('array bindings expose only canonical element indices', () {
    final store=FlutterSurfaceStore();store.apply(message('createSurface',{'surfaceId':'main','catalogId':appMixerCatalog}));
    store.apply(message('updateDataModel',{'surfaceId':'main','value':{'items':['first','second']}}));
    for(final path in ['/items/length','/items/01','/items/-1','/items/2','/items/1']) {
      store.apply(message('updateComponents',{'surfaceId':'main','components':[
        {'id':'root','component':'Button','child':'label','action':{'event':{'name':'save','context':{'value':{'path':path}}}}},
        {'id':'label','component':'Text','text':{'path':path}}
      ]}));
      final revision=store.views().single.revision;
      expect(store.snapshot().single?.children.single.text,path=='/items/1'?'second':'');
      if(path=='/items/1') {
        expect(((store.action('main','root',revision)['action'] as Map)['context'] as Map)['value'],'second');
      } else {
        expect(()=>store.action('main','root',revision),throwsFormatException);
      }
    }
  });

  test('deleted array elements differ from null in action context', () {
    final store=FlutterSurfaceStore();store.apply(message('createSurface',{'surfaceId':'main','catalogId':appMixerCatalog}));
    store.apply(message('updateDataModel',{'surfaceId':'main','value':{'items':[null,'gone']}}));
    store.apply(message('updateComponents',{'surfaceId':'main','components':[
      {'id':'root','component':'Button','child':'label','action':{'event':{'name':'save','context':{'value':{'path':'/items/0'}}}}},
      {'id':'label','component':'Text','text':'Save'}
    ]}));
    expect(((store.action('main','root',store.views().single.revision)['action'] as Map)['context'] as Map)['value'], isNull);
    store.apply(message('updateDataModel',{'surfaceId':'main','path':'/items/1'}));
    store.apply(message('updateDataModel',{'surfaceId':'main','path':'/other','value':'updated'}));
    store.apply(message('updateComponents',{'surfaceId':'main','components':[
      {'id':'root','component':'Button','child':'label','action':{'event':{'name':'save','context':{'value':{'path':'/items/1'}}}}}
    ]}));
    expect(()=>store.action('main','root',store.views().single.revision),throwsFormatException);
    store.apply(message('updateComponents',{'surfaceId':'main','components':[
      {'id':'root','component':'Button','child':'label','action':{'event':{'name':'save','context':{'value':{'path':'/items'}}}}}
    ]}));
    final event=store.action('main','root',store.views().single.revision);
    expect(((event['action'] as Map)['context'] as Map)['value'],[null,null]);
    expect(()=>jsonEncode(event),returnsNormally);
  });

  test('rejects explicit null for optional paths and component properties atomically', () {
    final store=FlutterSurfaceStore();store.apply(message('createSurface',{'surfaceId':'main','catalogId':appMixerCatalog}));
    store.apply(message('updateComponents',{'surfaceId':'main','components':[{'id':'root','component':'Text','text':'Safe'}]}));
    expect(()=>store.apply(message('updateDataModel',{'surfaceId':'main','path':null,'value':{'x':'bad'}})),throwsFormatException);
    for(final c in [
      {'id':'root','component':'Text','text':'bad','variant':null},
      {'id':'root','component':'Column','children':[],'align':null},
      {'id':'root','component':'Row','children':[],'justify':null},
      {'id':'root','component':'TextField','label':'Name','value':{'path':'/x'},'variant':null},
      {'id':'root','component':'Button','child':'x','action':{'event':{'name':'save'}},'variant':null}
    ]){expect(()=>store.apply(message('updateComponents',{'surfaceId':'main','components':[c]})),throwsFormatException);}
    expect(store.snapshot().single?.text,'Safe');
  });

  testWidgets('replacing a source clears the surface and ignores its late messages', (tester) async {
    late void Function(Object?) first,second;
    var firstStops=0,secondStops=0;
    final errors=<Object>[];
    VoidCallback? firstSource(void Function(Object?) receive) {first=receive;return (){firstStops++;throw StateError('cleanup failed');};}
    VoidCallback? secondSource(void Function(Object?) receive) {second=receive;return (){secondStops++;};}
    Widget app(A2UISubscribe source)=>MaterialApp(home:Scaffold(body:AppMixerA2UI(subscribe:source,onError:errors.add)));
    await tester.pumpWidget(app(firstSource));
    first(message('createSurface',{'surfaceId':'old','catalogId':appMixerCatalog}));
    first(message('updateComponents',{'surfaceId':'old','components':[{'id':'root','component':'Text','text':'Old'}]}));
    await tester.pump();expect(find.text('Old'),findsOneWidget);
    await tester.pumpWidget(app(secondSource));expect(firstStops,1);expect(find.text('Old'),findsNothing);
    first({'version':'invalid'});expect(errors,hasLength(1));expect(errors.single,isA<StateError>());
    second(message('createSurface',{'surfaceId':'new','catalogId':appMixerCatalog}));
    second(message('updateComponents',{'surfaceId':'new','components':[{'id':'root','component':'Text','text':'New'}]}));
    await tester.pump();expect(find.text('New'),findsOneWidget);
    await tester.pumpWidget(const SizedBox.shrink());expect(secondStops,1);second({'version':'invalid'});expect(errors,hasLength(1));
  });
  testWidgets('disables buttons without an action handler', (tester) async {
    late void Function(Object?) receive;
    VoidCallback? subscribe(void Function(Object?) callback) {receive=callback;return null;}
    await tester.pumpWidget(MaterialApp(home:Scaffold(body:AppMixerA2UI(subscribe:subscribe,onError:(_){ }))));
    receive(message('createSurface',{'surfaceId':'main','catalogId':appMixerCatalog}));
    receive(message('updateComponents',{'surfaceId':'main','components':[
      {'id':'root','component':'Button','child':'label','action':{'event':{'name':'save'}}},
      {'id':'label','component':'Text','text':'Save'}
    ]}));
    await tester.pump();expect(tester.widget<TextButton>(find.byType(TextButton)).onPressed,isNull);
  });

  test('shared invalid messages leave Flutter surface unchanged', () {
    final fixture=jsonDecode(File('test/fixtures/rejections.json').readAsStringSync()) as List;
    final store=FlutterSurfaceStore();store.apply(message('createSurface',{'surfaceId':'main','catalogId':appMixerCatalog}));
    store.apply(message('updateComponents',{'surfaceId':'main','components':[{'id':'root','component':'Text','text':'Safe'}]}));
    for(final invalid in fixture){expect(()=>store.apply(invalid),throwsFormatException);expect(store.snapshot().single?.text,'Safe');}
  });

  testWidgets('text fields in rows receive bounded width and remain editable', (tester) async {
    late void Function(Object?) receive;
    VoidCallback? subscribe(void Function(Object?) callback) {receive=callback;return null;}
    final errors=<Object>[];
    await tester.pumpWidget(MaterialApp(home:Scaffold(body:SizedBox(width:300,child:AppMixerA2UI(subscribe:subscribe,onError:errors.add)))));
    receive(message('createSurface',{'surfaceId':'main','catalogId':appMixerCatalog}));
    receive(message('updateComponents',{'surfaceId':'main','components':[
      {'id':'root','component':'Row','children':['first','nested']},
      {'id':'first','component':'TextField','label':'First','value':{'path':'/first'}},
      {'id':'nested','component':'Column','children':['second']},
      {'id':'second','component':'TextField','label':'Second','value':{'path':'/second'}}
    ]}));
    await tester.pump();expect(tester.takeException(),isNull);expect(find.byType(TextField),findsNWidgets(2));
    await tester.enterText(find.byType(TextField).first,'Ada');await tester.pump();
    expect(tester.widget<TextField>(find.byType(TextField).first).controller?.text,'Ada');expect(errors,isEmpty);expect(tester.takeException(),isNull);
  });

  testWidgets('text variants use the host theme and heading semantics', (tester) async {
    late void Function(Object?) receive;
    VoidCallback? subscribe(void Function(Object?) callback){receive=callback;return null;}
    final errors=<Object>[];
    await tester.pumpWidget(MaterialApp(home:Scaffold(body:AppMixerA2UI(subscribe:subscribe,onError:errors.add))));
    receive(message('createSurface',{'surfaceId':'main','catalogId':appMixerCatalog}));
    receive(message('updateComponents',{'surfaceId':'main','components':[
      {'id':'root','component':'Column','children':['heading','body','caption']},
      {'id':'heading','component':'Text','text':'Heading','variant':'h1'},
      {'id':'body','component':'Text','text':'Body'},
      {'id':'caption','component':'Text','text':'Caption','variant':'caption'}
    ]}));
    await tester.pump();
    final theme=Theme.of(tester.element(find.text('Heading'))).textTheme;
    expect(tester.widget<Text>(find.text('Heading')).style,theme.headlineLarge);
    expect(tester.widget<Text>(find.text('Body')).style,theme.bodyMedium);
    expect(tester.widget<Text>(find.text('Caption')).style,theme.bodySmall);
    final headingSemantics=tester.widget<Semantics>(find.ancestor(of:find.text('Heading'),matching:find.byType(Semantics)).first);
    expect(headingSemantics.properties.header,isTrue);
    expect(errors,isEmpty);expect(tester.takeException(),isNull);
  });

  testWidgets('stretch layouts render text and input in bounded and nested axes', (tester) async {
    late void Function(Object?) receive;
    VoidCallback? subscribe(void Function(Object?) callback){receive=callback;return null;}
    final errors=<Object>[];
    await tester.pumpWidget(MaterialApp(home:Scaffold(body:SizedBox(width:300,child:AppMixerA2UI(subscribe:subscribe,onError:errors.add)))));
    receive(message('createSurface',{'surfaceId':'main','catalogId':appMixerCatalog}));
    receive(message('updateComponents',{'surfaceId':'main','components':[
      {'id':'root','component':'Column','align':'stretch','children':['heading','row']},
      {'id':'heading','component':'Text','text':'Heading'},
      {'id':'row','component':'Row','align':'stretch','children':['field','label']},
      {'id':'field','component':'TextField','label':'Name','value':{'path':'/name'}},
      {'id':'label','component':'Text','text':'Label'}
    ]}));
    await tester.pump();expect(tester.takeException(),isNull);expect(find.text('Heading'),findsOneWidget);
    await tester.enterText(find.byType(TextField),'Ada');await tester.pump();expect(tester.takeException(),isNull);expect(errors,isEmpty);
  });
  test('rejects excessive nested stretch atomically', () {
    final store=FlutterSurfaceStore();store.apply(message('createSurface',{'surfaceId':'main','catalogId':appMixerCatalog}));
    store.apply(message('updateComponents',{'surfaceId':'main','components':[{'id':'root','component':'Text','text':'Safe'}]}));
    final components=<Map<String,dynamic>>[];
    for(var i=0;i<5;i++){components.add({'id':i==0?'root':'n$i','component':'Column','align':'stretch','children':[i==4?'leaf':'n${i+1}']});}
    components.add({'id':'leaf','component':'Text','text':'deep'});
    expect(()=>store.apply(message('updateComponents',{'surfaceId':'main','components':components})),throwsFormatException);
    expect(store.snapshot().single?.text,'Safe');
  });

}
