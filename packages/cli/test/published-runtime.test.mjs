import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createProject} from '../dist/index.js';
import {createAGUIServer,LangGraphAGUIAdapter} from '../../agent/dist/index.js';
import {ApplicationStore,PublishedDefinitionCache,CachedPublishedRepository,createDataPlane} from '../../core/dist/index.js';

test('generated workspace renders and refreshes published definitions after agent outage', {timeout:15000}, async()=>{
 const initial={id:'demo-app',schemaVersion:1,revision:0,pages:[{id:'home',route:'/',title:'Published',components:[]}]};
 const repo=new ApplicationStore(initial);repo.publish(0);
 const scope={tenantId:'local',authorizationKey:'local',applicationId:'demo-app',schemaVersion:1};
 const plane=createDataPlane(new CachedPublishedRepository(repo,scope,new PublishedDefinitionCache()));plane.listen(0,'127.0.0.1');await once(plane,'listening');
 const token='a-strong-local-token-at-least-32-characters';
 const agent=createAGUIServer(new LangGraphAGUIAdapter({async *stream(){yield 'Ready';}}),token);agent.listen(0,'127.0.0.1');await once(agent,'listening');
 const dir=await mkdtemp(join(tmpdir(),'app-mixer-publication-'));let server;
 try{
  const target=await createProject('demo-app',dir);
  server=spawn(process.execPath,['server.mjs'],{cwd:target,env:{...process.env,PORT:'0',DATA_PLANE_URL:`http://127.0.0.1:${plane.address().port}/application`,AGENT_URL:`http://127.0.0.1:${agent.address().port}/agent`,AGENT_TOKEN:token},stdio:['ignore','pipe','pipe']});
  const url=await new Promise((resolve,reject)=>{let output='';server.stdout.on('data',x=>{output+=x;const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match)resolve(match[0]);});server.once('error',reject);server.once('exit',code=>reject(Error(`Server exited: ${code}`)));});
  const chat=await fetch(`${url}/api/chat`,{method:'POST',headers:{origin:url,'content-type':'application/json'},body:JSON.stringify({threadId:'t',runId:'r',messages:[{id:'m',role:'user',content:'hello'}],tools:[],context:[],state:{}})});
  assert.equal(chat.status,200);assert.match(await chat.text(),/RUN_FINISHED/);
  await new Promise((resolve,reject)=>agent.close(e=>e?reject(e):resolve()));
  const unavailable=await fetch(`${url}/api/chat`,{method:'POST',headers:{origin:url,'content-type':'application/json'},body:'{}'});assert.equal(unavailable.status,502);
  const html=await (await fetch(url)).text();
  class Element{constructor(doc){this.ownerDocument=doc;this.children=[];this.style={};this.dataset={};this.textContent='';this.hidden=true;}appendChild(x){this.children.push(x);return x;}replaceChildren(...x){this.children=x;}addEventListener(event,fn){this.handler=fn;}}
  const doc={createElement:()=>new Element(doc),getElementById:id=>id==='pages'?host:button};const host=new Element(doc),button=new Element(doc);
  const module=await import(pathToFileURL(join(target,'renderer.mjs')).href);
  const script=html.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/^import [^;]+;/,'');
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  await new AsyncFunction('document','fetch','A2UIRenderer','APP_MIXER_CATALOG','ClientPublishedCache',script)(doc,path=>fetch(new URL(path,url)),module.A2UIRenderer,module.APP_MIXER_CATALOG,module.ClientPublishedCache);
  assert.equal(host.children[0].children[0].children[0].textContent,'Published');assert.equal(button.hidden,false);
  const response=await fetch(`${url}/api/publication`);const etag=response.headers.get('etag');assert.equal((await fetch(`${url}/api/publication`,{headers:{'If-None-Match':etag}})).status,304);
  repo.apply(0,[{op:'setPageTitle',pageId:'home',title:'Updated'}]);repo.publish(1);
  assert.equal((await (await fetch(`${url}/api/publication`,{headers:{'If-None-Match':etag}})).json()).definition.pages[0].title,'Updated');
  await button.handler();assert.equal(host.children[0].children[0].children[0].textContent,'Updated');
  await new Promise((resolve,reject)=>plane.close(e=>e?reject(e):resolve()));
  assert.equal((await fetch(`${url}/api/publication`)).status,502);
 }finally{
  if(agent.listening)await new Promise(resolve=>agent.close(resolve));
  if(plane.listening)await new Promise(resolve=>plane.close(resolve));
  if(server&&server.exitCode===null&&server.signalCode===null){const exited=once(server,'exit');server.kill();await exited;}
  await rm(dir,{recursive:true,force:true});
 }
});
