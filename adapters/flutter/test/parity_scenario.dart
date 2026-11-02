import 'package:app_mixer_flutter/app_mixer_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

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
  expect(errors,hasLength(3));expect(tester.takeException(),isNull);
}
