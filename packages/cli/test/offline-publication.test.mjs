import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto,createHash} from 'node:crypto';
import {IDBFactory} from 'fake-indexeddb';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createProject} from '../dist/index.js';

test('generated publication runtime falls back only for host-confirmed network outages',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'publication-runtime-'));
 try{
  const target=await createProject('demo-app',dir),{createOfflinePublicationRuntime}=await import(pathToFileURL(join(target,'offline-publication-runtime.mjs')).href);
  const publication={version:1,definition:{id:'demo-app',schemaVersion:1,pages:[]}},etag='"'+createHash('sha256').update(JSON.stringify(publication)).digest('hex')+'"';
  let mode='online',allowed=true;const key=await webcrypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  const options={enabled:true,databaseName:'test',scope:{tenantId:'t',principalId:'p',authorizationKey:'v1',applicationId:'demo-app',schemaVersion:1},key,maxAgeMs:60000,authorize:()=>allowed,compatible:()=>true,indexedDB:new IDBFactory(),crypto:webcrypto,isOffline:()=>mode==='offline',fetchPublication:async()=>{if(mode==='offline'||mode==='network')throw Error('network');if(mode==='denied')return new Response('',{status:403});return new Response(JSON.stringify(publication),{status:200,headers:{etag}});}};
  const runtime=await createOfflinePublicationRuntime(options);assert.equal((await runtime.refresh()).offline,false);
  mode='offline';assert.equal((await runtime.refresh()).publication.version,1);
  allowed=false;await assert.rejects(runtime.refresh(),/access denied/);allowed=true;
  mode='denied';await assert.rejects(runtime.refresh(),/Publication unavailable/);
  mode='network';await assert.rejects(runtime.refresh(),/network/);
  mode='offline';await runtime.clear();await assert.rejects(runtime.refresh(),/Offline publication unavailable/);runtime.close();await assert.rejects(runtime.refresh(),/runtime changed/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('locking a runtime rejects an in-flight network result',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'publication-runtime-'));
 try{
  const target=await createProject('demo-app',dir),{createOfflinePublicationRuntime}=await import(pathToFileURL(join(target,'offline-publication-runtime.mjs')).href);let resume,started;const gate=new Promise(r=>resume=r),ready=new Promise(r=>started=r);
  const key=await webcrypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);const runtime=await createOfflinePublicationRuntime({enabled:true,databaseName:'test',scope:{tenantId:'t',principalId:'p',authorizationKey:'v1',applicationId:'demo-app',schemaVersion:1},key,maxAgeMs:100,authorize:()=>true,compatible:()=>true,indexedDB:new IDBFactory(),crypto:webcrypto,isOffline:()=>false,fetchPublication:async()=>{started();await gate;return new Response('',{status:403});}});
  const pending=runtime.refresh();await ready;runtime.close();resume();await assert.rejects(pending,/runtime changed/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('generated publication runtime exposes rollback anchor synchronization',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'publication-anchor-runtime-'));try{const target=await createProject('demo-app',dir),{createOfflinePublicationRuntime}=await import(pathToFileURL(join(target,'offline-publication-runtime.mjs')).href),publication={version:1,definition:{id:'demo-app',schemaVersion:1,pages:[]}},etag='"'+createHash('sha256').update(JSON.stringify(publication)).digest('hex')+'"',key=await webcrypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);let floor=0,failed=false;const anchor={async read(){return floor;},async advance(value){if(failed)throw Error('offline');floor=Math.max(floor,value);}},runtime=await createOfflinePublicationRuntime({enabled:true,databaseName:'test',scope:{tenantId:'t',principalId:'p',authorizationKey:'v1',applicationId:'demo-app',schemaVersion:1},key,maxAgeMs:60000,authorize:()=>true,compatible:()=>true,indexedDB:new IDBFactory(),crypto:webcrypto,rollbackAnchor:anchor,isOffline:()=>false,fetchPublication:async()=>new Response(JSON.stringify(publication),{status:200,headers:{etag}})});try{failed=true;assert.equal((await runtime.refresh()).offline,false);assert.equal(runtime.hasPendingRollbackAnchor(),true);await assert.rejects(runtime.syncRollbackAnchor(),/offline/);failed=false;assert.equal(await runtime.syncRollbackAnchor(),1);assert.equal(runtime.hasPendingRollbackAnchor(),false);assert.equal(floor,1);await runtime.clear();assert.equal(floor,2);runtime.close();assert.throws(()=>runtime.hasPendingRollbackAnchor(),/runtime changed/);}finally{runtime.close();}
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('generated application exposes pending rollback anchor recovery to the host',async()=>{
 const {readFile}=await import('node:fs/promises'),{JSDOM}=await import('jsdom'),dir=await mkdtemp(join(tmpdir(),'publication-anchor-app-'));let dom;try{const target=await createProject('demo-app',dir),html=await readFile(join(target,'index.html'),'utf8'),runtime=await import(pathToFileURL(join(target,'offline-publication-runtime.mjs')).href),renderer=await import(pathToFileURL(join(target,'renderer.mjs')).href),workspace=await import(pathToFileURL(join(target,'workspace.mjs')).href),publication={version:1,definition:{id:'demo-app',schemaVersion:1,pages:[{title:'Offline page',components:[]}]}},etag='"'+createHash('sha256').update(JSON.stringify(publication)).digest('hex')+'"',key=await webcrypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);let floor=0,failed=false,controls;const anchor={async read(){return floor;},async advance(value){if(failed)throw Error('anchor unavailable');floor=Math.max(floor,value);}},options={enabled:true,databaseName:'test',scope:{tenantId:'t',principalId:'p',authorizationKey:'v1',applicationId:'demo-app',schemaVersion:1},key,maxAgeMs:60000,authorize:()=>true,indexedDB:new IDBFactory(),crypto:webcrypto,rollbackAnchor:anchor,isOffline:()=>false,fetchPublication:async()=>new Response(JSON.stringify(publication),{status:200,headers:{etag}}),onReady:value=>{controls=value;failed=true;}};dom=new JSDOM(html);const document=dom.window.document,script=html.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/^import [^;]+;\s*/gm,''),AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;await new AsyncFunction('document','fetch','A2UIRenderer','APP_MIXER_CATALOG','ClientPublishedCache','prepareWorkspace','createOfflinePublicationRuntime','initializeOfflinePublication',script)(document,()=>{throw Error('unexpected fetch');},renderer.A2UIRenderer,renderer.APP_MIXER_CATALOG,renderer.ClientPublishedCache,workspace.prepareWorkspace,runtime.createOfflinePublicationRuntime,async()=>options);assert.match(document.getElementById('pages').textContent,/Offline page/);assert.equal(controls.hasPendingRollbackAnchor(),true);await assert.rejects(controls.syncRollbackAnchor(),/anchor unavailable/);failed=false;assert.equal(await controls.syncRollbackAnchor(),1);assert.equal(controls.hasPendingRollbackAnchor(),false);controls.lock();assert.throws(()=>controls.hasPendingRollbackAnchor(),/runtime changed/);
 }finally{dom?.window.close();await rm(dir,{recursive:true,force:true});}
});
