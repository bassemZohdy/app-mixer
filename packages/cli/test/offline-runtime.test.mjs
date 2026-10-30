import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {webcrypto} from 'node:crypto';
import {IDBFactory} from 'fake-indexeddb';
import {JSDOM} from 'jsdom';
import {createProject} from '../dist/index.js';
import {CapabilityRegistry,createCapabilityServer} from '../../core/dist/index.js';
const token='capability-secret-at-least-thirty-two-characters',scope={tenantId:'tenant',applicationId:'demo-app',principalId:'local'};
const waitFor=async condition=>{for(let i=0;i<250;i++){if(await condition())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Timed out waiting for offline integration');};

test('generated offline runtime queues, synchronizes and resolves a conflict through the capability service', {timeout:15000},async()=>{
 let externalCalls=0,stored={value:'server',version:2};const events=[],registry=new CapabilityRegistry(event=>events.push(event));
 registry.register({operationId:'items.offline',method:'POST',path:'/items'}, {authorize:ctx=>ctx.tenantId==='tenant'&&ctx.principalId==='local',validate:input=>typeof input?.idempotencyKey==='string'&&typeof input?.payload?.value==='string',execute:input=>{externalCalls++;if(input.payload.version!==stored.version)throw Error('Data revision conflict');stored={value:input.payload.value,version:stored.version+1};return stored;}});
 registry.register({operationId:'items.current',method:'GET',path:'/items'}, {authorize:ctx=>ctx.principalId==='local',validate:()=>true,execute:()=>stored});
 const upstream=createCapabilityServer(registry,req=>req.headers.authorization===`Bearer ${token}`?{tenantId:'tenant',principalId:'local'}:undefined,()=>{});upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const dir=await mkdtemp(join(tmpdir(),'app-mixer-offline-runtime-'));let server,runtime,dom;const originalFetch=globalThis.fetch;
 try {
  const target=await createProject('demo-app',dir);server=spawn(process.execPath,['server.mjs'],{cwd:target,env:{...process.env,PORT:'0',CAPABILITY_URL:`http://127.0.0.1:${upstream.address().port}/capabilities/`,CAPABILITY_TOKEN:token},stdio:['ignore','pipe','pipe']});
  const url=await new Promise((resolve,reject)=>{let text='';server.stdout.on('data',chunk=>{text+=chunk;const match=text.match(/http:\/\/127\.0\.0\.1:\d+/);if(match)resolve(match[0]);});server.once('error',reject);server.once('exit',code=>reject(Error(`Server exited: ${code}`)));});
  for(const file of ['offline.js','offline-worker.js','offline-ui.js','offline-runtime.mjs']){const response=await originalFetch(`${url}/${file}`);assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/javascript/);}
  globalThis.fetch=(input,options)=>typeof input==='string'&&input.startsWith('/')?originalFetch(new URL(input,url),{...options,headers:{...options.headers,origin:url}}):originalFetch(input,options);
  const {invokeCapability}=await import(pathToFileURL(join(target,'capabilities.mjs')).href);
  const {createGeneratedOfflineRuntime,mountGeneratedOfflineForm}=await import(pathToFileURL(join(target,'offline-runtime.mjs')).href);
  let online=false,actor={...scope};const config={enabled:true,databaseName:'generated',scope,key:await webcrypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']),indexedDB:new IDBFactory(),crypto:webcrypto,operations:[{id:'items.offline',label:'Update item'}],intervalMs:100,maxPerPass:3,maxAttempts:2,isOnline:()=>online,resolveActor:()=>actor,canEnqueue:(_op,payload)=>typeof payload.value==='string'&&Number.isSafeInteger(payload.version),canDiscard:()=>true,dispatch:(operation,input)=>invokeCapability(operation,input),classify:error=>error.status===409?'conflict':'uncertain',onError:error=>{throw error;},loadCurrent:()=>invokeCapability('items.current',{})};
  runtime=await createGeneratedOfflineRuntime(config);runtime.start();dom=new JSDOM('<!doctype html><main><div id="enqueue"></div><div id="conflicts"></div></main>',{url:'https://app.example/'});Object.defineProperty(dom.window,'crypto',{value:webcrypto});const doc=dom.window.document;
  const form=mountGeneratedOfflineForm(doc.getElementById('enqueue'),runtime),textarea=doc.querySelector('#enqueue textarea');textarea.value=JSON.stringify({value:'mine',version:1});doc.querySelector('#enqueue form').dispatchEvent(new dom.window.Event('submit',{cancelable:true}));
  await waitFor(async()=>(await runtime.list()).length===1);assert.equal(externalCalls,0);assert.equal((await runtime.list())[0].status,'pending');
  online=true;await waitFor(async()=>(await runtime.list())[0].status==='conflict');assert.equal(externalCalls,1);
  const panel=runtime.mountConflicts(doc.getElementById('conflicts'));await panel.refresh();let [review,,resolve]=doc.querySelectorAll('#conflicts button');review.click();await waitFor(()=>!resolve.disabled);assert.match(doc.getElementById('conflicts').textContent,/server/);
  doc.querySelector('#conflicts textarea').value=JSON.stringify({value:'resolved',version:2});actor={...scope,principalId:'other'};resolve.click();await waitFor(()=>doc.getElementById('conflicts').textContent.includes('Unable to queue'));assert.equal(externalCalls,1);
  actor={...scope};resolve.click();await waitFor(async()=>(await runtime.list()).some(item=>item.status==='succeeded'));assert.equal(stored.value,'resolved');assert.equal(externalCalls,2);
  const entries=await runtime.list();assert.equal(entries.filter(item=>item.status==='discarded').length,1);assert.equal(entries.filter(item=>item.status==='succeeded').length,1);assert.ok(events.some(event=>event.outcome==='succeeded'));
  form.dispose();panel.dispose();
 }finally{
  globalThis.fetch=originalFetch;if(runtime)await runtime.close();if(dom)dom.window.close();if(upstream.listening)await new Promise((resolve,reject)=>upstream.close(error=>error?reject(error):resolve()));
  if(server&&server.exitCode===null&&server.signalCode===null){const stopped=once(server,'exit');server.kill();await stopped;}await rm(dir,{recursive:true,force:true});
 }
});

test('generated offline runtime rejects disabled or malformed setup',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'app-mixer-offline-disabled-'));
 try{
  const target=await createProject('demo-app',dir),{createGeneratedOfflineRuntime}=await import(pathToFileURL(join(target,'offline-runtime.mjs')).href);
  await assert.rejects(createGeneratedOfflineRuntime({enabled:false}),/configuration/);
  await assert.rejects(createGeneratedOfflineRuntime({enabled:true,operations:[]}),/configuration/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('offline history recovers encrypted operations after reopening and clears on identity loss or close',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'app-mixer-offline-history-'));let dom,runtime;
 try{
  const target=await createProject('demo-app',dir),{createGeneratedOfflineRuntime}=await import(pathToFileURL(join(target,'offline-runtime.mjs')).href),key=await webcrypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);let actor={...scope};const config={enabled:true,databaseName:'history',scope,key,indexedDB:new IDBFactory(),crypto:webcrypto,operations:[{id:'items.update',label:'Update'}],intervalMs:100,maxPerPass:1,maxAttempts:2,isOnline:()=>false,resolveActor:()=>actor,canEnqueue:()=>true,canDiscard:()=>true,dispatch:()=>{},classify:()=> 'uncertain',onError:()=>{},loadCurrent:()=>{}};
  runtime=await createGeneratedOfflineRuntime(config);await runtime.enqueue('items.update','first',{value:'<img src=x onerror=alert(1)>'});await runtime.close();runtime=await createGeneratedOfflineRuntime(config);dom=new JSDOM('<!doctype html><main id="history"></main>');const root=dom.window.document.getElementById('history'),panel=runtime.mountHistory(root);await panel.refresh();assert.match(root.textContent,/items.update — pending/);assert.match(root.textContent,/<img src=x onerror=alert\(1\)>/);assert.equal(root.querySelector('img'),null);assert.equal(root.querySelectorAll('button').length,0);
  actor={...scope,principalId:'other'};await panel.refresh();assert.match(root.textContent,/Unable to load/);assert.doesNotMatch(root.textContent,/img src/);actor={...scope};await panel.refresh();assert.match(root.textContent,/items.update/);await runtime.close();assert.equal(root.textContent,'');
 }finally{if(runtime)await runtime.close();dom?.window.close();await rm(dir,{recursive:true,force:true});}
});

test('offline history ignores stale asynchronous refreshes and disposal',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'app-mixer-offline-history-race-'));let dom;try{const target=await createProject('demo-app',dir),{mountGeneratedOfflineHistory}=await import(pathToFileURL(join(target,'offline-runtime.mjs')).href);dom=new JSDOM('<!doctype html><main></main>');const root=dom.window.document.querySelector('main');let resolve;const panel=mountGeneratedOfflineHistory(root,{list:()=>new Promise(r=>{resolve=r;})}),pending=panel.refresh();panel.dispose();resolve([{operationId:'private',status:'pending',id:'id',payload:{secret:'secret'}}]);await pending;assert.equal(root.textContent,'');}finally{dom?.window.close();await rm(dir,{recursive:true,force:true});}
});

test('offline form retains request identity across remounts and creates new identities for changes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'app-mixer-offline-form-'));let dom;
 try{
  const target=await createProject('demo-app',dir),{mountGeneratedOfflineForm}=await import(pathToFileURL(join(target,'offline-runtime.mjs')).href);dom=new JSDOM('<!doctype html><main id="offline"></main>',{url:'https://app.example/'});Object.defineProperty(dom.window,'crypto',{value:webcrypto});const doc=dom.window.document,root=doc.getElementById('offline'),calls=[];let fail=true;
  const runtime={operations:()=>[{id:'items.update',label:'Update'}],enqueue:async(operation,key,payload)=>{calls.push({operation,key,payload});if(fail)throw Error('outcome unknown');return {status:'pending'};}};
  const submit=async payload=>{root.querySelector('textarea').value=JSON.stringify(payload);root.querySelector('form').dispatchEvent(new dom.window.Event('submit',{cancelable:true}));await waitFor(()=>!root.querySelector('button').disabled);};
  let form=mountGeneratedOfflineForm(root,runtime);await submit({secret:'private'});assert.equal(calls.length,1);assert.match(root.textContent,/Unable to queue/);const stored=dom.window.sessionStorage.getItem('app-mixer-offline-form-v1:offline');assert.ok(stored);assert.equal(stored.includes('private'),false);form.dispose();
  fail=false;form=mountGeneratedOfflineForm(root,runtime);await submit({secret:'private'});assert.equal(calls[1].key,calls[0].key);await submit({secret:'changed'});assert.notEqual(calls[2].key,calls[1].key);root.querySelectorAll('button')[1].click();await submit({secret:'changed'});assert.notEqual(calls[3].key,calls[2].key);dom.window.sessionStorage.setItem('app-mixer-offline-form-v1:offline','invalid');await submit({secret:'changed'});assert.equal(calls.length,4);assert.match(root.textContent,/Unable to queue/);form.dispose();
 }finally{dom?.window.close();await rm(dir,{recursive:true,force:true});}
});

test('a committed enqueue with a lost response is deduplicated after the form is reopened',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'app-mixer-offline-retry-'));let dom,runtime;
 try{
  const target=await createProject('demo-app',dir),{createGeneratedOfflineRuntime,mountGeneratedOfflineForm}=await import(pathToFileURL(join(target,'offline-runtime.mjs')).href),key=await webcrypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  runtime=await createGeneratedOfflineRuntime({enabled:true,databaseName:'retry',scope,key,indexedDB:new IDBFactory(),crypto:webcrypto,operations:[{id:'items.update',label:'Update'}],intervalMs:100,maxPerPass:1,maxAttempts:2,isOnline:()=>false,resolveActor:()=>scope,canEnqueue:()=>true,canDiscard:()=>true,dispatch:()=>{},classify:()=> 'uncertain',onError:()=>{},loadCurrent:()=>{}});
  dom=new JSDOM('<!doctype html><main id="offline"></main>',{url:'https://app.example/'});Object.defineProperty(dom.window,'crypto',{value:webcrypto});const root=dom.window.document.getElementById('offline');let loseResponse=true;const wrapper={operations:()=>runtime.operations(),enqueue:async(...args)=>{const item=await runtime.enqueue(...args);if(loseResponse)throw Error('response lost');return item;}};
  const submit=async()=>{root.querySelector('textarea').value='{"value":"same"}';root.querySelector('form').dispatchEvent(new dom.window.Event('submit',{cancelable:true}));await waitFor(()=>!root.querySelector('button').disabled);};
  let form=mountGeneratedOfflineForm(root,wrapper);await submit();assert.equal((await runtime.list()).length,1);form.dispose();loseResponse=false;form=mountGeneratedOfflineForm(root,wrapper);await submit();assert.equal((await runtime.list()).length,1);assert.match(root.textContent,/Operation pending/);form.dispose();
 }finally{if(runtime)await runtime.close();dom?.window.close();await rm(dir,{recursive:true,force:true});}
});
