import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createProject } from '../../packages/cli/dist/index.js';
import { createAGUIServer, LangGraphAGUIAdapter } from '../../packages/agent/dist/index.js';
import { ApplicationStore, createDevelopmentPlanes } from '../../packages/core/dist/index.js';

const exec = promisify(execFile);
const dir = await mkdtemp(join(tmpdir(), 'app-mixer-browser-'));
let server, agent, review;
try {
  const target = await createProject('browser-test', dir);
  const token='a-strong-local-token-at-least-32-characters';
  agent=createAGUIServer(new LangGraphAGUIAdapter({async *stream(){yield 'Hello from test';}}),token);
  agent.listen(0,'127.0.0.1'); await once(agent,'listening');
  server = spawn(process.execPath, ['server.mjs'], {cwd:target, env:{...process.env,PORT:'0',AGENT_URL:`http://127.0.0.1:${agent.address().port}/agent`,AGENT_TOKEN:token}, stdio:['ignore','pipe','pipe']});
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
    '--virtual-time-budget=5000', `--user-data-dir=${join(dir,'chrome-workspace')}`, '--dump-dom', url
  ], {timeout:45000, maxBuffer:1024*1024});
  assert.match(stdout, /Welcome to App Mixer/);
  assert.match(stdout, /data-surface-id="workspace"/);
  const appHTML=await readFile(join(target,'index.html'),'utf8');
  const driver=`<script>let submitted=false;const check=setInterval(()=>{const button=document.getElementById('chat-send');if(!button.disabled&&!submitted){submitted=true;document.getElementById('chat-input').value='Hi';document.getElementById('chat-form').requestSubmit();}if(submitted&&document.getElementById('chat-log').textContent.includes('Agent: Hello from test')){document.body.dataset.chat='pass';clearInterval(check);}},25);setTimeout(()=>clearInterval(check),4000);</script>`;
  await writeFile(join(target,'index.html'),appHTML.replace('</html>',driver+'</html>'));
  const chat = await exec(process.env.CHROME_BIN || 'google-chrome', [
    '--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',
    '--virtual-time-budget=7000',`--user-data-dir=${join(dir,'chrome-chat')}`,'--dump-dom',url
  ], {timeout:45000,maxBuffer:1024*1024});
  assert.match(chat.stdout, /<body data-chat="pass">/);
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
    '--virtual-time-budget=5000', `--user-data-dir=${join(dir,'chrome-interaction')}`, '--dump-dom', url
  ], {timeout:45000,maxBuffer:1024*1024});
  assert.match(interactive.stdout, /<body data-result="pass">/);
  const repo=new ApplicationStore({id:'demo',schemaVersion:1,revision:0,pages:[]});
  review=createDevelopmentPlanes(repo,'developer-token-at-least-32-characters-long','agent-token-at-least-32-characters-long').control;
  review.listen(0,'127.0.0.1'); await once(review,'listening');
  const reviewURL=`http://127.0.0.1:${review.address().port}/development`;
  const reviewPage=await exec(process.env.CHROME_BIN || 'google-chrome', [
    '--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',
    '--virtual-time-budget=3000',`--user-data-dir=${join(dir,'chrome-review')}`,'--dump-dom',reviewURL
  ], {timeout:45000,maxBuffer:1024*1024});
  assert.match(reviewPage.stdout, /Review development proposal/);
  assert.match(reviewPage.stdout, /data-review-ready="true"/);
  assert.match(reviewPage.stdout, /id="publish"[^>]*disabled/);
  console.log('Generated workspace, chat, interactive renderer and review page passed in headless Chrome');
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = once(server, 'exit'); server.kill(); await exited;
  }
  if(review?.listening) await new Promise((resolve,reject)=>review.close(error=>error?reject(error):resolve()));
  if(agent?.listening) await new Promise((resolve,reject)=>agent.close(error=>error?reject(error):resolve()));
  await rm(dir, {recursive:true, force:true});
}
