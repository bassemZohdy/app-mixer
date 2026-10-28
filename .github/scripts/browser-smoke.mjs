import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createProject } from '../../packages/cli/dist/index.js';

const exec = promisify(execFile);
const dir = await mkdtemp(join(tmpdir(), 'app-mixer-browser-'));
let server;
try {
  const target = await createProject('browser-test', dir);
  server = spawn(process.execPath, ['server.mjs'], {cwd:target, env:{...process.env,PORT:'0'}, stdio:['ignore','pipe','pipe']});
  const url = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(Error('Server startup timed out')), 10000);
    server.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('exit', code => { clearTimeout(timer); reject(Error(`Server exited before startup: ${code}`)); });
  });
  const {stdout} = await exec(process.env.CHROME_BIN || 'google-chrome', [
    '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--virtual-time-budget=5000', '--dump-dom', url
  ], {timeout:30000, maxBuffer:1024*1024});
  assert.match(stdout, /Welcome to App Mixer/);
  assert.match(stdout, /data-surface-id="workspace"/);
  console.log('Generated workspace rendered successfully in headless Chrome');
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = once(server, 'exit'); server.kill(); await exited;
  }
  await rm(dir, {recursive:true, force:true});
}
