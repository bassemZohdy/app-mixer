/** An intentionally limited renderer for A2UI v0.9.1 basic catalog messages. */
export const BASIC_CATALOG = 'https://a2ui.org/specification/v0_9_1/catalogs/basic/catalog.json';
type Obj = Record<string, unknown>;
type Renderer = (component: Obj, renderChild: (id: string) => HTMLElement, data: unknown, document: Document) => HTMLElement;
const obj = (x: unknown): x is Obj => x !== null && typeof x === 'object' && !Array.isArray(x);
const only = (value: Obj, keys: string[]): boolean => Object.keys(value).every(key => keys.includes(key));
const id = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 256;
function pointer(path: string): string[] {
  if (path === '' || path === '/') return [];
  if (!path.startsWith('/')) throw Error('Only absolute JSON pointers are supported');
  return path.slice(1).split('/').map(x => {
    if (/~(?![01])/.test(x)) throw Error('Invalid JSON pointer');
    const segment = x.replace(/~1/g, '/').replace(/~0/g, '~');
    if (['__proto__', 'prototype', 'constructor'].includes(segment)) throw Error('Unsafe JSON pointer');
    return segment;
  });
}
function read(data: unknown, path: string): unknown {
  let result = data;
  for (const key of pointer(path)) {
    if (!obj(result) && !Array.isArray(result)) return undefined;
    if (!Object.hasOwn(result, key)) return undefined;
    result = (result as Record<string, unknown>)[key];
  }
  return result;
}
function update(data: unknown, path: string, value: unknown, remove: boolean): unknown {
  const keys = pointer(path);
  if (!keys.length) return remove ? {} : structuredClone(value);
  const root: unknown = structuredClone(data);
  let current: unknown = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!obj(current) && !Array.isArray(current)) throw Error('Data path parent does not exist');
    if (!Object.hasOwn(current, key)) throw Error('Data path parent does not exist');
    current = (current as Record<string, unknown>)[key];
  }
  if (!obj(current) && !Array.isArray(current)) throw Error('Data path parent does not exist');
  const last = keys[keys.length - 1];
  if (Array.isArray(current)) {
    if (!/^(0|[1-9]\d*)$/.test(last) || Number(last) >= current.length) throw Error('Invalid array index');
    if (remove) current.splice(Number(last), 1); else current[Number(last)] = structuredClone(value);
  } else if (remove) delete current[last]; else current[last] = structuredClone(value);
  return root;
}
function textValue(value: unknown, data: unknown): string {
  const result = typeof value === 'string' ? value : obj(value) && typeof value.path === 'string' ? read(data, value.path) : undefined;
  return typeof result === 'string' ? result : '';
}
function children(c: Obj): string[] {
  if (!Array.isArray(c.children) || !c.children.every(id)) throw Error('Invalid children');
  return c.children;
}
/** Only trusted application code may register render functions; incoming messages cannot execute code. */
export class ComponentRegistry {
  private readonly entries = new Map<string, Renderer>();
  register(name: string, renderer: Renderer): this {
    if (!id(name) || typeof renderer !== 'function' || this.entries.has(name)) throw Error('Invalid or duplicate component');
    this.entries.set(name, renderer); return this;
  }
  get(name: string): Renderer | undefined { return this.entries.get(name); }
}
export function basicRegistry(): ComponentRegistry {
  const registry = new ComponentRegistry();
  registry.register('Text', (c, _child, data, doc) => {
    if (!only(c, ['id','component','text','variant'])) throw Error('Unsupported Text property');
    if (c.variant !== undefined && !['h1','h2','h3','h4','h5','caption','body'].includes(c.variant as string)) throw Error('Unsupported Text variant');
    if (!(typeof c.text === 'string' || (obj(c.text) && typeof c.text.path === 'string'))) throw Error('Invalid Text');
    const variants: Record<string,string> = {h1:'h1', h2:'h2', h3:'h3', h4:'h4', h5:'h5', caption:'small', body:'p'};
    const tag = typeof c.variant === 'string' && Object.hasOwn(variants, c.variant) ? variants[c.variant] : 'p';
    const element = doc.createElement(tag); element.textContent = textValue(c.text, data); return element;
  });
  for (const type of ['Column', 'Row']) registry.register(type, (c, child, _data, doc) => {
    if (!only(c, ['id','component','children'])) throw Error('Unsupported layout property');
    const element = doc.createElement('div');
    element.style.display = 'flex'; element.style.flexDirection = type === 'Column' ? 'column' : 'row';
    for (const childId of children(c)) element.appendChild(child(childId));
    return element;
  });
  registry.register('Card', (c, child, _data, doc) => {
    if (!only(c, ['id','component','child'])) throw Error('Unsupported Card property');
    if (!id(c.child)) throw Error('Invalid Card child');
    const element = doc.createElement('section'); element.appendChild(child(c.child)); return element;
  });
  return registry;
}
type Surface = { element: HTMLElement; components: Map<string, Obj>; data: unknown };
export class A2UIRenderer {
  private readonly surfaces = new Map<string, Surface>();
  constructor(private readonly host: HTMLElement, private readonly registry = basicRegistry()) {}
  apply(message: unknown): void {
    if (!obj(message) || message.version !== 'v0.9.1') throw Error('Unsupported A2UI version');
    const keys = ['createSurface','updateComponents','updateDataModel','deleteSurface'].filter(k => Object.hasOwn(message, k));
    if (keys.length !== 1 || !obj(message[keys[0]])) throw Error('Invalid A2UI message');
    const kind = keys[0], payload = message[kind] as Obj;
    if (!id(payload.surfaceId)) throw Error('Invalid surface ID');
    const surfaceId = payload.surfaceId;
    if (kind === 'createSurface') {
      if (!only(payload, ['surfaceId','catalogId'])) throw Error('Unsupported surface property');
      if (payload.catalogId !== BASIC_CATALOG) throw Error('Unsupported catalog');
      if (this.surfaces.has(surfaceId)) throw Error('Surface already exists');
      const element = this.host.ownerDocument.createElement('div');
      element.dataset.surfaceId = surfaceId; this.host.appendChild(element);
      this.surfaces.set(surfaceId, {element, components:new Map(), data:{}}); return;
    }
    const surface = this.surfaces.get(surfaceId);
    if (!surface) throw Error('Unknown surface');
    if (kind === 'deleteSurface') { if (!only(payload, ['surfaceId'])) throw Error('Unsupported delete property'); surface.element.remove(); this.surfaces.delete(surfaceId); return; }
    let components = surface.components, data = surface.data;
    if (kind === 'updateComponents') {
      if (!only(payload, ['surfaceId','components'])) throw Error('Unsupported components property');
      if (!Array.isArray(payload.components) || payload.components.length > 1000) throw Error('Invalid components');
      components = new Map(surface.components);
      for (const c of payload.components) {
        if (!obj(c) || !id(c.id) || !id(c.component) || !this.registry.get(c.component)) throw Error('Unsupported component');
        components.set(c.id, structuredClone(c));
      }
    } else {
      if (!only(payload, ['surfaceId','path','value'])) throw Error('Unsupported data property');
      if (payload.path !== undefined && typeof payload.path !== 'string') throw Error('Invalid data path');
      data = update(surface.data, (payload.path as string | undefined) ?? '/', payload.value, !Object.hasOwn(payload,'value'));
    }
    const doc = this.host.ownerDocument;
    const render = (componentId: string, visited: Set<string>): HTMLElement => {
      const c = components.get(componentId);
      if (!c) { const placeholder = doc.createElement('span'); placeholder.textContent = ''; return placeholder; }
      if (visited.has(componentId) || visited.size >= 100) throw Error('Cyclic or deeply nested components');
      const next = new Set(visited); next.add(componentId);
      return this.registry.get(c.component as string)!(c, child => render(child, next), data, doc);
    };
    // Construct detached first, so invalid updates leave the previous UI and state intact.
    const root = components.has('root') ? render('root', new Set()) : undefined;
    surface.element.replaceChildren(...(root ? [root] : []));
    surface.components = components; surface.data = data;
  }
}
