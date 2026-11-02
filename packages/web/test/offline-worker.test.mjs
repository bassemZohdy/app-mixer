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

test('each exhausted pending entry consumes a per-pass slot',async()=>{
 const queue=await open(new IDBFactory(),await key()),worker=new BrowserOfflineWorker(queue,{...config,intervalMs:10000,maxPerPass:1,maxAttempts:1});
 try{
  for(let i=0;i<3;i++){const item=await queue.enqueue('update',`exhausted-${i}`,{}),running=await queue.transition(item.id,item.version,'claim');await queue.transition(item.id,running.version,'requeue');}
  worker.start();await waitFor(async()=>(await queue.list()).some(item=>item.status==='exhausted'));await worker.stop();
  const items=await queue.list();assert.equal(items.filter(item=>item.status==='exhausted').length,1);assert.equal(items.filter(item=>item.status==='pending').length,2);
 }finally{await worker.stop();queue.close();}
});

test('a contested claim consumes a per-pass slot',async()=>{
 const queue=await open(new IDBFactory(),await key());let attempts=0;const transition=queue.transition.bind(queue);
 const worker=new BrowserOfflineWorker(queue,{...config,intervalMs:10000,maxPerPass:1});
 try{
  for(let i=0;i<3;i++)await queue.enqueue('update',`contested-${i}`,{});
  queue.transition=async(id,version,action)=>{if(action==='claim'){attempts++;throw Error('Offline version conflict');}return transition(id,version,action);};
  worker.start();await waitFor(()=>attempts>0);await worker.stop();assert.equal(attempts,1);assert.equal((await queue.list()).filter(item=>item.status==='pending').length,3);
 }finally{await worker.stop();queue.close();}
});

test('repeatedly contested claims do not starve other pending entries',async()=>{
 const queue=await open(new IDBFactory(),await key());let attempts=0,dispatches=0;const transition=queue.transition.bind(queue),worker=new BrowserOfflineWorker(queue,{...config,intervalMs:100,maxPerPass:1,dispatch:()=>{dispatches++;}});
 try{
  for(let i=0;i<3;i++)await queue.enqueue('update',`fair-${i}`,{});
  const items=(await queue.list()).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0),contested=items[0].id;
  queue.transition=async(id,version,action)=>{if(id===contested&&action==='claim'){attempts++;throw Error('Offline version conflict');}return transition(id,version,action);};
  worker.start();await waitFor(async()=>(await queue.list()).filter(item=>item.status==='succeeded').length===2);await worker.stop();
  assert.ok(attempts>=1);assert.equal(dispatches,2);assert.equal((await queue.get(contested)).status,'pending');
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

test('bounded policy checks stop promptly and retain capacity until late callbacks settle',async()=>{
 for(const stage of ['online','actor']){
  const queue=await open(new IDBFactory(),await key());let release,started,blocked=true,signal,calls=0,errors=[];const gate=new Promise(resolve=>release=resolve),waiting=new Promise(resolve=>started=resolve);
  const blockedPolicy=async currentSignal=>{signal=currentSignal;if(blocked){started();await gate;}return stage==='online'?true:scope;};
  const options={...config,policyTimeoutMs:1000,maxPendingPolicies:1,isOnline:stage==='online'?blockedPolicy:()=>true,resolveActor:stage==='actor'?blockedPolicy:()=>scope,dispatch:()=>calls++,onError:error=>errors.push(error)};
  const item=await queue.enqueue('update',`stop-${stage}`,{}),worker=new BrowserOfflineWorker(queue,options);
  try{
   worker.start();await waiting;await worker.stop();assert.equal(signal.aborted,true);assert.equal((await queue.get(item.id)).status,'pending');assert.equal(calls,0);assert.deepEqual(errors,[]);
   worker.start();await waitFor(()=>errors.some(error=>String(error).includes('policy unavailable')));assert.equal(calls,0);
   blocked=false;release();await waitFor(async()=>(await queue.get(item.id)).status==='succeeded');assert.equal(calls,1);
  }finally{release();await worker.stop();queue.close();}
 }
});

test('timed-out policy decisions fail closed and cannot dispatch when they settle late',async()=>{
 const queue=await open(new IDBFactory(),await key());let release,started,signal,blocked=true,calls=0,errors=[];const gate=new Promise(resolve=>release=resolve),waiting=new Promise(resolve=>started=resolve),item=await queue.enqueue('update','timeout',{});
 const worker=new BrowserOfflineWorker(queue,{...config,policyTimeoutMs:100,maxPendingPolicies:1,isOnline:async currentSignal=>{if(blocked){signal=currentSignal;started();await gate;}return true;},dispatch:()=>calls++,onError:error=>errors.push(error)});
 try{worker.start();await waiting;await waitFor(()=>errors.some(error=>String(error).includes('policy unavailable')));assert.equal(signal.aborted,true);assert.equal((await queue.get(item.id)).status,'pending');assert.equal(calls,0);blocked=false;release();await waitFor(async()=>(await queue.get(item.id)).status==='succeeded');assert.equal(calls,1);}finally{release();await worker.stop();queue.close();}
});

test('bounded stop releases an already claimed entry before a late policy decision',async()=>{
 const queue=await open(new IDBFactory(),await key());let checks=0,release,started,signal,calls=0;const gate=new Promise(resolve=>release=resolve),waiting=new Promise(resolve=>started=resolve),item=await queue.enqueue('update','claimed',{});
 const worker=new BrowserOfflineWorker(queue,{...config,policyTimeoutMs:1000,maxPendingPolicies:1,isOnline:async currentSignal=>{if(++checks===3){signal=currentSignal;started();await gate;}return true;},dispatch:()=>calls++});
 try{worker.start();await waiting;await worker.stop();const state=await queue.get(item.id);assert.equal(signal.aborted,true);assert.equal(state.status,'pending');assert.equal(state.attempts,0);release();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,0);}finally{release();await worker.stop();queue.close();}
});

test('browser worker requires paired bounded policy settings',async()=>{
 const queue=await open(new IDBFactory(),await key());try{for(const invalid of [{policyTimeoutMs:100},{maxPendingPolicies:1},{policyTimeoutMs:99,maxPendingPolicies:1},{policyTimeoutMs:100,maxPendingPolicies:0},{policyTimeoutMs:30001,maxPendingPolicies:1}])assert.throws(()=>new BrowserOfflineWorker(queue,{...config,...invalid}),/Invalid browser offline worker/);}finally{queue.close();}
});
