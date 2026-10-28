/** An intentionally limited renderer for A2UI v0.9.1 basic catalog messages. */
export const APP_MIXER_CATALOG = 'https://raw.githubusercontent.com/bassemZohdy/app-mixer/main/packages/web/catalog/v1/catalog.json';
/** The standard catalog is accepted for backward compatibility, but only a subset is implemented. */
export const BASIC_CATALOG = 'https://a2ui.org/specification/v0_9_1/catalogs/basic/catalog.json';
type Obj = Record<string, unknown>;
export type ActionMessage = {version:'v0.9.1'; action:{name:string;surfaceId:string;sourceComponentId:string;timestamp:string;context:Record<string, unknown>}};
type Interaction = {write: (path: string, value: string, input: HTMLInputElement | HTMLTextAreaElement) => void; action: (name: string, context: Obj) => void; controls: Map<string, HTMLInputElement | HTMLTextAreaElement>; enabled: boolean};
type Renderer = (component: Obj, renderChild: (id: string) => HTMLElement, data: unknown, document: Document, interaction: Interaction) => HTMLElement;
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
    if (!Object.hasOwn(current, key) || (current as Record<string, unknown>)[key] === undefined) {
      if (remove) return root;
      if (Array.isArray(current)) throw Error('Invalid array index');
      current[key] = {};
    }
    current = (current as Record<string, unknown>)[key];
  }
  if (!obj(current) && !Array.isArray(current)) throw Error('Data path parent does not exist');
  const last = keys[keys.length - 1];
  if (Array.isArray(current)) {
    if (!/^(0|[1-9]\d*)$/.test(last) || Number(last) >= current.length) throw Error('Invalid array index');
    if (remove) current[Number(last)] = undefined; else current[Number(last)] = structuredClone(value);
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
    if (!only(c, ['id','component','children','justify','align'])) throw Error('Unsupported layout property');
    const justify: Record<string,string> = {start:'flex-start',center:'center',end:'flex-end',spaceBetween:'space-between',spaceAround:'space-around',spaceEvenly:'space-evenly'};
    const align: Record<string,string> = {start:'flex-start',center:'center',end:'flex-end',stretch:'stretch'};
    if (c.justify !== undefined && (typeof c.justify !== 'string' || !Object.hasOwn(justify,c.justify))) throw Error('Invalid justify');
    if (c.align !== undefined && (typeof c.align !== 'string' || !Object.hasOwn(align,c.align))) throw Error('Invalid align');
    const element = doc.createElement('div');
    element.style.display = 'flex'; element.style.flexDirection = type === 'Column' ? 'column' : 'row';
    if (typeof c.justify === 'string') element.style.justifyContent = justify[c.justify];
    if (typeof c.align === 'string') element.style.alignItems = align[c.align];
    for (const childId of children(c)) element.appendChild(child(childId));
    return element;
  });
  registry.register('Card', (c, child, _data, doc) => {
    if (!only(c, ['id','component','child'])) throw Error('Unsupported Card property');
    if (!id(c.child)) throw Error('Invalid Card child');
    const element = doc.createElement('section'); element.appendChild(child(c.child)); return element;
  });
  registry.register('TextField', (c, _child, data, doc, interaction) => {
    if (!only(c, ['id','component','label','value','variant'])) throw Error('Unsupported TextField property');
    if (typeof c.label !== 'string' || !obj(c.value) || !only(c.value, ['path']) || typeof c.value.path !== 'string') throw Error('Invalid TextField');
    const path = c.value.path;
    if (pointer(path).length === 0) throw Error('TextField requires a non-root path');
    if (c.variant !== undefined && c.variant !== 'shortText' && c.variant !== 'longText') throw Error('Unsupported TextField variant');
    const wrapper = doc.createElement('label');
    const label = doc.createElement('span'); label.textContent = c.label; wrapper.appendChild(label);
    const input = c.variant === 'longText' ? doc.createElement('textarea') : doc.createElement('input');
    input.value = textValue(c.value, data);
    let composing = false;
    input.addEventListener('compositionstart', () => { composing = true; });
    input.addEventListener('compositionend', () => { composing = false; interaction.write(path, input.value, input); });
    input.addEventListener('input', () => { if (!composing) interaction.write(path, input.value, input); });
    interaction.controls.set(c.id as string, input);
    wrapper.appendChild(input); return wrapper;
  });
  registry.register('Button', (c, child, _data, doc, interaction) => {
    if (!only(c, ['id','component','child','action','variant']) || !id(c.child)) throw Error('Invalid Button');
    if (c.variant !== undefined && !['default','primary','borderless'].includes(c.variant as string)) throw Error('Unsupported Button variant');
    if (!obj(c.action) || !only(c.action, ['event']) || !obj(c.action.event) || !only(c.action.event, ['name','context']) || !id(c.action.event.name) || (c.action.event.context !== undefined && !obj(c.action.event.context))) throw Error('Unsupported Button action');
    const event = c.action.event;
    const context = (event.context ?? {}) as Obj;
    for (const value of Object.values(context)) {
      if (obj(value)) {
        if (!only(value, ['path']) || typeof value.path !== 'string') throw Error('Unsupported action context');
        pointer(value.path);
      } else if (value !== null && !['string','number','boolean'].includes(typeof value)) throw Error('Unsupported action context');
    }
    const button = doc.createElement('button'); button.type = 'button'; button.disabled = !interaction.enabled;
    button.appendChild(child(c.child));
    button.addEventListener('click', () => interaction.action(event.name as string, context));
    return button;
  });
  return registry;
}
type Surface = { element: HTMLElement; components: Map<string, Obj>; data: unknown; controls: Map<string, HTMLInputElement | HTMLTextAreaElement> };
export class A2UIRenderer {
  private readonly surfaces = new Map<string, Surface>();
  constructor(private readonly host: HTMLElement, private readonly registry = basicRegistry(), private readonly onAction?: (message: ActionMessage) => void) {}
  apply(message: unknown): void {
    if (!obj(message) || message.version !== 'v0.9.1') throw Error('Unsupported A2UI version');
    const keys = ['createSurface','updateComponents','updateDataModel','deleteSurface'].filter(k => Object.hasOwn(message, k));
    if (keys.length !== 1 || !only(message, ['version',keys[0]]) || !obj(message[keys[0]])) throw Error('Invalid A2UI message');
    const kind = keys[0], payload = message[kind] as Obj;
    if (!id(payload.surfaceId)) throw Error('Invalid surface ID');
    const surfaceId = payload.surfaceId;
    if (kind === 'createSurface') {
      if (this.surfaces.size >= 100) throw Error('Too many surfaces');
      if (!only(payload, ['surfaceId','catalogId'])) throw Error('Unsupported surface property');
      if (payload.catalogId !== BASIC_CATALOG && payload.catalogId !== APP_MIXER_CATALOG) throw Error('Unsupported catalog');
      if (this.surfaces.has(surfaceId)) throw Error('Surface already exists');
      const element = this.host.ownerDocument.createElement('div');
      element.dataset.surfaceId = surfaceId; this.host.appendChild(element);
      this.surfaces.set(surfaceId, {element, components:new Map(), data:{}, controls:new Map()}); return;
    }
    const surface = this.surfaces.get(surfaceId);
    if (!surface) throw Error('Unknown surface');
    if (kind === 'deleteSurface') { if (!only(payload, ['surfaceId'])) throw Error('Unsupported delete property'); surface.element.remove(); this.surfaces.delete(surfaceId); return; }
    let components = surface.components, data = surface.data;
    if (kind === 'updateComponents') {
      if (!only(payload, ['surfaceId','components'])) throw Error('Unsupported components property');
      if (!Array.isArray(payload.components) || payload.components.length < 1 || payload.components.length > 1000) throw Error('Invalid components');
      components = new Map(surface.components);
      for (const c of payload.components) {
        if (!obj(c) || !id(c.id) || !id(c.component) || !this.registry.get(c.component)) throw Error('Unsupported component');
        components.set(c.id, structuredClone(c));
      }
      if (components.size > 1000) throw Error('Too many components');
    } else {
      if (!only(payload, ['surfaceId','path','value'])) throw Error('Unsupported data property');
      if (payload.path !== undefined && typeof payload.path !== 'string') throw Error('Invalid data path');
      data = update(surface.data, (payload.path as string | undefined) ?? '/', payload.value, !Object.hasOwn(payload,'value') || payload.value === undefined);
    }
    const doc = this.host.ownerDocument;
    const controls = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
    let renderedCount = 0;
    const render = (componentId: string, visited: Set<string>): HTMLElement => {
      if (++renderedCount > 5000) throw Error('Component tree too large');
      const c = components.get(componentId);
      if (!c) { const placeholder = doc.createElement('span'); placeholder.textContent = ''; return placeholder; }
      if (visited.has(componentId) || visited.size >= 100) throw Error('Cyclic or deeply nested components');
      const next = new Set(visited); next.add(componentId);
      const interaction: Interaction = {
        controls, enabled: !!this.onAction,
        write: (path, value, input) => {
          if (this.surfaces.get(surfaceId) !== surface || surface.controls.get(componentId) !== input) return;
          const focused = input.ownerDocument.activeElement === input;
          const start = input.selectionStart, end = input.selectionEnd;
          this.apply({version:'v0.9.1', updateDataModel:{surfaceId,path,value}});
          const replacement = surface.controls.get(componentId);
          if (replacement && focused) {
            replacement.focus();
            if (start !== null && end !== null) replacement.setSelectionRange(start, end);
          }
        },
        action: (name, context) => {
          if (this.surfaces.get(surfaceId) !== surface || !this.onAction) return;
          const resolved: Obj = {};
          for (const [key, value] of Object.entries(context)) {
            if (['__proto__','prototype','constructor'].includes(key)) throw Error('Unsafe action context');
            const result = obj(value) ? read(surface.data, value.path as string) : value;
            if (result === undefined) throw Error('Action context path not found');
            resolved[key] = structuredClone(result);
          }
          this.onAction({version:'v0.9.1', action:{name,surfaceId,sourceComponentId:componentId,timestamp:new Date().toISOString(),context:resolved}});
        }
      };
      return this.registry.get(c.component as string)!(c, child => render(child, next), data, doc, interaction);
    };
    // Construct detached first, so invalid updates leave the previous UI and state intact.
    const root = components.has('root') ? render('root', new Set()) : undefined;
    surface.element.replaceChildren(...(root ? [root] : []));
    surface.components = components; surface.data = data; surface.controls = controls;
  }
}

/** Incrementally frames already-decoded A2UI JSONL text into renderer messages. */
export class A2UIJsonLines {
  private buffer = '';
  private closed = false;
  constructor(private readonly renderer: A2UIRenderer, private readonly maxLineLength = 1024 * 1024) {
    if (!Number.isSafeInteger(maxLineLength) || maxLineLength < 1) throw Error('Invalid line limit');
  }
  write(chunk: string): void {
    if (this.closed) throw Error('Stream is closed');
    if (typeof chunk !== 'string') throw Error('Expected decoded text');
    this.buffer += chunk;
    try {
      let newline: number;
      while ((newline = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        this.process(line);
      }
      if (this.buffer.length > this.maxLineLength) throw Error('A2UI line too long');
    } catch (error) { this.closed = true; this.buffer = ''; throw error; }
  }
  finish(): void {
    if (this.closed) throw Error('Stream is closed');
    this.closed = true;
    const line = this.buffer; this.buffer = '';
    if (line.length) this.process(line);
  }
  private process(line: string): void {
    if (line.length > this.maxLineLength) throw Error('A2UI line too long');
    if (!line.trim()) return;
    this.renderer.apply(JSON.parse(line) as unknown);
  }
}
