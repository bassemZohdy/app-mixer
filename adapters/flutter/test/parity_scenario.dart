import 'package:app_mixer_flutter/app_mixer_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Future<void> verifySurfaceEditingIdentity(WidgetTester tester) async {
  Map<String, Object?> message(String kind, Object payload) => {'version':'v0.9.1',kind:payload};
  late void Function(Object?) receive;
  VoidCallback? subscribe(void Function(Object?) callback){receive=callback;return null;}
  final errors=<Object>[];
  await tester.pumpWidget(MaterialApp(home:Scaffold(body:SizedBox(width:300,child:AppMixerA2UI(subscribe:subscribe,onError:errors.add)))));
  void create(String id, String value) {
    receive(message('createSurface',{'surfaceId':id,'catalogId':appMixerCatalog}));
    receive(message('updateDataModel',{'surfaceId':id,'value':{'name':value}}));
    receive(message('updateComponents',{'surfaceId':id,'components':[
      {'id':'root','component':'Column','children':['field']},
      {'id':'field','component':'TextField','label':id,'value':{'path':'/name'}}
    ]}));
  }
  create('first','Ada');create('second','Grace');await tester.pump();
  await tester.showKeyboard(find.byType(TextField).last);
  final state=tester.state<EditableTextState>(find.byType(EditableText).last);
  state.widget.controller.selection=const TextSelection.collapsed(offset:2);
  receive(message('deleteSurface',{'surfaceId':'first'}));await tester.pump();
  expect(tester.state<EditableTextState>(find.byType(EditableText)),same(state));
  expect(state.widget.focusNode.hasFocus,isTrue);
  expect(state.widget.controller.selection.baseOffset,2);
  receive(message('deleteSurface',{'surfaceId':'second'}));create('second','New');await tester.pump();
  final replacement=tester.state<EditableTextState>(find.byType(EditableText));
  expect(replacement,isNot(same(state)));expect(replacement.widget.controller.text,'New');
  expect(replacement.widget.focusNode.hasFocus,isFalse);
  expect(errors,isEmpty);expect(tester.takeException(),isNull);
}

// Run the same surface lifecycle on Flutter VM, web, Android and iOS.
Future<void> verifySurfaceParity(WidgetTester tester) async {
  late void Function(Object?) receive;
  VoidCallback? subscribe(void Function(Object?) callback) { receive=callback; return null; }
  final actions=<Map<String,dynamic>>[], errors=<Object>[];
  Finder display(String value) => find.byWidgetPredicate((widget)=>widget is Text && widget.data==value);
  void send(String kind, Map<String,dynamic> payload) => receive({'version':'v0.9.1',kind:payload});
  await tester.pumpWidget(MaterialApp(home:Scaffold(body:Center(child:SizedBox(width:300,child:AppMixerA2UI(subscribe:subscribe,onError:errors.add,onAction:actions.add))))));
  send('createSurface',{'surfaceId':'main','catalogId':appMixerCatalog});
  send('updateDataModel',{'surfaceId':'main','value':{'profile':{'name':'Ada'}}});
  send('updateComponents',{'surfaceId':'main','components':[
    {'id':'root','component':'Column','children':['card','button']},
    {'id':'card','component':'Card','child':'row'},
    {'id':'row','component':'Row','children':['field','display']},
    {'id':'field','component':'TextField','label':'Name','value':{'path':'/profile/name'}},
    {'id':'display','component':'Text','text':{'path':'/profile/name'}},
    {'id':'button','component':'Button','child':'label','action':{'event':{'name':'save','context':{'name':{'path':'/profile/name'}}}}},
    {'id':'label','component':'Text','text':'Save'}
  ]});
  send('createSurface',{'surfaceId':'other','catalogId':appMixerCatalog});
  send('updateDataModel',{'surfaceId':'other','value':{'profile':{'name':'Other'}}});
  send('updateComponents',{'surfaceId':'other','components':[{'id':'root','component':'Text','text':{'path':'/profile/name'}}]});
  await tester.pump();
  expect(display('Ada'),findsOneWidget);expect(display('Other'),findsOneWidget);
  send('updateDataModel',{'surfaceId':'main','path':'/profile/name','value':'Grace'});
  await tester.pump();
  expect(display('Grace'),findsOneWidget);expect(tester.widget<EditableText>(find.byType(EditableText)).controller.text,'Grace');
  send('updateComponents',{'surfaceId':'main','components':[{'id':'root','component':'Unsupported'}]});
  await tester.pump();
  expect(errors,hasLength(1));expect(display('Grace'),findsOneWidget);
  send('updateComponents',{'surfaceId':'main','components':[{'id':'label','component':'Row','children':['field']}]});
  await tester.pump();
  expect(errors,hasLength(2));expect(display('Grace'),findsOneWidget);expect(find.text('Save'),findsOneWidget);
  send('updateComponents',{'surfaceId':'main','components':[{'id':'label','component':'Button','child':'display','action':{'event':{'name':'nested'}}}]});
  await tester.pump();
  expect(errors,hasLength(3));expect(display('Other'),findsOneWidget);expect(find.text('Save'),findsOneWidget);
  await tester.enterText(find.byType(TextField),'Lin');await tester.pump();
  expect(display('Lin'),findsOneWidget);expect(display('Other'),findsOneWidget);
  await tester.tap(find.byType(TextButton));await tester.pump();
  expect((actions.single['action'] as Map)['context'],{'name':'Lin'});
  send('deleteSurface',{'surfaceId':'other'});await tester.pump();
  expect(display('Other'),findsNothing);expect(tester.widget<EditableText>(find.byType(EditableText)).controller.text,'Lin');
  send('createSurface',{'surfaceId':'other','catalogId':appMixerCatalog});
  send('updateDataModel',{'surfaceId':'other','value':{'profile':{'name':'Fresh'}}});
  send('updateComponents',{'surfaceId':'other','components':[{'id':'root','component':'Text','text':{'path':'/profile/name'}}]});
  await tester.pump();
  expect(display('Fresh'),findsOneWidget);expect(display('Lin'),findsOneWidget);
  expect(tester.widget<EditableText>(find.byType(EditableText)).controller.text,'Lin');
  await tester.tap(find.byType(TextButton));await tester.pump();
  expect((actions.last['action'] as Map)['context'],{'name':'Lin'});expect(actions,hasLength(2));
  send('updateComponents',{'surfaceId':'main','components':[{'id':'field','component':'TextField','label':'Notes','value':{'path':'/profile/name'},'variant':'longText'}]});
  await tester.pump();expect(tester.widget<TextField>(find.byType(TextField)).maxLines,isNull);
  const notes='First line\nSecond line';
  await tester.enterText(find.byType(TextField),notes);await tester.pump();
  expect(display(notes),findsOneWidget);expect(display('Fresh'),findsOneWidget);
  final semantics=tester.ensureSemantics();
  try {final field=tester.getSemantics(find.byType(EditableText)).getSemanticsData();expect(field.flagsCollection.isTextField,isTrue);expect(field.label,'Notes');expect(field.value,notes);final mirrored=tester.getSemantics(display(notes)).getSemanticsData();expect(mirrored.label,notes);expect(mirrored.flagsCollection.isTextField,isFalse);} finally {semantics.dispose();}
  await tester.tap(find.byType(TextButton));await tester.pump();
  expect((actions.last['action'] as Map)['context'],{'name':notes});expect(actions,hasLength(3));
  expect(errors,hasLength(3));expect(tester.takeException(),isNull);
}

// Exercise narrow row layout and interaction on VM, web, Android and iOS.
Future<void> verifyNarrowRowParity(WidgetTester tester) async {
  late void Function(Object?) receive;
  VoidCallback? subscribe(void Function(Object?) callback) {receive=callback;return null;}
  final actions=<Map<String,dynamic>>[],errors=<Object>[],label='Save this carefully reviewed long form';
  final semantics=tester.ensureSemantics();
  try {
    await tester.pumpWidget(MaterialApp(home:Scaffold(body:SafeArea(child:Align(alignment:Alignment.topLeft,child:SizedBox(width:240,child:AppMixerA2UI(subscribe:subscribe,onError:errors.add,onAction:actions.add)))))));
    receive({'version':'v0.9.1','createSurface':{'surfaceId':'main','catalogId':appMixerCatalog}});
    receive({'version':'v0.9.1','updateDataModel':{'surfaceId':'main','value':{'name':'Ada'}}});
    receive({'version':'v0.9.1','updateComponents':{'surfaceId':'main','components':[
      {'id':'root','component':'Row','children':['field','button']},
      {'id':'field','component':'TextField','label':'Name','value':{'path':'/name'}},
      {'id':'button','component':'Button','child':'label','action':{'event':{'name':'save','context':{'name':{'path':'/name'}}}}},
      {'id':'label','component':'Text','text':label}
    ]}});
    await tester.pump();expect(tester.takeException(),isNull);
    final row=tester.getRect(find.ancestor(of:find.byType(TextButton),matching:find.byType(Row)).first),field=tester.getRect(find.byType(TextField)),button=tester.getRect(find.byType(TextButton));
    expect(row.width,240);expect(field.left,greaterThanOrEqualTo(row.left-0.01));expect(field.right,lessThanOrEqualTo(row.right+0.01));expect(button.left,greaterThanOrEqualTo(row.left-0.01));expect(button.right,lessThanOrEqualTo(row.right+0.01));expect(tester.getSize(find.text(label)).height,greaterThan(20));
    expect(tester.getSemantics(find.byType(EditableText)).getSemanticsData().flagsCollection.isTextField,isTrue);expect(tester.getSemantics(find.byType(TextButton)).getSemanticsData().flagsCollection.isButton,isTrue);
    await tester.enterText(find.byType(TextField),'Grace');await tester.pumpAndSettle();expect(find.byType(TextButton).hitTestable(),findsOneWidget);await tester.tap(find.byType(TextButton));await tester.pumpAndSettle();
    expect((actions.single['action'] as Map)['context'],{'name':'Grace'});expect(errors,isEmpty);expect(tester.takeException(),isNull);
  } finally {semantics.dispose();}
}

// Nested row children must wrap within the available width on each target.
Future<void> verifyNarrowNestedRowParity(WidgetTester tester) async {
  late void Function(Object?) receive;
  VoidCallback? subscribe(void Function(Object?) callback) {receive=callback;return null;}
  final errors=<Object>[], labels=['A long nested column label needs to wrap','A long nested card label needs to wrap','A long nested row label needs to wrap'];
  await tester.pumpWidget(MaterialApp(home:Scaffold(body:Align(alignment:Alignment.topLeft,child:SizedBox(width:240,child:AppMixerA2UI(subscribe:subscribe,onError:errors.add))))));
  receive({'version':'v0.9.1','createSurface':{'surfaceId':'main','catalogId':appMixerCatalog}});
  receive({'version':'v0.9.1','updateComponents':{'surfaceId':'main','components':[
    {'id':'root','component':'Row','children':['column','card','row']},
    {'id':'column','component':'Column','children':['one']},{'id':'one','component':'Text','text':labels[0]},
    {'id':'card','component':'Card','child':'two'},{'id':'two','component':'Text','text':labels[1]},
    {'id':'row','component':'Row','children':['three']},{'id':'three','component':'Text','text':labels[2]}
  ]}});
  await tester.pump();expect(tester.takeException(),isNull);
  final parent=tester.getRect(find.ancestor(of:find.text(labels[0]),matching:find.byType(Row)).last);
  expect(parent.width,240);
  for(final label in labels){final box=tester.getRect(find.text(label));expect(box.left,greaterThanOrEqualTo(parent.left-0.01));expect(box.right,lessThanOrEqualTo(parent.right+0.01));expect(box.height,greaterThan(20));}
  expect(errors,isEmpty);expect(tester.takeException(),isNull);
}

Future<void> verifyAdjacentFieldSemantics(WidgetTester tester) async {
    Map<String,Object?> message(String kind,Object payload)=>{'version':'v0.9.1',kind:payload};
    final semantics=tester.ensureSemantics();
    try {
      late void Function(Object?) receive;final errors=<Object>[];
      VoidCallback? subscribe(void Function(Object?) callback){receive=callback;return null;}
      await tester.pumpWidget(MaterialApp(home:Scaffold(body:SizedBox(width:300,child:AppMixerA2UI(subscribe:subscribe,onError:errors.add)))));
      receive(message('createSurface',{'surfaceId':'main','catalogId':appMixerCatalog}));
      receive(message('updateDataModel',{'surfaceId':'main','value':{'name':'Ada'}}));
      for(final layout in ['Column','Row']) {for(final wrapper in ['direct','Column','Row','Card']) {for(final fieldFirst in [true,false]) {
        final adjacent=wrapper=='direct' ? 'display' : 'nested';
        receive(message('updateComponents',{'surfaceId':'main','components':[
          {'id':'root','component':layout,'children':fieldFirst?['field',adjacent]:[adjacent,'field']},
          {'id':'field','component':'TextField','label':'Name','value':{'path':'/name'}},
          if(wrapper=='Card') {'id':'nested','component':'Card','child':'display'},
          if(wrapper=='Column'||wrapper=='Row') {'id':'nested','component':wrapper,'children':['display']},
          {'id':'display','component':'Text','text':{'path':'/name'}}
        ]}));await tester.pump();
        final field=tester.getSemantics(find.byType(EditableText)).getSemanticsData();
        final text=tester.getSemantics(find.byWidgetPredicate((w)=>w is Text && w.data=='Ada')).getSemanticsData();
        expect(field.flagsCollection.isTextField,isTrue);expect(field.label,'Name');expect(field.value,'Ada');
        expect(text.flagsCollection.isTextField,isFalse);expect(text.label,'Ada');expect(tester.takeException(),isNull);
      }}}
      expect(errors,isEmpty);
    } finally {semantics.dispose();}
}

void verifyUnicodeTextLimit() {
  final store=FlutterSurfaceStore();
  Map<String,Object?> message(String kind,Object payload)=>{'version':'v0.9.1',kind:payload};
  store.apply(message('createSurface',{'surfaceId':'main','catalogId':appMixerCatalog}));
  final text=List.filled(10000,'\u{1F600}').join();
  Map<String,Object?> update(String value)=>message('updateComponents',{'surfaceId':'main','components':[{'id':'root','component':'Text','text':value}]});
  store.apply(update(text));expect(store.snapshot().single?.text,text);
  expect(()=>store.apply(update('${text}x')),throwsFormatException);expect(store.snapshot().single?.text,text);
}

void verifyUnicodeIdentifierLimit() {
  final store=FlutterSurfaceStore(),identifier=List.filled(256,'\u{1F600}').join();
  Map<String,Object?> message(String kind,Object payload)=>{'version':'v0.9.1',kind:payload};
  store.apply(message('createSurface',{'surfaceId':'main','catalogId':appMixerCatalog}));
  Map<String,Object?> update(String event)=>message('updateComponents',{'surfaceId':'main','components':[
    {'id':'root','component':'Button','child':identifier,'action':{'event':{'name':event}}},
    {'id':identifier,'component':'Text','text':'Safe'}
  ]});
  store.apply(update(identifier));expect((store.action('main','root',store.views().single.revision)['action'] as Map)['name'],identifier);
  expect(()=>store.apply(update('${identifier}x')),throwsFormatException);
  expect((store.action('main','root',store.views().single.revision)['action'] as Map)['name'],identifier);
}

void verifyRootValueBindings() {
  final store=FlutterSurfaceStore();
  Map<String,Object?> message(String kind,Object payload)=>{'version':'v0.9.1',kind:payload};
  store.apply(message('createSurface',{'surfaceId':'main','catalogId':appMixerCatalog}));
  store.apply(message('updateDataModel',{'surfaceId':'main','value':'Root value'}));
  store.apply(message('updateComponents',{'surfaceId':'main','components':[
    {'id':'root','component':'Button','child':'label','action':{'event':{'name':'go','context':{'root':{'path':''}}}}},
    {'id':'label','component':'Text','text':{'path':''}}
  ]}));
  expect(store.snapshot().single?.children.single.text,'Root value');
  expect(((store.action('main','root',store.views().single.revision)['action'] as Map)['context'] as Map)['root'],'Root value');
  store.apply(message('updateDataModel',{'surfaceId':'main','path':'/','value':'Replaced root'}));
  store.apply(message('updateComponents',{'surfaceId':'main','components':[
    {'id':'root','component':'Button','child':'label','action':{'event':{'name':'go','context':{'root':{'path':'/'}}}}},
    {'id':'label','component':'Text','text':{'path':'/'}}
  ]}));
  expect(store.snapshot().single?.children.single.text,'Replaced root');
  expect(((store.action('main','root',store.views().single.revision)['action'] as Map)['context'] as Map)['root'],'Replaced root');
}

void verifyLineBreakFieldPath() {
  final store=FlutterSurfaceStore();
  Map<String,Object?> message(String kind,Object payload)=>{'version':'v0.9.1',kind:payload};
  store.apply(message('createSurface',{'surfaceId':'main','catalogId':appMixerCatalog}));
  store.apply(message('updateDataModel',{'surfaceId':'main','value':{'\n':'Ada'}}));
  store.apply(message('updateComponents',{'surfaceId':'main','components':[{'id':'root','component':'TextField','label':'Name','value':{'path':'/\n'}}]}));
  expect(store.snapshot().single?.value,'Ada');store.writeField('main','root',store.views().single.revision,'Grace');expect(store.snapshot().single?.value,'Grace');
}

Future<void> verifyInputComposition(WidgetTester tester) async {
  Map<String, Object?> message(String kind, Object payload) => {'version':'v0.9.1',kind:payload};
  late void Function(Object?) receive;
  VoidCallback? subscribe(void Function(Object?) callback){receive=callback;return null;}
  final errors=<Object>[];
  await tester.pumpWidget(MaterialApp(home:Scaffold(body:SizedBox(width:300,child:AppMixerA2UI(subscribe:subscribe,onError:errors.add)))));
  receive(message('createSurface',{'surfaceId':'main','catalogId':appMixerCatalog}));
  receive(message('updateDataModel',{'surfaceId':'main','value':{'name':'Ada'}}));
  receive(message('updateComponents',{'surfaceId':'main','components':[
    {'id':'root','component':'Column','children':['field','mirror','echo']},
    {'id':'field','component':'TextField','label':'Name','value':{'path':'/name'}},
    {'id':'mirror','component':'TextField','label':'Name copy','value':{'path':'/name'}},
    {'id':'echo','component':'Text','text':{'path':'/name'}}
  ]}));
  await tester.pump();await tester.showKeyboard(find.byType(TextField).first);
  final state=tester.state<EditableTextState>(find.byType(EditableText).first);
  state.updateEditingValue(const TextEditingValue(text:'日本',selection:TextSelection.collapsed(offset:2),composing:TextRange(start:0,end:2)));
  await tester.pump();expect(state.textEditingValue.composing,const TextRange(start:0,end:2));
  receive(message('updateDataModel',{'surfaceId':'main','path':'/name','value':'External'}));await tester.pump();
  expect(state.textEditingValue.text,'日本');expect(state.textEditingValue.composing,const TextRange(start:0,end:2));expect(find.text('External'),findsNWidgets(2));
  state.updateEditingValue(const TextEditingValue(text:'日本',selection:TextSelection.collapsed(offset:2)));
  await tester.pump();expect(state.textEditingValue.text,'日本');expect(find.text('日本'),findsNWidgets(3));
  receive(message('updateDataModel',{'surfaceId':'main','path':'/name','value':'Other'}));await tester.pump();
  state.updateEditingValue(const TextEditingValue(text:'日本',selection:TextSelection.collapsed(offset:2)));await tester.pump();
  expect(find.text('日本'),findsNWidgets(3));
  expect(state.widget.focusNode.hasFocus,isTrue);expect(errors,isEmpty);expect(tester.takeException(),isNull);
}
