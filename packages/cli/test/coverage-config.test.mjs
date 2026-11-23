// FEAT-017: the coverage command, its per-package thresholds and the CI step that runs it stay wired together.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const packages = readFileSync(root + 'package.json', 'utf8');
const workflow = readFileSync(root + '.github/workflows/ci.yml', 'utf8');
const script = readFileSync(root + 'scripts/coverage.mjs', 'utf8');

test('FEAT-017 npm run coverage runs the coverage script', () => {
  const parsed = JSON.parse(packages);
  assert.equal(parsed.scripts.coverage, 'node scripts/coverage.mjs');
});

test('FEAT-017 CI runs the coverage command on one matrix leg', () => {
  assert.match(workflow, /run: npm run coverage\r?\n\s+if: matrix\.node == '22'/);
});

test('FEAT-017 every workspace package has a line and branch threshold and the run exits non-zero below it', () => {
  for (const name of ['core', 'cli', 'web', 'native', 'agent', 'shared']) assert.match(script, new RegExp(`^\\s{2}${name}: \\{ lines: \\d+, branches: \\d+ \\}`, 'm'), name + ' threshold');
  assert.match(script, /process\.exit\(1\)/);
  assert.match(script, /fell below the coverage threshold/);
});
