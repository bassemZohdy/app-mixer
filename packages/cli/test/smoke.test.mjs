import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createProject } from '../dist/index.js';

test('generated app serves its workspace and definition', {timeout: 15000}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'app-mixer-smoke-'));
  let server;
  try {
    const target = await createProject('demo-app', dir);
    server = spawn(process.execPath, ['server.mjs'], {
      cwd: target, env: {...process.env, PORT: '0'}, stdio: ['ignore', 'pipe', 'pipe']
    });
    const url = await new Promise((resolve, reject) => {
      let output = '';
      server.stdout.on('data', chunk => {
        output += chunk;
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) resolve(match[0]);
      });
      server.once('error', reject);
      server.once('exit', code => reject(new Error(`Server exited before startup: ${code}`)));
    });
    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Workspace/);
    const definition = await fetch(`${url}/api/application`);
    assert.equal(definition.status, 200);
    assert.equal((await definition.json()).pages[0].route, '/');
    assert.equal((await fetch(`${url}/missing`)).status, 404);
  } finally {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
    await rm(dir, {recursive:true, force:true});
  }
});
