import {test} from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {IDBFactory} from 'fake-indexeddb';
import {EncryptedBrowserQueue,BrowserOfflineWorker} from '../dist/offline.js';
const scope={tenantId:'t',applicationId:'app',principalId:'p'};
const open=async(factory,key)=>EncryptedBrowserQueue.open({enabled:true,databaseName:'worker',scope,key,indexedDB:factory,crypto:webcrypto});
const key=()=>webcrypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
const waitFor=async predicate=>{for(let i=0;i<200;i++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Timed out waiting for browser worker');};
const config={intervalMs:100,maxPerPass:5,maxAttempts:2,isOnline:()=>true,resolveActor:()=>scope,dispatch:()=>{},classify:()=> 'uncertain',onError:()=>{}};

test('browser worker dispatches only when online and the current identity matches',async()=>{
 const queue=await open(new IDBFactory(),await key());let online=false,actor={...scope},calls=0;
 const item=await queue.enqueue('update','req',{value:'x'}),worker=new BrowserOfflineWorker(queue,{...config,isOnline:()=>online,resolveActor:()=>actor,dispatch:(_name,input,context)=>{calls++;assert.equal(input.idempotencyKey,item.idempotencyKey);input.payload.value='mutated';context.tenantId='other';}});
 try{
  worker.start();await new Promise(resolve=>setTimeout(resolve,130));assert.equal((await queue.get(item.id)).status,'pending');
  online=true;actor={...scope,principalId:'other'};await new Promise(resolve=>setTimeout(resolve,120));assert.equal(calls,0);
  actor={...scope};await waitFor(async()=>(await queue.get(item.id)).status==='succeeded');assert.equal(calls,1);assert.equal((await queue.get(item.id)).payload.value,'x');
 }finally{await worker.stop();queue.close();}
});

test('workers share claims and stop waits for in-flight dispatch',async()=>{
 const factory=new IDBFactory(),secret=await key(),a=await open(factory,secret),b=await open(factory,secret);let started,release,calls=0;
 const signal=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve),item=await a.enqueue('update','req',{});
 const options={...config,dispatch:async()=>{calls++;started();await gate;}},one=new BrowserOfflineWorker(a,options),two=new BrowserOfflineWorker(b,options);
 try{
  one.start();two.start();await signal;let stopped=false;const promise=one.stop().then(()=>stopped=true);await new Promise(resolve=>setTimeout(resolve,20));
  if(!stopped){assert.throws(()=>one.start(),/stopping/);}release();await promise;await waitFor(async()=>(await a.get(item.id)).status==='succeeded');assert.equal(calls,1);
 }finally{release();await one.stop();await two.stop();a.close();b.close();}
});

test('retries are bounded and ambiguous failures do not replay',async()=>{
 const queue=await open(new IDBFactory(),await key());let calls=0,classification='retry';const item=await queue.enqueue('update','req',{});
 const worker=new BrowserOfflineWorker(queue,{...config,dispatch:()=>{calls++;throw Error('failure');},classify:()=>classification});
 try{
  worker.start();await waitFor(async()=>(await queue.get(item.id)).status==='exhausted');assert.equal(calls,2);assert.equal((await queue.get(item.id)).attempts,2);
  classification='uncertain';const next=await queue.enqueue('update','next',{});await waitFor(async()=>(await queue.get(next.id)).status==='uncertain');
  const count=calls;await new Promise(resolve=>setTimeout(resolve,130));assert.equal(calls,count);
 }finally{await worker.stop();queue.close();}
});

test('stopping before dispatch releases the claim without consuming an attempt',async()=>{
 const queue=await open(new IDBFactory(),await key());let checks=0,release,started,calls=0;
 const gate=new Promise(resolve=>release=resolve),signal=new Promise(resolve=>started=resolve),item=await queue.enqueue('update','req',{});
 const worker=new BrowserOfflineWorker(queue,{...config,isOnline:()=>{checks++;if(checks===3){started();return gate;}return true;},dispatch:()=>calls++});
 try{
  worker.start();await signal;const stopped=worker.stop();release(true);await stopped;
  const state=await queue.get(item.id);assert.equal(state.status,'pending');assert.equal(state.attempts,0);assert.equal(calls,0);
 }finally{await worker.stop();queue.close();}
});
