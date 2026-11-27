import assert from 'node:assert/strict';

/**
 * Normalises what the web renderer drew into the shapes the shared fixtures under adapters/flutter/test/fixtures record.
 * Reads only what the fake elements of parity.test.mjs and jsdom nodes share (tagName in either case, children, textContent,
 * style and getAttribute), so the Angular DOM bridge smoke test (.github/scripts/angular-smoke.mjs) checks its real DOM with the
 * same functions instead of copying them.
 */

/** layout.json: a Card for a section, a Row or Column for a flex div, a Text for any other element and a Progress for the label/progress pair. */
export const domTree = node => {
  const tag = node.tagName.toLowerCase(),
    children = Array.from(node.children);
  if (tag === 'span' && !children.length && !node.textContent) return undefined;
  // Progress renders as a label wrapping its text and a progress element; the value attribute is absent while the bar is indeterminate.
  if (tag === 'label' && children[1]?.tagName.toLowerCase() === 'progress') {
    const bar = children[1],
      value = bar.getAttribute('value');
    return {
      kind: 'Progress',
      label: children[0].textContent,
      value: value === null ? null : Number(value),
      max: typeof bar.max === 'number' ? bar.max : Number(bar.getAttribute('max') ?? 100),
      children: []
    };
  }
  const kind = tag === 'section' ? 'Card' : tag === 'div' ? (node.style.flexDirection === 'row' ? 'Row' : 'Column') : 'Text';
  return {
    kind,
    ...(kind === 'Text' ? { text: node.textContent } : {}),
    // An unset CSS property reads as undefined on the fake elements and as '' on jsdom; both mean absent.
    ...(kind === 'Row' || kind === 'Column' ? { justify: node.style.justifyContent || null, align: node.style.alignItems || null } : {}),
    children: children.map(domTree).filter(Boolean)
  };
};

const textTags = { h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h4', h5: 'h5', small: 'caption', p: 'body' };

/** variants.json: as domTree, plus the variant read back from what was drawn: the heading or paragraph tag, textarea versus input. */
export const variantTree = node => {
  const tag = node.tagName.toLowerCase(),
    children = Array.from(node.children);
  if (tag === 'section') return { kind: 'Card', children: children.map(variantTree) };
  if (tag === 'div')
    return {
      kind: node.style.flexDirection === 'row' ? 'Row' : 'Column',
      justify: node.style.justifyContent || null,
      align: node.style.alignItems || null,
      children: children.map(variantTree)
    };
  if (tag === 'label' && children[1]?.tagName.toLowerCase() !== 'progress')
    return { kind: 'TextField', variant: children[1].tagName.toLowerCase() === 'textarea' ? 'longText' : 'shortText', label: children[0].textContent, children: [] };
  if (tag === 'button') return { kind: 'Button', children: children.map(variantTree) };
  assert.ok(Object.hasOwn(textTags, tag), 'unexpected element ' + tag);
  return { kind: 'Text', variant: textTags[tag], text: node.textContent, children: [] };
};

/** text-field.json: the state of a root column holding the field's label wrapper and a bound text. */
export const textFieldState = root => {
  if (!root) return { field: null, text: null };
  const wrapper = root.children[0],
    input = wrapper.children[1];
  return { field: { label: wrapper.children[0].textContent, value: input.value, variant: input.tagName.toLowerCase() === 'textarea' ? 'longText' : null }, text: root.children[1].textContent };
};
