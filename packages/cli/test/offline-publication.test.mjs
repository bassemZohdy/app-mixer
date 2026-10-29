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
