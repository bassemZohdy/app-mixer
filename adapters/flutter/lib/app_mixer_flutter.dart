import 'dart:convert';
import 'package:flutter/material.dart';

const appMixerCatalog = 'https://raw.githubusercontent.com/bassemZohdy/app-mixer/main/packages/web/catalog/v1/catalog.json';
const basicCatalog = 'https://a2ui.org/specification/v0_9_1/catalogs/basic/catalog.json';
typedef A2UISubscribe = VoidCallback? Function(ValueChanged<Object?> receive);

bool _id(Object? value) => value is String && value.isNotEmpty && value.length <= 256;
bool _only(Map<String, dynamic> value, List<String> keys) => value.keys.every(keys.contains);
Map<String, dynamic> _object(Object? value) {
  if (value is! Map || value.keys.any((key) => key is! String)) throw FormatException('Expected object');
  return Map<String, dynamic>.from(value);
}

List<String> _pointer(String path) {
  if (path.isEmpty || path == '/') return [];
  if (!path.startsWith('/')) throw FormatException('Only absolute JSON pointers are supported');
  return path.substring(1).split('/').map((part) {
    if (RegExp(r'~(?![01])').hasMatch(part)) throw FormatException('Invalid JSON pointer');
    final key=part.replaceAll('~1','/').replaceAll('~0','~');
    if (['__proto__','prototype','constructor'].contains(key)) throw FormatException('Unsafe JSON pointer');
    return key;
  }).toList();
}
final _deleted = Object();
dynamic _copy(dynamic value) {
  var count=0;
  final ancestors=<Object>{};
  dynamic visit(dynamic input, int depth) {
    if (++count>10000 || depth>100) throw FormatException('Data model too large');
    if (identical(input,_deleted)) return _deleted;
    if (input==null || input is String || input is bool || (input is num && input.isFinite)) return input;
    if (input is! List && input is! Map) throw FormatException('Unsupported data value');
    if (!ancestors.add(input)) throw FormatException('Cyclic data model');
    dynamic result;
    if (input is List) {result=input.map((value)=>visit(value,depth+1)).toList();}
    else {
      final values=<String,dynamic>{};
      for (final entry in (input as Map).entries) {
        if (entry.key is! String || ['__proto__','prototype','constructor'].contains(entry.key)) throw FormatException('Unsafe data key');
        values[entry.key as String]=visit(entry.value,depth+1);
      }
      result=values;
    }
    ancestors.remove(input);return result;
  }
  return visit(value,0);
}
final _missing = Object();
dynamic _export(dynamic value) {
  if (identical(value,_deleted)) return null;
  if (value is List) return value.map(_export).toList();
  if (value is Map) return value.map((key, item)=>MapEntry(key, _export(item)));
  return value;
}
dynamic _read(dynamic data, String path) {
  var value=data;
  for (final key in _pointer(path)) {
    if (value is Map) {if (!value.containsKey(key)) return _missing; value=value[key];}
    else if (value is List) {final index=int.tryParse(key);if (index==null || index<0 || index>=value.length || '$index'!=key) return _missing; value=value[index];}
    else {return _missing;}
    if (identical(value,_deleted)) return _missing;
  }
  return value;
}
dynamic _update(dynamic data, String path, dynamic value, bool remove) {
  final keys=_pointer(path);if (keys.isEmpty) return remove ? <String,dynamic>{} : _copy(value);
  final root=_copy(data);dynamic current=root;
  for (final key in keys.take(keys.length-1)) {
    if (current is Map) {
      if (!current.containsKey(key)) {if (remove) return root; current[key]=<String,dynamic>{};}
      current=current[key];
    } else if (current is List) {
      final index=int.tryParse(key);if(index==null||index<0||index>=current.length||'$index'!=key)throw FormatException('Invalid array index');
      if (identical(current[index],_deleted)) {if(remove)return root;throw FormatException('Invalid array index');}
      current=current[index];
    } else {throw FormatException('Data path parent does not exist');}
  }
  final last=keys.last;
  if (current is Map) {if(remove) {current.remove(last);} else {current[last]=_copy(value);}}
  else if (current is List) {final index=int.tryParse(last);if(index==null||index<0||index>=current.length||'$index'!=last)throw FormatException('Invalid array index');current[index]=remove?_deleted:_copy(value);}
  else {throw FormatException('Data path parent does not exist');}
  return _copy(root);
}

class NativeNode {
  const NativeNode(this.id, this.kind, this.children, {this.text, this.variant, this.justify, this.align, this.label, this.value});
  final String id, kind;
  final List<NativeNode> children;
  final String? text, variant, justify, align, label, value;
}
class _Surface {
  _Surface(this.id, this.revision);
  final String id;
  int revision;
  Map<String, Map<String, dynamic>> components = {};
  dynamic data = <String, dynamic>{};
}

class SurfaceView {
  const SurfaceView(this.id, this.revision, this.root);
  final String id;
  final int revision;
  final NativeNode? root;
}

/// Validates a bounded subset and commits component updates atomically.
class FlutterSurfaceStore {
  final Map<String, _Surface> _surfaces = {};
  int _revision = 0;
  void apply(Object? input) {
    final message = _object(input);
    if (message['version'] != 'v0.9.1') throw FormatException('Unsupported A2UI version');
    final keys = ['createSurface', 'updateComponents', 'updateDataModel', 'deleteSurface'].where(message.containsKey).toList();
    if (keys.length != 1 || !_only(message, ['version', keys.first])) throw FormatException('Unsupported A2UI message');
    final kind = keys.first, payload = _object(message[kind]);
    if (!_id(payload['surfaceId'])) throw FormatException('Invalid surface ID');
    final id = payload['surfaceId'] as String;
    if (kind == 'createSurface') {
      if (!_only(payload, ['surfaceId', 'catalogId']) || ![appMixerCatalog, basicCatalog].contains(payload['catalogId'])) throw FormatException('Unsupported catalog');
      if (_surfaces.containsKey(id) || _surfaces.length >= 100) throw FormatException('Duplicate or excessive surfaces');
      _surfaces[id] = _Surface(id, ++_revision); return;
    }
    final surface = _surfaces[id];
    if (surface == null) throw FormatException('Unknown surface');
    if (kind == 'deleteSurface') {
      if (!_only(payload, ['surfaceId'])) throw FormatException('Unsupported delete property');
      _surfaces.remove(id); return;
    }
    if (kind == 'updateDataModel') {
      if (!_only(payload, ['surfaceId','path','value']) || (payload.containsKey('path') && payload['path'] is! String)) throw FormatException('Invalid data update');
      final data = _update(surface.data, payload['path'] as String? ?? '/', payload['value'], !payload.containsKey('value'));
      _root(surface.components, data); surface.data = data; return;
    }
    final list = payload['components'];
    if (!_only(payload, ['surfaceId', 'components']) || list is! List || list.isEmpty || list.length > 1000) throw FormatException('Invalid components');
    final components = Map<String, Map<String, dynamic>>.from(surface.components);
    for (final value in list) {
      final component = _object(value); _validate(component);
      components[component['id'] as String] = _object(jsonDecode(jsonEncode(component)));
    }
    if (components.length > 1000) throw FormatException('Too many components');
    _root(components, surface.data); surface.components = components; surface.revision = ++_revision;
  }
  void writeField(String surfaceId, String componentId, int revision, String value) {
    final surface=_surfaces[surfaceId], c=surface?.components[componentId];
    if (surface==null || surface.revision!=revision || c==null || c['component']!='TextField') throw FormatException('Stale or unknown field');
    final data=_update(surface.data, (c['value'] as Map)['path'] as String, value, false);
    _root(surface.components,data); surface.data=data;
  }
  Map<String,dynamic> action(String surfaceId, String componentId, int revision) {
    final surface=_surfaces[surfaceId], c=surface?.components[componentId];
    if (surface==null || surface.revision!=revision || c==null || c['component']!='Button') throw FormatException('Stale or unknown button');
    final event=(c['action'] as Map)['event'] as Map, context=<String,dynamic>{};
    for (final entry in ((event['context'] as Map?) ?? {}).entries) {
      final value=entry.value is Map ? _read(surface.data, (entry.value as Map)['path'] as String) : entry.value;
      if (identical(value,_missing)) throw FormatException('Action context path not found');
      context[entry.key as String]=_export(_copy(value));
    }
    return {'version':'v0.9.1','action':{'name':event['name'],'surfaceId':surfaceId,'sourceComponentId':componentId,'timestamp':DateTime.now().toUtc().toIso8601String(),'context':context}};
  }
  List<SurfaceView> views() => _surfaces.values.map((surface)=>SurfaceView(surface.id,surface.revision,_root(surface.components,surface.data))).toList();
  List<NativeNode?> snapshot() => _surfaces.values.map((surface) => _root(surface.components, surface.data)).toList();
  void _validate(Map<String, dynamic> c) {
    if (!_id(c['id'])) throw FormatException('Invalid component');
    final type = c['component'];
    if (type == 'Text') {
      final text = c['text'];
      var validText = text is String && text.length <= 10000;
      if (text is Map && _only(_object(text), ['path']) && text['path'] is String) {_pointer(text['path'] as String); validText = true;}
      if (!_only(c, ['id','component','text','variant']) || !validText || (c.containsKey('variant') && !['h1','h2','h3','h4','h5','body','caption'].contains(c['variant']))) throw FormatException('Unsupported Text');
    } else if (type == 'Column' || type == 'Row') {
      final children = c['children'];
      if (!_only(c, ['id','component','children','justify','align']) || children is! List || children.length > 1000 || !children.every(_id) || (c.containsKey('justify') && !['start','center','end','spaceBetween','spaceAround','spaceEvenly'].contains(c['justify'])) || (c.containsKey('align') && !['start','center','end'].contains(c['align']))) throw FormatException('Unsupported layout');
    } else if (type == 'TextField') {
      final value=c['value'];
      if (!_only(c,['id','component','label','value','variant']) || c['label'] is! String || value is! Map || !_only(_object(value),['path']) || value['path'] is! String || _pointer(value['path'] as String).isEmpty || (c.containsKey('variant') && !['shortText','longText'].contains(c['variant']))) throw FormatException('Unsupported TextField');
    } else if (type == 'Button') {
      final action=c['action'];
      if (!_only(c,['id','component','child','action','variant']) || !_id(c['child']) || (c.containsKey('variant') && !['default','primary','borderless'].contains(c['variant'])) || action is! Map || !_only(_object(action),['event']) || action['event'] is! Map) throw FormatException('Unsupported Button');
      final event=_object(action['event']);
      if (!_only(event,['name','context']) || !_id(event['name']) || (event.containsKey('context') && event['context'] is! Map)) throw FormatException('Unsupported action');
      for (final entry in _object(event['context'] ?? {}).entries) {
        if (['__proto__','prototype','constructor'].contains(entry.key)) throw FormatException('Unsafe action context');
        final value=entry.value;
        if (value is Map) {if (!_only(_object(value),['path']) || value['path'] is! String) throw FormatException('Unsupported action context'); _pointer(value['path'] as String);}
        else if (value!=null && value is! String && value is! bool && (value is! num || !value.isFinite)) throw FormatException('Unsupported action context');
      }
    } else if (type == 'Card') {
      if (!_only(c, ['id','component','child']) || !_id(c['child'])) throw FormatException('Unsupported Card');
    } else {throw FormatException('Unsupported component');}
  }
  NativeNode? _root(Map<String, Map<String, dynamic>> components, dynamic data) {
    if (!components.containsKey('root')) return null;
    var count = 0;
    NativeNode? visit(String id, Set<String> ancestors) {
      if (++count > 5000) throw FormatException('Component tree too large');
      final c = components[id]; if (c == null) return null;
      if (ancestors.contains(id) || ancestors.length >= 100) throw FormatException('Cyclic or deeply nested components');
      final next = {...ancestors, id};
      final ids = c['component'] == 'Card' || c['component'] == 'Button' ? [c['child'] as String] : c['component'] == 'Column' || c['component'] == 'Row' ? List<String>.from(c['children'] as List) : <String>[];
      final rawText=c['text']; final bound = rawText is String ? rawText : rawText is Map ? _read(data, rawText['path'] as String) : null;
      final field=c['component']=='TextField' ? _read(data,(c['value'] as Map)['path'] as String) : null;
      return NativeNode(id, c['component'] as String, ids.map((child) => visit(child, next)).whereType<NativeNode>().toList(), text: c['component']=='Text' ? (bound is String ? bound : '') : null, label: c['label'] as String?, value: c['component']=='TextField' ? (field is String ? field : '') : null, variant: c['variant'] as String?, justify: c['justify'] as String?, align: c['align'] as String?);
    }
    return visit('root', {});
  }
}

/// Hosts an ordered message source; a new source must replay current surfaces.
class AppMixerA2UI extends StatefulWidget {
  const AppMixerA2UI({super.key, required this.subscribe, required this.onError, this.onAction});
  final A2UISubscribe subscribe;
  final void Function(Object error) onError;
  final void Function(Map<String,dynamic> action)? onAction;
  @override
  State<AppMixerA2UI> createState() => _AppMixerA2UIState();
}
class _AppMixerA2UIState extends State<AppMixerA2UI> {
  FlutterSurfaceStore _store = FlutterSurfaceStore();
  void Function()? _unsubscribe;
  var _generation = 0;
  @override
  void initState() {super.initState(); _connect();}
  @override
  void didUpdateWidget(covariant AppMixerA2UI oldWidget) {super.didUpdateWidget(oldWidget); if (oldWidget.subscribe != widget.subscribe) _connect();}
  void _connect() {
    final generation = ++_generation;
    _unsubscribe?.call(); _unsubscribe = null; _store = FlutterSurfaceStore();
    try {
      _unsubscribe = widget.subscribe((message) {
        if (!mounted || generation != _generation) return;
        try {_store.apply(message); setState(() {});} catch (error) {widget.onError(error);}
      });
    } catch (error) {widget.onError(error);}
  }
  @override
  void dispose() {_generation++; _unsubscribe?.call(); super.dispose();}
  @override
  Widget build(BuildContext context) {
    final store=_store, generation=_generation;
    return Column(children: store.views().map((surface)=>surface.root==null ? const SizedBox.shrink() : _widget(surface.root!,surface,store,generation,'root')).toList());
  }
  bool _containsTextField(NativeNode node) => node.kind=='TextField' || node.children.any(_containsTextField);
  Widget _widget(NativeNode node, SurfaceView surface, FlutterSurfaceStore store, int generation, String path) {
    if (node.kind == 'Text') return Semantics(header: node.variant?.startsWith('h') ?? false, child: Text(node.text ?? ''));
    final children=<Widget>[];
    for (var i=0;i<node.children.length;i++) {
      final child=node.children[i], rendered=_widget(child,surface,store,generation,'$path/$i');
      // Row gives non-flex children unbounded width. Material text inputs require a finite width.
      children.add(node.kind=='Row' && _containsTextField(child) ? Flexible(fit:FlexFit.loose,child:rendered) : rendered);
    }
    if (node.kind == 'TextField') return _BoundTextField(key:ValueKey((surface.id,path,node.id)),label:node.label ?? '',value:node.value ?? '',multiline:node.variant=='longText',onChanged:(value){
      if (!mounted || generation!=_generation || !identical(store,_store)) return;
      try {store.writeField(surface.id,node.id,surface.revision,value);setState(() {});} catch(error){widget.onError(error);}
    });
    if (node.kind == 'Button') return TextButton(onPressed:widget.onAction==null ? null : (){
      if (!mounted || generation!=_generation || !identical(store,_store) || widget.onAction==null) return;
      try {widget.onAction!(store.action(surface.id,node.id,surface.revision));} catch(error){widget.onError(error);}
    },child:children.isEmpty ? const SizedBox.shrink() : children.first);
    if (node.kind == 'Card') return Card(child:children.isEmpty ? const SizedBox.shrink() : children.first);
    final main = {'start':MainAxisAlignment.start,'center':MainAxisAlignment.center,'end':MainAxisAlignment.end,'spaceBetween':MainAxisAlignment.spaceBetween,'spaceAround':MainAxisAlignment.spaceAround,'spaceEvenly':MainAxisAlignment.spaceEvenly}[node.justify] ?? MainAxisAlignment.start;
    final cross = {'start':CrossAxisAlignment.start,'center':CrossAxisAlignment.center,'end':CrossAxisAlignment.end}[node.align] ?? CrossAxisAlignment.center;
    return node.kind == 'Row' ? Row(mainAxisSize:MainAxisSize.min,mainAxisAlignment:main,crossAxisAlignment:cross,children:children) : Column(mainAxisSize:MainAxisSize.min,mainAxisAlignment:main,crossAxisAlignment:cross,children:children);
  }
}

class _BoundTextField extends StatefulWidget {
  const _BoundTextField({super.key,required this.label,required this.value,required this.multiline,required this.onChanged});
  final String label,value;
  final bool multiline;
  final ValueChanged<String> onChanged;
  @override
  State<_BoundTextField> createState()=>_BoundTextFieldState();
}
class _BoundTextFieldState extends State<_BoundTextField> {
  late final TextEditingController _controller;
  @override
  void initState(){super.initState();_controller=TextEditingController(text:widget.value);}
  @override
  void didUpdateWidget(covariant _BoundTextField oldWidget){
    super.didUpdateWidget(oldWidget);
    if(_controller.text!=widget.value){
      final offset=_controller.selection.baseOffset.clamp(0,widget.value.length).toInt();
      _controller.value=TextEditingValue(text:widget.value,selection:TextSelection.collapsed(offset:offset));
    }
  }
  @override
  void dispose(){_controller.dispose();super.dispose();}
  @override
  Widget build(BuildContext context)=>TextField(controller:_controller,decoration:InputDecoration(labelText:widget.label),maxLines:widget.multiline?null:1,onChanged:widget.onChanged);
}
