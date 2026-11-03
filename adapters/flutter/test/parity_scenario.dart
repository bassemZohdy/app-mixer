import 'dart:convert';
import 'package:app_mixer_flutter/app_mixer_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show rootBundle;
import 'package:flutter_test/flutter_test.dart';

Future<Map<String,dynamic>> _incrementalMissingChildFixture() async => jsonDecode(await rootBundle.loadString('packages/app_mixer_flutter/assets/incremental-missing-child.json')) as Map<String,dynamic>;

Future<void> verifyIncrementalMissingChildSpacing(WidgetTester tester) async {
  // Browser asset loading requires the real async event loop; testWidgets runs
  // inside fake async, where the browser fetch never completes.
  final fixture=await tester.runAsync(_incrementalMissingChildFixture);
  if(fixture==null) throw StateError('Could not load incremental child fixture');
  Map<String,Object?> message(String kind,Object payload)=>{'version':'v0.9.1',kind:payload};
  late void Function(Object?) receive;
  VoidCallback? subscribe(void Function(Object?) callback){receive=callback;return null;}
  final errors=<Object>[];
  await tester.pumpWidget(MaterialApp(home:Scaffold(body:Align(alignment:Alignment.topLeft,child:SizedBox(width:300,child:AppMixerA2UI(subscribe:subscribe,onError:errors.add))))));
  for(final mode in fixture['modes'] as List){
    receive(fixture['create']);
    final root=Map<String,dynamic>.from(fixture['root'] as Map)..['justify']=mode;
    receive(message('updateComponents',{'surfaceId':'main','components':[...(fixture['children'] as List),root]}));
    await tester.pump();
    final rowFinder=find.ancestor(of:find.text('Left'),matching:find.byType(Row)).first,row=tester.getRect(rowFinder),left=tester.getRect(find.text('Left')),pending=tester.getRect(find.byKey(const ValueKey(('middle',0)))),right=tester.getRect(find.text('Right'));
    expect(row.width,closeTo(300,0.5),reason:'$mode row width');expect(pending.width,0,reason:'$mode missing slot width');expect(pending.height,0,reason:'$mode missing slot height');
    final free=row.width-left.width-right.width,gap=mode=='spaceBetween'?free/2:mode=='spaceAround'?free/3:free/4,start=mode=='spaceAround'?gap/2:mode=='spaceEvenly'?gap:0.0;
    expect(left.left-row.left,closeTo(start,1.0),reason:'$mode left position');
    expect(pending.left-left.right,closeTo(gap,1.0),reason:'$mode gap to missing slot');
    expect(right.left-pending.right,closeTo(gap,1.0),reason:'$mode gap after missing slot');
    receive(message('updateComponents',{'surfaceId':'main','components':[fixture['resolve']]}));await tester.pump();
    final middle=tester.getRect(find.text('Middle')),newLeft=tester.getRect(find.text('Left')),newRight=tester.getRect(find.text('Right')),resolvedFree=row.width-newLeft.width-middle.width-newRight.width,resolvedGap=mode=='spaceBetween'?resolvedFree/2:mode=='spaceAround'?resolvedFree/3:resolvedFree/4,resolvedStart=mode=='spaceAround'?resolvedGap/2:mode=='spaceEvenly'?resolvedGap:0.0;
    expect(newLeft.left-row.left,closeTo(resolvedStart,1.0),reason:'$mode resolved left position');
    expect(middle.left-newLeft.right,closeTo(resolvedGap,1.0),reason:'$mode resolved first gap');
    expect(newRight.left-middle.right,closeTo(resolvedGap,1.0),reason:'$mode resolved second gap');
    receive(message('deleteSurface',{'surfaceId':'main'}));await tester.pump();
  }
  expect(errors,isEmpty);expect(tester.takeException(),isNull);
}

Future<void> verifyIncrementalMissingColumnSpacing(WidgetTester tester) async {
  Map<String,Object?> message(String kind,Object payload)=>{'version':'v0.9.1',kind:payload};
  final registry=FlutterComponentRegistry()..register('height-probe',(context,props)=>const SizedBox(key:ValueKey('height-probe'),width:1,height:300),(component)=>true);
  late void Function(Object?) receive;
  VoidCallback? subscribe(void Function(Object?) callback){receive=callback;return null;}
  final errors=<Object>[];
  await tester.pumpWidget(MaterialApp(home:Scaffold(body:Align(alignment:Alignment.topLeft,child:SizedBox(width:300,height:300,child:AppMixerA2UI(subscribe:subscribe,onError:errors.add,extensions:registry))))));
  for(final mode in ['spaceBetween','spaceAround','spaceEvenly']){
    receive(message('createSurface',{'surfaceId':'main','catalogId':appMixerCatalog}));
    receive(message('updateComponents',{'surfaceId':'main','components':[
      {'id':'root','component':'Row','align':'stretch','justify':'start','children':['vertical','probe']},
      {'id':'vertical','component':'Column','align':'stretch','justify':mode,'children':['top','middle','bottom']},
      {'id':'top','component':'Text','text':'Top'},
      {'id':'bottom','component':'Text','text':'Bottom'},
      {'id':'probe','component':'height-probe'}
    ]}));
    await tester.pump();
    final columnFinder=find.ancestor(of:find.text('Top'),matching:find.byType(Column)).first,column=tester.getRect(columnFinder),top=tester.getRect(find.text('Top')),pending=tester.getRect(find.byKey(const ValueKey(('middle',0)))),bottom=tester.getRect(find.text('Bottom'));
    expect(column.height,closeTo(300,0.5),reason:'$mode column height');expect(pending.width,closeTo(column.width,0.5),reason:'$mode missing slot stretches across the cross axis');expect(pending.height,0,reason:'$mode missing slot has no main-axis size');
    final free=column.height-top.height-bottom.height,gap=mode=='spaceBetween'?free/2:mode=='spaceAround'?free/3:free/4,start=mode=='spaceAround'?gap/2:mode=='spaceEvenly'?gap:0.0;
    expect(top.top-column.top,closeTo(start,1.0),reason:'$mode top position');
    expect(pending.top-top.bottom,closeTo(gap,1.0),reason:'$mode gap to missing slot');
    expect(bottom.top-pending.bottom,closeTo(gap,1.0),reason:'$mode gap after missing slot');
    receive(message('updateComponents',{'surfaceId':'main','components':[{'id':'middle','component':'Text','text':'Middle'}]}));await tester.pump();
    final middle=tester.getRect(find.text('Middle')),newTop=tester.getRect(find.text('Top')),newBottom=tester.getRect(find.text('Bottom')),resolvedFree=column.height-newTop.height-middle.height-newBottom.height,resolvedGap=mode=='spaceBetween'?resolvedFree/2:mode=='spaceAround'?resolvedFree/3:resolvedFree/4,resolvedStart=mode=='spaceAround'?resolvedGap/2:mode=='spaceEvenly'?resolvedGap:0.0;
    expect(newTop.top-column.top,closeTo(resolvedStart,1.0),reason:'$mode resolved top position');
    expect(middle.top-newTop.bottom,closeTo(resolvedGap,1.0),reason:'$mode resolved first gap');
    expect(newBottom.top-middle.bottom,closeTo(resolvedGap,1.0),reason:'$mode resolved second gap');
    receive(message('deleteSurface',{'surfaceId':'main'}));await tester.pump();
  }
  expect(errors,isEmpty);expect(tester.takeException(),isNull);
}

Future<void> verifyRowSpacing(WidgetTester tester) async {
  Map<String,Object?> message(String kind,Object payload)=>{'version':'v0.9.1',kind:payload};
  late void Function(Object?) receive;
  VoidCallback? subscribe(void Function(Object?) callback){receive=callback;return null;}
  final errors=<Object>[];
  await tester.pumpWidget(MaterialApp(home:Scaffold(body:Align(alignment:Alignment.topLeft,child:SizedBox(width:300,child:AppMixerA2UI(subscribe:subscribe,onError:errors.add))))));
  receive(message('createSurface',{'surfaceId':'main','catalogId':appMixerCatalog}));
  receive(message('updateComponents',{'surfaceId':'main','components':[{'id':'left','component':'Text','text':'Left'},{'id':'right','component':'Text','text':'Right'}]}));
  for(final mode in ['start','center','end','spaceBetween','spaceAround','spaceEvenly']){
    receive(message('updateComponents',{'surfaceId':'main','components':[{'id':'root','component':'Row','align':'start','justify':mode,'children':['left','right']}]}));await tester.pump();
    final row=tester.getRect(find.ancestor(of:find.text('Left'),matching:find.byType(Row)).first),left=tester.getRect(find.text('Left')),right=tester.getRect(find.text('Right'));
    final remaining=row.width-left.width-right.width;
    final expectedLeft=switch(mode){'center'=>remaining/2,'end'=>remaining,'spaceAround'=>remaining/4,'spaceEvenly'=>remaining/3,_=>0.0};
    final expectedGap=switch(mode){'spaceBetween'=>remaining,'spaceAround'=>remaining/2,'spaceEvenly'=>remaining/3,_=>0.0};
    expect(row.width,closeTo(300,0.5),reason:mode);expect(left.left-row.left,closeTo(expectedLeft,1.0),reason:mode);expect(right.left-left.right,closeTo(expectedGap,1.0),reason:mode);
  }
  expect(errors,isEmpty);expect(tester.takeException(),isNull);
}

Future<void> verifyRowAlignment(WidgetTester tester) async {
  Map<String,Object?> message(String kind,Object payload)=>{'version':'v0.9.1',kind:payload};
  late void Function(Object?) receive;
  VoidCallback? subscribe(void Function(Object?) callback){receive=callback;return null;}
  final errors=<Object>[];
  await tester.pumpWidget(MaterialApp(home:Scaffold(body:Align(alignment:Alignment.topLeft,child:SizedBox(width:300,child:AppMixerA2UI(subscribe:subscribe,onError:errors.add))))));
  receive(message('createSurface',{'surfaceId':'main','catalogId':appMixerCatalog}));
  receive(message('updateComponents',{'surfaceId':'main','components':[{'id':'tall','component':'Text','variant':'h1','text':'Tall'},{'id':'short','component':'Text','variant':'caption','text':'Short'}]}));
  for(final align in ['start','center','end','stretch']){
    receive(message('updateComponents',{'surfaceId':'main','components':[{'id':'root','component':'Row','align':align,'children':['tall','short']}]}));await tester.pump();
    final row=tester.getRect(find.ancestor(of:find.text('Tall'),matching:find.byType(Row)).first),small=tester.getRect(find.text('Short')),free=row.height-small.height;
    final expected=align=='center'?free/2:align=='end'?free:0.0;
    expect(small.top-row.top,closeTo(expected,1.0),reason:align);
    if(align=='stretch')expect(small.height,closeTo(row.height,1.0),reason:align);
  }
  expect(errors,isEmpty);expect(tester.takeException(),isNull);
}

Future<void> verifyColumnAlignment(WidgetTester tester) async {
  Map<String,Object?> message(String kind,Object payload)=>{'version':'v0.9.1',kind:payload};
  late void Function(Object?) receive;
  VoidCallback? subscribe(void Function(Object?) callback){receive=callback;return null;}
  final errors=<Object>[];
  await tester.pumpWidget(MaterialApp(home:Scaffold(body:Align(alignment:Alignment.topLeft,child:SizedBox(width:300,child:AppMixerA2UI(subscribe:subscribe,onError:errors.add))))));
  receive(message('createSurface',{'surfaceId':'main','catalogId':appMixerCatalog}));
  receive(message('updateComponents',{'surfaceId':'main','components':[{'id':'first','component':'Text','text':'First'},{'id':'second','component':'Text','text':'Second'}]}));
  for(final align in ['start','center','end','stretch']){
    receive(message('updateComponents',{'surfaceId':'main','components':[{'id':'root','component':'Column','align':align,'children':['first','second']}]}));await tester.pump();
    final column=tester.getRect(find.ancestor(of:find.text('First'),matching:find.byType(Column)).first),child=tester.getRect(find.text('First')),free=column.width-child.width;
    final expected=align=='center'?free/2:align=='end'?free:0.0;
    expect(column.width,closeTo(300,0.5),reason:align);expect(child.left-column.left,closeTo(expected,1.0),reason:align);
    if(align=='stretch')expect(child.width,closeTo(column.width,1.0),reason:align);
  }
  expect(errors,isEmpty);expect(tester.takeException(),isNull);
}

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
  final errors=<Object>[], actions=<Map<String,dynamic>>[];
  await tester.pumpWidget(MaterialApp(home:Scaffold(body:SizedBox(width:300,child:AppMixerA2UI(subscribe:subscribe,onError:errors.add,onAction:actions.add)))));
  receive(message('createSurface',{'surfaceId':'main','catalogId':appMixerCatalog}));
  receive(message('updateDataModel',{'surfaceId':'main','value':{'name':'Ada'}}));
  receive(message('updateComponents',{'surfaceId':'main','components':[
    {'id':'root','component':'Column','children':['field','mirror','echo','button']},
    {'id':'field','component':'TextField','label':'Name','value':{'path':'/name'}},
    {'id':'mirror','component':'TextField','label':'Name copy','value':{'path':'/name'}},
    {'id':'echo','component':'Text','text':{'path':'/name'}},
    {'id':'button','component':'Button','child':'label','action':{'event':{'name':'save','context':{'name':{'path':'/name'}}}}},
    {'id':'label','component':'Text','text':'Save'}
  ]}));
  await tester.pump();await tester.showKeyboard(find.byType(TextField).first);
  final state=tester.state<EditableTextState>(find.byType(EditableText).first);
  state.updateEditingValue(const TextEditingValue(text:'日本',selection:TextSelection.collapsed(offset:2),composing:TextRange(start:0,end:2)));
  await tester.pump();expect(state.textEditingValue.composing,const TextRange(start:0,end:2));
  receive(message('updateDataModel',{'surfaceId':'main','path':'/name','value':'External'}));await tester.pump();
  expect(state.textEditingValue.text,'日本');expect(state.textEditingValue.composing,const TextRange(start:0,end:2));expect(find.text('External'),findsNWidgets(2));
  tester.widget<TextButton>(find.byType(TextButton)).onPressed!();
  expect(((actions.last['action'] as Map)['context'] as Map)['name'],'External');
  state.updateEditingValue(const TextEditingValue(text:'日本',selection:TextSelection.collapsed(offset:2)));
  await tester.pump();expect(state.textEditingValue.text,'日本');expect(find.text('日本'),findsNWidgets(3));
  tester.widget<TextButton>(find.byType(TextButton)).onPressed!();
  expect(((actions.last['action'] as Map)['context'] as Map)['name'],'日本');
  receive(message('updateDataModel',{'surfaceId':'main','path':'/name','value':'Other'}));await tester.pump();
  state.updateEditingValue(const TextEditingValue(text:'日本',selection:TextSelection.collapsed(offset:2)));await tester.pump();
  expect(find.text('日本'),findsNWidgets(3));
  expect(state.widget.focusNode.hasFocus,isTrue);expect(errors,isEmpty);expect(tester.takeException(),isNull);
}

Future<void> verifyCardLayoutParity(WidgetTester tester) async {
  Map<String,Object?> message(String kind,Object payload)=>{'version':'v0.9.1',kind:payload};
  late void Function(Object?) receive;
  VoidCallback? subscribe(void Function(Object?) callback) {receive=callback;return null;}
  final errors=<Object>[];
  await tester.pumpWidget(MaterialApp(home:Scaffold(body:AppMixerA2UI(subscribe:subscribe,onError:errors.add))));
  receive(message('createSurface',{'surfaceId':'main','catalogId':appMixerCatalog}));
  receive(message('updateComponents',{'surfaceId':'main','components':[
    {'id':'root','component':'Column','children':['outside','box']},
    {'id':'outside','component':'Text','text':'Outside'},
    {'id':'box','component':'Card','child':'inside'},
    {'id':'inside','component':'Text','text':'Inside'},
  ]}));
  await tester.pump();
  final outside=tester.getRect(find.text('Outside')),inside=tester.getRect(find.text('Inside'));
  expect(inside.left,outside.left);expect(inside.top,outside.bottom);
  expect(find.byType(Card),findsNothing);expect(errors,isEmpty);
}
