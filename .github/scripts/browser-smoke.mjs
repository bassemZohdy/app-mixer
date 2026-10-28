import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  const fixture = `<!doctype html><html><body data-result="pending"><main id="app"></main><script type="module">
    import {A2UIRenderer,BASIC_CATALOG,basicRegistry} from '/renderer.mjs';
    try {
      let event;
      const renderer = new A2UIRenderer(document.getElementById('app'),basicRegistry(),value => {event=value});
      const version='v0.9.1',surfaceId='fixture';
      renderer.apply({version,createSurface:{surfaceId,catalogId:BASIC_CATALOG}});
      renderer.apply({version,updateDataModel:{surfaceId,value:{form:{name:'Ada',secret:'private'}}}});
      renderer.apply({version,updateComponents:{surfaceId,components:[
        {id:'root',component:'Column',children:['field','display','button']},
        {id:'field',component:'TextField',label:'Name',value:{path:'/form/name'}},
        {id:'display',component:'Text',text:{path:'/form/name'}},
        {id:'button',component:'Button',child:'label',action:{event:{name:'save',context:{name:{path:'/form/name'}}}}},
        {id:'label',component:'Text',text:'Save'}
      ]}});
      const input=document.querySelector('input'); input.focus(); input.value='Grace'; input.setSelectionRange(5,5); input.dispatchEvent(new Event('input',{bubbles:true}));
      const updated=document.querySelector('input');
      if(document.activeElement!==updated || updated.selectionStart!==5 || document.querySelector('p').textContent!=='Grace') throw Error('Binding or focus failed');
      document.querySelector('button').click();
      if(event.action.context.name!=='Grace' || Object.hasOwn(event.action.context,'secret')) throw Error('Action context failed');
      document.body.dataset.result='pass';
    } catch(error) {document.body.dataset.result='fail'; document.body.append(String(error));}
  </script></body></html>`;
  await writeFile(join(target,'index.html'),fixture);
  const interactive = await exec(process.env.CHROME_BIN || 'google-chrome', [
    '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--virtual-time-budget=5000', '--dump-dom', url
  ], {timeout:30000,maxBuffer:1024*1024});
  assert.match(interactive.stdout, /<body data-result="pass">/);
  console.log('Generated workspace and interactive renderer passed in headless Chrome');
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = once(server, 'exit'); server.kill(); await exited;
  }
  await rm(dir, {recursive:true, force:true});
}
