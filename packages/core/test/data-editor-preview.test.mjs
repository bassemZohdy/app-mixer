import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { RECORD_EDITOR_PREVIEW } from '../dist/data-editor-preview.js';

// TASK-043: the preview shares its JSON Schema parser with the generated editor, so it must accept and bound `default` and `readOnly` alike.
const { createRecordEditor } = await import('data:text/javascript;base64,' + Buffer.from(RECORD_EDITOR_PREVIEW).toString('base64'));
const options = { getOperation: 'items.get', putOperation: 'items.put' };
const configure = property => createRecordEditor({ ...options, jsonSchema: { type: 'object', properties: { name: { type: 'string', ...property } }, required: ['name'] } });

test('the record editor preview accepts JSON Schema default and readOnly on scalar properties and array items', () => {
  for (const property of [{ default: 'Ada' }, { readOnly: true }, { default: 'Ada', readOnly: true }, { readOnly: false }, { enum: ['a', 'b'], default: 'b' }, { const: 'k', default: 'k' }])
    assert.doesNotThrow(() => configure(property), JSON.stringify(property));
  assert.doesNotThrow(() => createRecordEditor({ ...options, jsonSchema: { type: 'object', properties: { tags: { type: 'array', items: { type: 'string', default: 'new', readOnly: true } } } } }));
  assert.doesNotThrow(() => createRecordEditor({ ...options, jsonSchema: { type: 'object', properties: { nick: { type: ['string', 'null'], default: null } } } }));
  assert.doesNotThrow(() => createRecordEditor({ ...options, jsonSchema: { type: 'object', properties: { nothing: { type: 'null', default: null } } } }));
});

test('the record editor preview rejects a default the property would refuse and a non-boolean readOnly', () => {
  for (const property of [
    { default: 5 },
    { default: {} },
    { default: null },
    { default: '', minLength: 1 },
    { default: 'y', pattern: '^x' },
    { enum: ['a', 'b'], default: 'c' },
    { const: 'k', default: 'j' },
    { readOnly: 'yes' }
  ])
    assert.throws(() => configure(property), /Unsupported record JSON Schema form/, JSON.stringify(property));
  assert.throws(() => configure({ default: 'x'.repeat(3), maxLength: 2 }), /Unsupported record JSON Schema form/);
  assert.throws(() => createRecordEditor({ ...options, jsonSchema: { type: 'object', properties: { n: { type: 'integer', default: 1.5 } } } }), /Unsupported record JSON Schema form/);
  // Structured defaults and the flags on object or array properties stay refused: only scalar leaves and scalar items carry them.
  for (const jsonSchema of [
    { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' }, default: [] } } },
    { type: 'object', properties: { o: { type: 'object', properties: {}, default: {} } } },
    { type: 'object', properties: { o: { type: 'object', properties: {}, readOnly: true } } },
    { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' }, readOnly: true } } },
    { type: 'object', properties: { nothing: { type: 'null', default: 1 } } }
  ])
    assert.throws(() => createRecordEditor({ ...options, jsonSchema }), /Unsupported record JSON Schema form/, JSON.stringify(jsonSchema));
});

test('the record editor preview labels a read-only field and stays inert', () => {
  const dom = new JSDOM('<!doctype html>');
  try {
    const root = createRecordEditor({
        ...options,
        jsonSchema: { type: 'object', properties: { id: { type: 'string', readOnly: true }, name: { type: 'string', default: 'Ada' } }, required: ['name'] }
      }).render({}, null, null, dom.window.document),
      labels = [...root.querySelectorAll('label')];
    assert.match(labels.find(label => label.textContent.startsWith('id')).textContent, /^id \(read-only\)/);
    assert.match(labels.find(label => label.textContent.startsWith('name')).textContent, /^name \(required\)/);
    assert.ok([...root.querySelectorAll('button,input,select,textarea')].every(node => node.disabled));
  } finally {
    dom.window.close();
  }
});
