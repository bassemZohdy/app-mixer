
import { basicRegistry } from './renderer.mjs';
import { installedExtensions } from './extensions.mjs';
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export function prepareWorkspace(app) {
  if (!object(app) || ![1, 2].includes(app.schemaVersion) || !Array.isArray(app.pages) || !Array.isArray(app.extensions ?? [])) throw Error('Invalid application');
  const references = app.extensions ?? [],
    selected = new Map(),
    registry = basicRegistry();
  if (references.length > 256) throw Error('Too many extensions');
  for (const ref of references) {
    if (
      !object(ref) ||
      Object.keys(ref).length !== 3 ||
      typeof ref.id !== 'string' ||
      typeof ref.version !== 'string' ||
      !['platform', 'development', 'application'].includes(ref.scope) ||
      selected.has(ref.id)
    )
      throw Error('Invalid extension reference');
    const matches = installedExtensions.filter((item) => item.id === ref.id && item.version === ref.version && item.scope === ref.scope);
    if (matches.length !== 1 || !object(matches[0].components)) throw Error('Extension unavailable: ' + ref.id);
    selected.set(ref.id, matches[0]);
  }
  const components = [{ id: 'root', component: 'Column', children: [] }],
    registered = new Map(),
    pages = [];
  for (const [index, page] of app.pages.entries()) {
    if (
      !object(page) ||
      typeof page.title !== 'string' ||
      (app.schemaVersion === 1 && page.description !== undefined) ||
      (app.schemaVersion === 2 && (typeof page.description !== 'string' || page.description.length > 10000)) ||
      !Array.isArray(page.components)
    )
      throw Error('Invalid page');
    const ids = [],
      titleId = 'page-' + index;
    components[0].children.push(titleId);
    ids.push(titleId);
    components.push({ id: titleId, component: 'Text', text: page.title, variant: 'h2' });
    if (app.schemaVersion === 2 && page.description) {
      const descriptionId = 'page-' + index + '-description';
      components[0].children.push(descriptionId);
      ids.push(descriptionId);
      components.push({ id: descriptionId, component: 'Text', text: page.description });
    }
    for (const [itemIndex, item] of page.components.entries()) {
      if (!object(item)) throw Error('Invalid component');
      const itemId = 'page-' + index + '-item-' + itemIndex;
      components[0].children.push(itemId);
      ids.push(itemId);
      if (item.type === 'Text') {
        const props = item.props ?? {};
        if (Object.hasOwn(props, 'path')) {
          if (
            typeof props.path !== 'string' ||
            Object.hasOwn(props, 'text') ||
            Object.keys(props).some((key) => !['path', 'variant'].includes(key)) ||
            (props.variant !== undefined && !['h1', 'h2', 'h3', 'h4', 'h5', 'body', 'caption'].includes(props.variant))
          )
            throw Error('Invalid Text properties');
          components.push({ id: itemId, component: 'Text', text: { path: props.path }, ...(props.variant === undefined ? {} : { variant: props.variant }) });
        } else components.push({ id: itemId, component: 'Text', text: String(props.text ?? '') });
        continue;
      }
      if (item.type === 'Card') {
        const props = item.props ?? {};
        if (
          !props ||
          typeof props !== 'object' ||
          Array.isArray(props) ||
          Object.keys(props).some((key) => !['title', 'text'].includes(key)) ||
          (props.title !== undefined && (typeof props.title !== 'string' || props.title.length > 10000)) ||
          (props.text !== undefined && (typeof props.text !== 'string' || props.text.length > 10000))
        )
          throw Error('Invalid Card properties');
        const content = itemId + '-content',
          children = [];
        components.push({ id: itemId, component: 'Card', child: content }, { id: content, component: 'Column', children });
        if (props.title) {
          const title = content + '-title';
          children.push(title);
          components.push({ id: title, component: 'Text', text: props.title, variant: 'h3' });
        }
        if (props.text) {
          const text = content + '-text';
          children.push(text);
          components.push({ id: text, component: 'Text', text: props.text });
        }
        continue;
      }
      if (item.type === 'Input') {
        const props = item.props;
        if (
          !props ||
          typeof props !== 'object' ||
          Array.isArray(props) ||
          Object.keys(props).some((key) => !['label', 'path', 'variant'].includes(key)) ||
          typeof props.label !== 'string' ||
          typeof props.path !== 'string' ||
          (props.variant !== undefined && !['shortText', 'longText'].includes(props.variant))
        )
          throw Error('Invalid Input properties');
        components.push({
          id: itemId,
          component: 'TextField',
          label: props.label,
          value: { path: props.path },
          ...(props.variant === undefined ? {} : { variant: props.variant }),
        });
        continue;
      }
      if (item.type !== 'Extension' || typeof item.extensionId !== 'string' || typeof item.name !== 'string') throw Error('Unsupported component type: ' + item.type);
      const extension = selected.get(item.extensionId),
        binding = extension && Object.hasOwn(extension.components, item.name) ? extension.components[item.name] : undefined;
      if (!binding || typeof binding.render !== 'function' || (binding.validate !== undefined && typeof binding.validate !== 'function'))
        throw Error('Extension component unavailable: ' + item.name);
      const props = item.props ?? {};
      if (
        !object(props) ||
        Object.keys(props).length > 100 ||
        Object.entries(props).some(
          ([key, value]) =>
            ['id', 'component', '__proto__', 'prototype', 'constructor'].includes(key) ||
            !(typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))),
        )
      )
        throw Error('Invalid extension component properties');
      const rendered = { ...props, id: itemId, component: item.name };
      if (binding.validate) binding.validate(rendered);
      if (!registered.has(item.name)) {
        registry.register(item.name, binding.render, binding.validate);
        registered.set(item.name, item.extensionId);
      } else if (registered.get(item.name) !== item.extensionId) throw Error('Duplicate extension component: ' + item.name);
      components.push(rendered);
    }
    pages.push({ route: typeof page.route === 'string' && page.route.startsWith('/') ? page.route : '/page-' + index, title: page.title, ids });
  }
  return { registry, components, pages };
}
