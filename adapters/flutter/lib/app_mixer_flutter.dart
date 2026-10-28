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
dynamic _copy(dynamic value) => jsonDecode(jsonEncode(value));
dynamic _read(dynamic data, String path) {
  var value=data;
  for (final key in _pointer(path)) {
    if (value is Map) {if (!value.containsKey(key)) return null; value=value[key];}
    else if (value is List) {final index=int.tryParse(key);if (index==null || index<0 || index>=value.length || '$index'!=key) return null; value=value[index];}
    else {return null;}
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
      current=current[index];
    } else {throw FormatException('Data path parent does not exist');}
  }
  final last=keys.last;
  if (current is Map) {if(remove) {current.remove(last);} else {current[last]=_copy(value);}}
  else if (current is List) {final index=int.tryParse(last);if(index==null||index<0||index>=current.length||'$index'!=last)throw FormatException('Invalid array index');current[index]=remove?null:_copy(value);}
  else {throw FormatException('Data path parent does not exist');}
  return root;
}

class NativeNode {
  const NativeNode(this.id, this.kind, this.children, {this.text, this.variant, this.justify, this.align});
  final String id, kind;
  final List<NativeNode> children;
  final String? text, variant, justify, align;
}
class _Surface {
  _Surface(this.id);
  final String id;
  Map<String, Map<String, dynamic>> components = {};
  dynamic data = <String, dynamic>{};
}

/// Validates a bounded static subset and commits component updates atomically.
class FlutterSurfaceStore {
  final Map<String, _Surface> _surfaces = {};
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
      _surfaces[id] = _Surface(id); return;
    }
    final surface = _surfaces[id];
    if (surface == null) throw FormatException('Unknown surface');
    if (kind == 'deleteSurface') {
      if (!_only(payload, ['surfaceId'])) throw FormatException('Unsupported delete property');
      _surfaces.remove(id); return;
    }
    if (kind == 'updateDataModel') {
      if (!_only(payload, ['surfaceId','path','value']) || (payload['path'] != null && payload['path'] is! String)) throw FormatException('Invalid data update');
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
    _root(components, surface.data); surface.components = components;
  }
  List<NativeNode?> snapshot() => _surfaces.values.map((surface) => _root(surface.components, surface.data)).toList();
  void _validate(Map<String, dynamic> c) {
    if (!_id(c['id'])) throw FormatException('Invalid component');
    final type = c['component'];
    if (type == 'Text') {
      final text = c['text'];
      var validText = text is String && text.length <= 10000;
      if (text is Map && _only(_object(text), ['path']) && text['path'] is String) {_pointer(text['path'] as String); validText = true;}
      if (!_only(c, ['id','component','text','variant']) || !validText || (c['variant'] != null && !['h1','h2','h3','h4','h5','body','caption'].contains(c['variant']))) throw FormatException('Unsupported Text');
    } else if (type == 'Column' || type == 'Row') {
      final children = c['children'];
      if (!_only(c, ['id','component','children','justify','align']) || children is! List || children.length > 1000 || !children.every(_id) || (c['justify'] != null && !['start','center','end','spaceBetween','spaceAround','spaceEvenly'].contains(c['justify'])) || (c['align'] != null && !['start','center','end'].contains(c['align']))) throw FormatException('Unsupported layout');
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
      final ids = c['component'] == 'Card' ? [c['child'] as String] : c['component'] == 'Column' || c['component'] == 'Row' ? List<String>.from(c['children'] as List) : <String>[];
      final rawText=c['text']; final bound = rawText is String ? rawText : rawText is Map ? _read(data, rawText['path'] as String) : null;
      return NativeNode(id, c['component'] as String, ids.map((child) => visit(child, next)).whereType<NativeNode>().toList(), text: c['component']=='Text' ? (bound is String ? bound : '') : null, variant: c['variant'] as String?, justify: c['justify'] as String?, align: c['align'] as String?);
    }
    return visit('root', {});
  }
}

/// Hosts an ordered message source; a new source must replay current surfaces.
class AppMixerA2UI extends StatefulWidget {
  const AppMixerA2UI({super.key, required this.subscribe, required this.onError});
  final A2UISubscribe subscribe;
  final void Function(Object error) onError;
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
  Widget build(BuildContext context) => Column(children: _store.snapshot().map((node) => node == null ? const SizedBox.shrink() : _widget(node)).toList());
  Widget _widget(NativeNode node) {
    if (node.kind == 'Text') return Semantics(header: node.variant?.startsWith('h') ?? false, child: Text(node.text ?? ''));
    if (node.kind == 'Card') return Card(child: node.children.isEmpty ? const SizedBox.shrink() : _widget(node.children.first));
    final main = {'start':MainAxisAlignment.start,'center':MainAxisAlignment.center,'end':MainAxisAlignment.end,'spaceBetween':MainAxisAlignment.spaceBetween,'spaceAround':MainAxisAlignment.spaceAround,'spaceEvenly':MainAxisAlignment.spaceEvenly}[node.justify] ?? MainAxisAlignment.start;
    final cross = {'start':CrossAxisAlignment.start,'center':CrossAxisAlignment.center,'end':CrossAxisAlignment.end}[node.align] ?? CrossAxisAlignment.center;
    final children = node.children.map(_widget).toList();
    return node.kind == 'Row' ? Row(mainAxisSize:MainAxisSize.min,mainAxisAlignment:main,crossAxisAlignment:cross,children:children) : Column(mainAxisSize:MainAxisSize.min,mainAxisAlignment:main,crossAxisAlignment:cross,children:children);
  }
}
