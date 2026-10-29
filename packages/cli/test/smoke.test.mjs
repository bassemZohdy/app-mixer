import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
    const html = await page.text();
    assert.match(html, /Workspace/);
    assert.match(html, /A2UIRenderer/);
    const renderer = await fetch(`${url}/renderer.mjs`);
    assert.equal(renderer.status, 200);
    assert.match(renderer.headers.get('content-type'), /text\/javascript/);
    assert.match(await renderer.text(), /class A2UIRenderer/);
    // Execute the actual generated module script against a minimal DOM and the running server.
    class Element {
      constructor(doc) { this.ownerDocument=doc; this.children=[]; this.style={}; this.dataset={}; this.textContent=''; }
      appendChild(child) { this.children.push(child); return child; }
      replaceChildren(...children) { this.children=children; }
    }
    const doc = {createElement: () => new Element(doc), getElementById: () => host};
    const host = new Element(doc);
    const module = await import(pathToFileURL(join(target, 'renderer.mjs')).href);
    const workspace = await import(pathToFileURL(join(target, 'workspace.mjs')).href);
    const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script);
    const executable = script.replace(/^import [^;]+;\s*/gm, '');
    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
    await new AsyncFunction('document', 'fetch', 'A2UIRenderer', 'APP_MIXER_CATALOG', 'prepareWorkspace', 'initializeOfflinePublication', executable)(
      doc, path => fetch(new URL(path, url)), module.A2UIRenderer, module.APP_MIXER_CATALOG, workspace.prepareWorkspace, async()=>null
    );
    const rendered = host.children[0].children[0];
    assert.equal(rendered.children[0].textContent, 'Home');
    assert.equal(rendered.children[1].textContent, 'Welcome to App Mixer');
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
