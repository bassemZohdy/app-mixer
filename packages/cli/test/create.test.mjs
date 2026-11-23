import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createProject } from '../dist/index.js';
const execFileAsync = promisify(execFile);
test('scaffolds runnable app', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'app-mixer-'));
  try {
    const target = await createProject('demo-app', dir);
    const a = JSON.parse(await readFile(join(target, 'application.json'), 'utf8'));
    assert.equal(a.pages[0].route, '/');
    await assert.rejects(createProject('demo-app', dir), /exists/);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
test('rejects path traversal', async () => {
  await assert.rejects(createProject('../bad'), /Invalid/);
});

// TASK-008: the scaffold sources are real template files now, so each one must parse on its own.
const scaffoldTemplates = ['server.mjs', 'capabilities.mjs', 'chat.mjs', 'extensions.mjs', 'workspace.mjs', 'index.html'];
for (const template of scaffoldTemplates) {
  test(`template ${template} passes a syntax check`, async () => {
    const path = join(import.meta.dirname, '..', 'templates', template);
    if (template.endsWith('.mjs')) {
      await execFileAsync(process.execPath, ['--check', path]);
      return;
    }
    // The page template is HTML; its inline module script is the executable part.
    const page = await readFile(path, 'utf8');
    const open = page.indexOf('<script type="module">');
    const close = page.indexOf('</script>', open);
    assert.ok(open !== -1 && close > open, 'the page template carries an inline module script');
    const dir = await mkdtemp(join(tmpdir(), 'app-mixer-template-'));
    try {
      const script = join(dir, 'inline.mjs');
      await writeFile(script, page.slice(open + '<script type="module">'.length, close));
      await execFileAsync(process.execPath, ['--check', script]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
}
