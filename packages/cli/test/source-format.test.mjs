// TASK-007: every source line stays within 200 characters; Prettier owns the rest of the layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const root = join(import.meta.dirname, '..', '..', '..');
const LIMIT = 200;
const sourceExtensions = new Set(['.ts', '.mts', '.mjs', '.js']);
const scopes = [join(root, 'packages'), join(root, 'deploy'), join(root, 'scripts')];
const skippedDirectories = new Set(['node_modules', 'dist', 'test', 'device-test']);
const generated = name => name.endsWith('-preview.ts');

function* walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) yield* walk(path);
    } else if (sourceExtensions.has(extname(entry.name))) yield path;
  }
}

test('TASK-007 no source line in packages, templates, deploy or scripts exceeds 200 characters', () => {
  const offenders = [];
  let scanned = 0;
  for (const path of walk(join(root, 'packages'))) {
    const relativePath = relative(root, path).replaceAll('\\', '/');
    // Test fixtures and device bundles are generated or pinned; the shipped source under src and templates is guarded.
    if (!relativePath.startsWith('packages/') || !relativePath.includes('/src/') || generated(relativePath)) continue;
    scanned++;
    const lines = readFileSync(path, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (line.length > LIMIT) offenders.push(`${relativePath}:${index + 1} (${line.length})`);
    });
  }
  for (const base of [join(root, 'packages', 'cli', 'templates'), ...scopes.slice(1)]) {
    for (const path of walk(base)) {
      const relativePath = relative(root, path).replaceAll('\\', '/');
      if (generated(relativePath)) continue;
      scanned++;
      const lines = readFileSync(path, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (line.length > LIMIT) offenders.push(`${relativePath}:${index + 1} (${line.length})`);
      });
    }
  }
  assert.ok(scanned > 200, `the scan covers the repository sources (${scanned} files)`);
  assert.deepEqual(offenders, [], `source lines over ${LIMIT} characters:\n${offenders.join('\n')}`);
});
