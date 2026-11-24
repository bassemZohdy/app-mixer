import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

// Components that the shared Flutter/native fixtures do not cover yet, with the reason.
// The test fails when a listed component appears in a fixture (remove it here) and when a component is missing without being listed.
const KNOWN_GAPS = {
  Progress: [
    'layout.json is compared against domTree/nativeTree (packages/native/test/parity.test.mjs) and tree() (adapters/flutter/test/renderer_test.dart);',
    'bindings.json compares the root text. Neither helper models Progress, and the Flutter tests cannot be run here.',
    'Flutter covers Progress in adapters/flutter/test/parity_scenario.dart.'
  ].join(' ')
};

const fixturesUrl = new URL('../../../adapters/flutter/test/fixtures/', import.meta.url);
const readJson = async url => JSON.parse(await readFile(url, 'utf8'));
const collect = (value, found) => {
  if (Array.isArray(value)) for (const item of value) collect(item, found);
  else if (value && typeof value === 'object') {
    if (typeof value.component === 'string') found.add(value.component);
    for (const item of Object.values(value)) collect(item, found);
  }
  return found;
};

test('every catalog component is in a shared fixture or an explicit known gap', async () => {
  const catalog = await readJson(new URL('../catalog/v1/catalog.json', import.meta.url));
  const components = Object.keys(catalog.components);
  assert.ok(components.length > 0);
  const files = (await readdir(fixturesUrl)).filter(name => name.endsWith('.json')).sort();
  assert.ok(files.length > 0, 'shared fixtures exist');
  const used = new Set();
  for (const file of files) collect(await readJson(new URL(file, fixturesUrl)), used);
  for (const name of Object.keys(KNOWN_GAPS)) assert.ok(components.includes(name), `${name} in KNOWN_GAPS is not a catalog component`);
  for (const name of components) {
    if (name in KNOWN_GAPS) assert.equal(used.has(name), false, `${name} is now in a shared fixture: remove it from KNOWN_GAPS`);
    else assert.equal(used.has(name), true, `${name} is in the catalog but in no shared fixture under adapters/flutter/test/fixtures`);
  }
});

test('every catalog component is exercised by the web conformance or renderer tests', async () => {
  const catalog = await readJson(new URL('../catalog/v1/catalog.json', import.meta.url));
  const sources = (await Promise.all(['conformance.test.mjs', 'renderer.test.mjs'].map(name => readFile(new URL(name, import.meta.url), 'utf8')))).join('\n');
  for (const name of Object.keys(catalog.components)) assert.match(sources, new RegExp(`component: '${name}'`), `${name} is not rendered by the conformance or renderer tests`);
});
