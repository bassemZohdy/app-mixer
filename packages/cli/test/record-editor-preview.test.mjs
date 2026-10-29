import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {runInNewContext} from 'node:vm';
import {JSDOM} from 'jsdom';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createProject} from '../dist/index.js';
import {ApplicationStore,createDevelopmentPlanes} from '../../core/dist/index.js';
import {A2UIRenderer,APP_MIXER_CATALOG,basicRegistry} from '../../web/dist/index.js';
const developer='developer-token-at-least-32-characters-long',agent='agent-token-at-least-32-characters-long';
async function start(server){server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${server.address().port}`;}
async function stop(server){if(server.listening)await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
const post=(token,body)=>({method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)});

test('record editor extension previews safely without invoking business capabilities',async()=>{
 const repo=new ApplicationStore({id:'demo',schemaVersion:1,revision:0,pages:[]});
 const source=`import {createRecordEditor} from './data-editor.mjs';export const installedExtensions=[{id:'example.records',version:'1.0.0',scope:'application',components:{'record-editor':createRecordEditor({getOperation:'items.get',putOperation:'items.put'})}}];`;
 const planes=createDevelopmentPlanes(repo,developer,agent,undefined,{extensionModule:source});
 try {
  const cp=await start(planes.control),pp=await start(planes.proposal),ref={id:'example.records',version:'1.0.0',scope:'application'};
  const page={id:'home',title:'Home',route:'/',components:[{id:'editor',type:'Extension',extensionId:ref.id,name:'record-editor',props:{label:'<script>unsafe</script>'}}]};
  const proposal=await (await fetch(`${pp}/proposals`,post(agent,{baseRevision:0,patches:[{op:'setExtensions',extensions:[ref]},{op:'addPage',page}]}))).json();
  const moduleResponse=await fetch(`${cp}/development/data-editor.mjs`);assert.equal(moduleResponse.status,200);
  const moduleSource=await moduleResponse.text(),moduleUrl='data:text/javascript;base64,'+Buffer.from(moduleSource).toString('base64');
  const extensionSource=await (await fetch(`${cp}/development/extensions.mjs`)).text();
  const {installedExtensions}=await import('data:text/javascript;base64,'+Buffer.from(extensionSource.replace("'./data-editor.mjs'",JSON.stringify(moduleUrl))).toString('base64'));
  const html=await (await fetch(`${cp}/development`)).text(),dom=new JSDOM(html),document=dom.window.document;
  const script=html.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/^\s*import [^;]+;\s*/gm,'');
  const calls=[];runInNewContext(script,{document,A2UIRenderer,APP_MIXER_CATALOG,basicRegistry,installedExtensions,fetch:(path,options)=>{calls.push(path);return fetch(new URL(path,cp),options);}});
  document.getElementById('token').value=developer;document.getElementById('proposal-id').value=proposal.id;document.getElementById('load').click();
  for(let i=0;i<100&&document.getElementById('approve').disabled;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(document.getElementById('approve').disabled,false);
  const preview=document.getElementById('rendered-preview');assert.equal(preview.querySelector('h3').textContent,'<script>unsafe</script>');assert.equal(preview.querySelector('script'),null);
  assert.ok([...preview.querySelectorAll('button,input,textarea')].every(item=>item.disabled));
  assert.match(preview.textContent,/Preview only/);assert.deepEqual(calls,[`/proposals/${proposal.id}`]);assert.equal(repo.getDraft().revision,0);
  dom.window.close();
 } finally {await stop(planes.control);await stop(planes.proposal);}
});


test('runtime and preview editor accept the same component contract',async()=>{
 const repo=new ApplicationStore({id:'demo',schemaVersion:1,revision:0,pages:[]}),planes=createDevelopmentPlanes(repo,developer,agent);
 const dir=await mkdtemp(join(tmpdir(),'app-mixer-preview-'));
 try {
  const cp=await start(planes.control),source=await (await fetch(`${cp}/development/data-editor.mjs`)).text();
  const preview=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  const target=await createProject('demo-app',dir),runtime=await import(pathToFileURL(join(target,'data-editor.mjs')).href);
  const options={getOperation:'items.get',putOperation:'items.put'},a=preview.createRecordEditor(options),b=runtime.createRecordEditor(options);
  for(const component of [{id:'root',component:'record-editor'},{id:'root',component:'record-editor',label:'People'},{id:'root',component:'record-editor',label:1},{id:'root',component:'record-editor',label:'x'.repeat(121)},{id:'root',component:'record-editor',unknown:'bad'}]){
   const accepts=validate=>{try{validate(component);return true;}catch{return false;}};assert.equal(accepts(a.validate),accepts(b.validate));
  }
  for(const factory of [preview.createRecordEditor,runtime.createRecordEditor])assert.throws(()=>factory({getOperation:'../bad',putOperation:'items.put'}),/Invalid/);
 } finally {await stop(planes.control);await stop(planes.proposal);await rm(dir,{recursive:true,force:true});}
});

test('staged editor preview shares its contract and cannot submit',async()=>{
 const repo=new ApplicationStore({id:'demo',schemaVersion:1,revision:0,pages:[]}),planes=createDevelopmentPlanes(repo,developer,agent);
 const dir=await mkdtemp(join(tmpdir(),'app-mixer-staged-preview-'));
 try {
  const cp=await start(planes.control),response=await fetch(`${cp}/development/staged-editor.mjs`);assert.equal(response.status,200);
  const source=await response.text(),preview=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  const target=await createProject('demo-app',dir),runtime=await import(pathToFileURL(join(target,'staged-editor.mjs')).href);
  const options={stageOperation:'orders.stage',getOperation:'orders.get',submitOperation:'orders.submit'},a=preview.createStagedEditor(options),b=runtime.createStagedEditor(options);
  for(const component of [{id:'root',component:'staged-editor'},{id:'root',component:'staged-editor',label:'Order'},{id:'root',component:'staged-editor',label:1},{id:'root',component:'staged-editor',label:'x'.repeat(121)},{id:'root',component:'staged-editor',unknown:'bad'}]){
   const accepts=validate=>{try{validate(component);return true;}catch{return false;}};assert.equal(accepts(a.validate),accepts(b.validate));
  }
  for(const factory of [preview.createStagedEditor,runtime.createStagedEditor])assert.throws(()=>factory({...options,submitOperation:'../bad'}),/Invalid/);
  const dom=new JSDOM('<!doctype html>'),root=a.render({label:'Order'},null,null,dom.window.document);
  assert.ok([...root.querySelectorAll('button,input,textarea')].every(element=>element.disabled));assert.match(root.textContent,/Transactions are disabled/);dom.window.close();
 } finally {await stop(planes.control);await stop(planes.proposal);await rm(dir,{recursive:true,force:true});}
});
