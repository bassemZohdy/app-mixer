import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CapabilityRegistry,OfflineSyncWorker,SqliteOfflineQueue,SqliteStagedOperations} from '../dist/index.js';
const scope={tenantId:'tenant',applicationId:'app'},actor={tenantId:'tenant',principalId:'person'};
const config={scope,principalId:'person',intervalMs:100,maxPerPass:5,isOnline:()=>true,resolveActor:()=>actor,classify:()=> 'uncertain',onError:()=>{}};
const waitFor=async condition=>{for(let n=0;n<200;n++){if(condition())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Timed out waiting for worker');};
const register=(registry,execute,authorize=()=>true)=>registry.register({operationId:'change',method:'POST',path:'/change'},{authorize,validate:()=>true,execute});

test('explicitly started worker synchronizes when online and leaves staged work alone',async()=>{
 const queue=new SqliteOfflineQueue(':memory:',{enabled:true,maxAttempts:2,retryDelayMs:0}),staged=new SqliteStagedOperations(':memory:'),registry=new CapabilityRegistry(()=>{}),calls=[];let online=false;
 register(registry,input=>calls.push(input.idempotencyKey));
 const item=queue.enqueue(scope,'person','change','request',{n:1}),manual=staged.stage(scope,'change',{n:2});
 const worker=new OfflineSyncWorker(queue,registry,{...config,isOnline:()=>online});
 try{
  assert.equal(queue.get(scope,'person',item.id).status,'pending');assert.deepEqual(calls,[]);
  worker.start();await new Promise(resolve=>setTimeout(resolve,130));assert.equal(queue.get(scope,'person',item.id).status,'pending');
  online=true;await waitFor(()=>queue.get(scope,'person',item.id).status==='succeeded');
  assert.deepEqual(calls,[item.idempotencyKey]);assert.equal(staged.get(scope,manual.id).status,'staged');
  await worker.stop();
 } finally {await worker.stop();queue.close();staged.close();}
});

test('worker refreshes identity and stops dispatch when authority is unavailable',async()=>{
 const queue=new SqliteOfflineQueue(':memory:',{enabled:true,maxAttempts:2,retryDelayMs:0}),registry=new CapabilityRegistry(()=>{});let current=actor,calls=0,lookups=0;
 register(registry,()=>{calls++;current=undefined;});
 const one=queue.enqueue(scope,'person','change','one',{}),two=queue.enqueue(scope,'person','change','two',{});
 const worker=new OfflineSyncWorker(queue,registry,{...config,resolveActor:()=>{lookups++;return current;}});
 try{
  worker.start();await waitFor(()=>calls===1&&lookups>=2);assert.equal(queue.get(scope,'person',one.id).status,'succeeded');assert.equal(queue.get(scope,'person',two.id).status,'pending');
  current={tenantId:'other',principalId:'person'};await new Promise(resolve=>setTimeout(resolve,120));assert.equal(calls,1);
  current=actor;await waitFor(()=>calls===2);assert.equal(queue.get(scope,'person',two.id).status,'succeeded');
 } finally {await worker.stop();queue.close();}
});

test('stop waits for an in-flight dispatch and prevents another',async()=>{
 const queue=new SqliteOfflineQueue(':memory:',{enabled:true,maxAttempts:2,retryDelayMs:0}),registry=new CapabilityRegistry(()=>{});let release,started,calls=0,stopped=false;
 const gate=new Promise(resolve=>release=resolve),signal=new Promise(resolve=>started=resolve);
 register(registry,async()=>{calls++;started();await gate;});
 const one=queue.enqueue(scope,'person','change','one',{}),two=queue.enqueue(scope,'person','change','two',{}),worker=new OfflineSyncWorker(queue,registry,config);
 try{
  worker.start();await signal;const stop=worker.stop().then(()=>stopped=true);await new Promise(resolve=>setTimeout(resolve,20));assert.equal(stopped,false);
  assert.throws(()=>worker.start(),/stopping/);release();await stop;
  assert.equal(queue.get(scope,'person',one.id).status,'succeeded');assert.equal(queue.get(scope,'person',two.id).status,'pending');assert.equal(calls,1);
 }finally{await worker.stop();queue.close();}
});

test('policy failures are reported without processing and start is idempotent',async()=>{
 const queue=new SqliteOfflineQueue(':memory:',{enabled:true,maxAttempts:1,retryDelayMs:0}),registry=new CapabilityRegistry(()=>{});let errors=0,calls=0;
 register(registry,()=>calls++);const item=queue.enqueue(scope,'person','change','one',{});
 assert.throws(()=>new OfflineSyncWorker(queue,registry,{...config,intervalMs:0}),/policy/);
 const worker=new OfflineSyncWorker(queue,registry,{...config,isOnline:()=>{throw Error('connectivity failed');},onError:()=>{errors++;throw Error('audit failed');}});
 try{worker.start();worker.start();await waitFor(()=>errors>0);await worker.stop();assert.equal(calls,0);assert.equal(queue.get(scope,'person',item.id).status,'pending');}
 finally{await worker.stop();queue.close();}
});

test('stop while connectivity is being checked does not dispatch queued work',async()=>{
 const queue=new SqliteOfflineQueue(':memory:',{enabled:true,maxAttempts:1,retryDelayMs:0}),registry=new CapabilityRegistry(()=>{});let release,started,calls=0;
 const gate=new Promise(resolve=>release=resolve),signal=new Promise(resolve=>started=resolve);
 register(registry,()=>calls++);const item=queue.enqueue(scope,'person','change','one',{});
 const worker=new OfflineSyncWorker(queue,registry,{...config,isOnline:async()=>{started();return gate;}});
 try{worker.start();await signal;const stopped=worker.stop();release(true);await stopped;assert.equal(calls,0);assert.equal(queue.get(scope,'person',item.id).status,'pending');}
 finally{await worker.stop();queue.close();}
});
