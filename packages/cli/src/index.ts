#!/usr/bin/env node
import { mkdir, writeFile, access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { realpathSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { signExtensionFiles, verifyExtensionFiles, checkExtensionFiles, checkExtensionSetFiles } from './extension-sign.js';
export async function createProject(name: string, parent = process.cwd()): Promise<string> {
  if (!/^[a-z][a-z0-9-]{1,48}$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(name)) throw Error('Invalid project name');
  const target = resolve(parent, name);
  try {
    await access(target);
    throw Error('Target exists');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  await mkdir(target);
  const manifest = {
    id: name,
    schemaVersion: 1,
    revision: 0,
    pages: [{ id: 'home', route: '/', title: 'Home', components: [{ id: 'intro', type: 'Text', props: { text: 'Welcome to App Mixer' } }] }]
  };
  const pageTemplate = await readFile(new URL('../templates/index.html', import.meta.url), 'utf8');
  const html = pageTemplate.replaceAll('__APP_ID__', JSON.stringify(name));
  const server = await readFile(new URL('../templates/server.mjs', import.meta.url));
  const capabilities = await readFile(new URL('../templates/capabilities.mjs', import.meta.url));
  const chat = await readFile(new URL('../templates/chat.mjs', import.meta.url));
  const extensions = await readFile(new URL('../templates/extensions.mjs', import.meta.url));
  const workspace = await readFile(new URL('../templates/workspace.mjs', import.meta.url));
  const rendererSource = await readFile(new URL(import.meta.resolve('@app-mixer/web')));
  const dataEditor = await readFile(new URL('../templates/data-editor.mjs', import.meta.url));
  const publicationTracing = await readFile(new URL('../templates/publication-tracing.mjs', import.meta.url));
  const stagedEditor = await readFile(new URL('../templates/staged-editor.mjs', import.meta.url));
  const offlineRuntime = await readFile(new URL('../templates/offline-runtime.mjs', import.meta.url));
  const publicationRuntime = await readFile(new URL('../templates/offline-publication-runtime.mjs', import.meta.url));
  const publicationHost = await readFile(new URL('../templates/offline-publication-host.mjs', import.meta.url));
  const publicationSource = await readFile(new URL(import.meta.resolve('@app-mixer/web/offline-publications')));
  const shellTemplate = await readFile(new URL('../templates/offline-shell.mjs', import.meta.url), 'utf8');
  const shellWorkerTemplate = await readFile(new URL('../templates/offline-shell-sw.js', import.meta.url), 'utf8');
  const offlineShell = shellTemplate.replace('__APP_ID__', JSON.stringify(name)),
    offlineShellWorker = shellWorkerTemplate.replace('__APP_ID__', JSON.stringify(name));
  const offlineURL = new URL(import.meta.resolve('@app-mixer/web/offline'));
  const [offlineSource, offlineWorker, offlineUI] = await Promise.all([readFile(offlineURL), readFile(new URL('./offline-worker.js', offlineURL)), readFile(new URL('./offline-ui.js', offlineURL))]);
  await Promise.all([
    writeFile(resolve(target, 'publication-tracing.mjs'), publicationTracing),
    writeFile(resolve(target, 'offline-publications.js'), publicationSource),
    writeFile(resolve(target, 'offline-publication-runtime.mjs'), publicationRuntime),
    writeFile(resolve(target, 'offline-publication-host.mjs'), publicationHost),
    writeFile(resolve(target, 'chat.mjs'), chat),
    writeFile(resolve(target, 'capabilities.mjs'), capabilities),
    writeFile(resolve(target, 'data-editor.mjs'), dataEditor),
    writeFile(resolve(target, 'staged-editor.mjs'), stagedEditor),
    writeFile(resolve(target, 'offline-runtime.mjs'), offlineRuntime),
    writeFile(resolve(target, 'offline-shell.mjs'), offlineShell),
    writeFile(resolve(target, 'offline-shell-sw.js'), offlineShellWorker),
    writeFile(resolve(target, 'offline.js'), offlineSource),
    writeFile(resolve(target, 'offline-worker.js'), offlineWorker),
    writeFile(resolve(target, 'offline-ui.js'), offlineUI),
    writeFile(resolve(target, 'renderer.mjs'), rendererSource),
    writeFile(resolve(target, 'workspace.mjs'), workspace),
    writeFile(resolve(target, 'extensions.mjs'), extensions),
    writeFile(resolve(target, 'package.json'), JSON.stringify({ name, private: true, type: 'module', scripts: { dev: 'node --env-file-if-exists=.env server.mjs' } }, null, 2)),
    writeFile(resolve(target, 'application.json'), JSON.stringify(manifest, null, 2)),
    writeFile(resolve(target, 'index.html'), html),
    writeFile(resolve(target, 'server.mjs'), server),
    writeFile(resolve(target, '.gitignore'), '.env' + String.fromCharCode(10)),
    writeFile(
      resolve(target, '.env.example'),
      'PORT=3000\nPUBLICATION_SCHEMA_VERSION=1\nDATA_PLANE_URL=\nWORKSPACE_TRACING_ENABLED=false\nWORKSPACE_TRACING_TRUST_INCOMING=false\nWORKSPACE_TRACING_PROPAGATE=false\n' +
        'WORKSPACE_TRACING_PROPAGATE_CAPABILITIES=false\nWORKSPACE_TRACING_PROPAGATE_AGENT=false\nAGENT_URL=\nAGENT_TOKEN=\nCAPABILITY_URL=\nCAPABILITY_TOKEN=\nCAPABILITY_TIMEOUT_MS=5000\n' +
        'CAPABILITY_RESPONSE_MAX_BYTES=1048576\nCAPABILITY_REQUEST_MAX_BYTES=1048576\n# CAPABILITY_MAX_IN_FLIGHT=10\n# CAPABILITY_UPLOAD_TIMEOUT_MS=5000\n'
    )
  ]);
  return target;
}
let isMain = false;
try {
  isMain = !!process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url);
} catch {}
const USAGE = [
  'create <name>',
  'extension-sign <manifest.json> <package-file> <private-key.pem> <key-id> <output.json>',
  'extension-verify <signed.json> <package-file> <public-key.pem> <key-id>',
  'extension-check <signed.json> <package-file> <public-key.pem> <key-id> <host.json> <requirements.json>',
  'extension-check-set <set.json> <host.json> <requirements.json>'
];
const usageText = 'Usage: app-mixer <command> [arguments]\n' + USAGE.map(line => '  ' + line).join('\n') + '\n  --version\n  --help';
if (isMain) {
  const [, , command, ...args] = process.argv;
  const fail = (e: Error) => {
    console.error(e.message);
    process.exitCode = 1;
  };
  if ((command === '--help' || command === '-h') && args.length === 0) console.log(usageText);
  else if (command === '--version' && args.length === 0) console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  else if (command === 'create' && args.length === 1) createProject(args[0]!).then(p => console.log('Created ' + p), fail);
  else if (command === 'extension-sign' && args.length === 5) signExtensionFiles(args[0]!, args[1]!, args[2]!, args[3]!, args[4]!).then(() => console.log('Signed extension manifest written'), fail);
  else if (command === 'extension-verify' && args.length === 4) verifyExtensionFiles(args[0]!, args[1]!, args[2]!, args[3]!).then(m => console.log(`Verified ${m.id}@${m.version} (${m.scope})`), fail);
  else if (command === 'extension-check' && args.length === 6)
    checkExtensionFiles(args[0]!, args[1]!, args[2]!, args[3]!, args[4]!, args[5]!).then(m => console.log(`Compatible ${m.id}@${m.version} (${m.scope})`), fail);
  else if (command === 'extension-check-set' && args.length === 3) checkExtensionSetFiles(args[0]!, args[1]!, args[2]!).then(m => console.log(`Compatible extensions: ${m.length}`), fail);
  else {
    console.error(usageText);
    process.exitCode = 1;
  }
}
