import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CapabilityRegistry,SqliteOfflineQueue,SqliteStagedOperations} from '../dist/index.js';
const scope={tenantId:'t',applicationId:'a'},actor={tenantId:'t',principalId:'p',origin:'service'},policy={enabled:true,maxAttempts:2,retryDelayMs:100};
const candidate={operationId:'update',method:'POST',path:'/update'};

test('separate offline queues accept a host-issued shared idempotency key',async()=>{
 const first=new SqliteOfflineQueue(':memory:',policy),second=new SqliteOfflineQueue(':memory:',policy),effects=new Map(),registry=new CapabilityRegistry(()=>{});registry.register(candidate,{authorize:()=>true,validate:()=>true,execute:input=>{if(!effects.has(input.idempotencyKey))effects.set(input.idempotencyKey,input.payload);return 'ok';}});
 try{const key='shared-key',a=first.enqueue(scope,'p','update','logical',{value:1},{idempotencyKey:key}),b=second.enqueue(scope,'p','update','logical',{value:1},{idempotencyKey:key});assert.equal(a.idempotencyKey,b.idempotencyKey);assert.throws(()=>first.enqueue(scope,'p','update','logical',{value:1},{idempotencyKey:'other'}),/conflict/);assert.equal(first.enqueue(scope,'p','update','logical',{value:1}).idempotencyKey,key);await first.processOne(scope,actor,registry,()=> 'uncertain',10);await second.processOne(scope,actor,registry,()=> 'uncertain',10);assert.equal(effects.size,1);assert.deepEqual(effects.get(key),{value:1});}finally{first.close();second.close();}
});

test('offline queue requires explicit enablement and deduplicates durable intents',()=>{
 assert.throws(()=>new SqliteOfflineQueue(':memory:',{...policy,enabled:false}),/policy/);
 const dir=mkdtempSync(join(tmpdir(),'app-mixer-offline-')),path=join(dir,'db.sqlite');let queue=new SqliteOfflineQueue(path,policy);
 try{
  const payload={name:'one',nested:{x:1,y:2}},item=queue.enqueue(scope,'p','update','req',payload);payload.name='mutated';
  assert.equal(queue.enqueue(scope,'p','update','req',{nested:{y:2,x:1},name:'one'}).id,item.id);
  assert.throws(()=>queue.enqueue(scope,'p','update','req',{name:'different'}),/conflict/);
  assert.notEqual(queue.enqueue(scope,'other','update','req',{name:'other'}).id,item.id);
  assert.equal(queue.get({...scope,tenantId:'other'},'p',item.id),undefined);
  queue.close();queue=new SqliteOfflineQueue(path,policy);assert.equal(queue.get(scope,'p',item.id).payload.name,'one');
  assert.equal(queue.list(scope,'p').length,1);
 }finally{queue.close();rmSync(dir,{recursive:true,force:true});}
});

test('bounded retries preserve the key, reauthorize, and remain separate from staged operations',async()=>{
 const queue=new SqliteOfflineQueue(':memory:',policy),staged=new SqliteStagedOperations(':memory:'),events=[],keys=[];let attempts=0;
 const registry=new CapabilityRegistry(event=>events.push(event.outcome));registry.register(candidate,{authorize:ctx=>ctx.principalId==='p',validate:()=>true,execute:input=>{keys.push(input.idempotencyKey);if(++attempts===1)throw Error('known pre-effect outage');return 'ok';}});
 try{
  const item=queue.enqueue(scope,'p','update','r',{v:1}),manual=staged.stage(scope,'update',{v:2});
  const first=await queue.processOne(scope,actor,registry,()=> 'retry',1000);assert.equal(first.status,'pending');assert.equal(first.attempts,1);assert.equal(first.nextAttemptAt,1100);
  assert.equal(await queue.processOne(scope,actor,registry,()=> 'retry',1099),undefined);
  const second=await queue.processOne(scope,actor,registry,()=> 'retry',1100);assert.equal(second.status,'succeeded');assert.equal(second.attempts,2);
  assert.deepEqual(keys,[item.idempotencyKey,item.idempotencyKey]);assert.equal(staged.get(scope,manual.id).status,'staged');
  assert.deepEqual(events,['attempt','failed','attempt','succeeded']);
 }finally{queue.close();staged.close();}
});

test('conflicts and uncertain outcomes stop replay until a host decision',async()=>{
 const queue=new SqliteOfflineQueue(':memory:',policy),registry=new CapabilityRegistry(()=>{});let mode='conflict',calls=0;
 registry.register(candidate,{authorize:()=>true,validate:()=>true,execute:()=>{calls++;throw Error(mode);}});
 try{
  const conflict=queue.enqueue(scope,'p','update','conflict',{});
  assert.equal((await queue.processOne(scope,actor,registry,()=> 'conflict',1)).status,'conflict');
  assert.equal(await queue.processOne(scope,actor,registry,()=> 'retry',2),undefined);queue.discard(scope,'p',conflict.id);assert.equal(queue.get(scope,'p',conflict.id).status,'discarded');
  const uncertain=queue.enqueue(scope,'p','update','uncertain',{});mode='lost';
  assert.equal((await queue.processOne(scope,actor,registry,()=> 'uncertain',3)).status,'uncertain');
  assert.throws(()=>queue.discard(scope,'p',uncertain.id),/state/);assert.equal(await queue.processOne(scope,actor,registry,()=> 'retry',4),undefined);
  queue.reconcile(scope,'p',uncertain.id,'applied');assert.equal(queue.get(scope,'p',uncertain.id).status,'succeeded');assert.equal(calls,2);
 }finally{queue.close();}
});

test('one claimant executes, actor changes do not affect in-flight work, and retry limits hold',async()=>{
 const queue=new SqliteOfflineQueue(':memory:',policy),registry=new CapabilityRegistry(()=>{});let release,started;
 const gate=new Promise(resolve=>release=resolve),signal=new Promise(resolve=>started=resolve),contexts=[];
 registry.register(candidate,{authorize:()=>true,validate:()=>true,execute:async(_input,ctx)=>{contexts.push(ctx);started();await gate;throw Error('safe retry');}});
 try{
  const item=queue.enqueue(scope,'p','update','one',{}),mutableScope={...scope},mutableActor={...actor};
  const first=queue.processOne(mutableScope,mutableActor,registry,()=> 'retry',1);await signal;
  mutableScope.tenantId='evil';mutableActor.principalId='other';
  assert.equal(await queue.processOne(scope,actor,registry,()=> 'retry',1),undefined);release();assert.equal((await first).status,'pending');
  assert.deepEqual(contexts,[{tenantId:'t',principalId:'p'}]);assert.equal(queue.get(scope,'p',item.id).attempts,1);
  assert.equal((await queue.processOne(scope,actor,registry,()=> 'retry',101)).status,'exhausted');
 }finally{queue.close();}
});

test('process exit leaves an uncertain operation requiring explicit recovery',async()=>{
 const {spawnSync}=await import('node:child_process');
 const dir=mkdtempSync(join(tmpdir(),'app-mixer-offline-crash-')),path=join(dir,'db.sqlite'),moduleUrl=new URL('../dist/index.js',import.meta.url).href;
 const script=`import {SqliteOfflineQueue,CapabilityRegistry} from ${JSON.stringify(moduleUrl)};
 const q=new SqliteOfflineQueue(process.env.OFFLINE_DB,{enabled:true,maxAttempts:2,retryDelayMs:0}),scope={tenantId:'t',applicationId:'a'};
 const item=q.enqueue(scope,'p','update','req',{x:1});console.log(item.id);
 const r=new CapabilityRegistry(()=>{});r.register({operationId:'update',method:'POST',path:'/'},{authorize:()=>true,validate:()=>true,execute:()=>process.exit(0)});
 await q.processOne(scope,{tenantId:'t',principalId:'p',origin:'service'},r,()=> 'retry');`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',env:{...process.env,OFFLINE_DB:path}});assert.equal(child.status,0,child.stderr);
 const id=child.stdout.trim(),queue=new SqliteOfflineQueue(path,policy),registry=new CapabilityRegistry(()=>{});let calls=0;
 registry.register(candidate,{authorize:()=>true,validate:()=>true,execute:()=>{calls++;}});
 try{
  assert.equal(queue.get(scope,'p',id).status,'running');assert.equal(await queue.processOne(scope,actor,registry,()=> 'retry'),undefined);
  queue.recoverAbandoned(scope,'p',id);assert.equal(queue.get(scope,'p',id).status,'uncertain');
  assert.equal(await queue.processOne(scope,actor,registry,()=> 'retry'),undefined);assert.equal(calls,0);
  queue.reconcile(scope,'p',id,'not_applied');assert.equal((await queue.processOne(scope,actor,registry,()=> 'uncertain')).status,'succeeded');assert.equal(calls,1);
 }finally{queue.close();rmSync(dir,{recursive:true,force:true});}
});

test('a stricter reopened retry limit exhausts pending work without execution',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'app-mixer-offline-policy-')),path=join(dir,'db.sqlite');let queue=new SqliteOfflineQueue(path,policy),calls=0;
 const registry=new CapabilityRegistry(()=>{});registry.register(candidate,{authorize:()=>true,validate:()=>true,execute:()=>{calls++;throw Error('pre-effect');}});
 try{
  const item=queue.enqueue(scope,'p','update','req',{});assert.equal((await queue.processOne(scope,actor,registry,()=> 'retry',1)).status,'pending');
  queue.close();queue=new SqliteOfflineQueue(path,{...policy,maxAttempts:1});
  assert.equal(await queue.processOne(scope,actor,registry,()=> 'retry',200),undefined);assert.equal(queue.get(scope,'p',item.id).status,'exhausted');assert.equal(calls,1);
 }finally{queue.close();rmSync(dir,{recursive:true,force:true});}
});

test('separate workers cannot claim the same intent concurrently',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'app-mixer-offline-workers-')),path=join(dir,'db.sqlite'),one=new SqliteOfflineQueue(path,policy),two=new SqliteOfflineQueue(path,policy),registry=new CapabilityRegistry(()=>{});let release,started,calls=0;
 const gate=new Promise(resolve=>release=resolve),signal=new Promise(resolve=>started=resolve);
 registry.register(candidate,{authorize:()=>true,validate:()=>true,execute:async()=>{calls++;started();await gate;}});
 try{
  const item=one.enqueue(scope,'p','update','req',{}),first=one.processOne(scope,actor,registry,()=> 'uncertain');await signal;
  assert.equal(await two.processOne(scope,actor,registry,()=> 'uncertain'),undefined);release();assert.equal((await first).status,'succeeded');assert.equal(two.get(scope,'p',item.id).status,'succeeded');assert.equal(calls,1);
 }finally{one.close();two.close();rmSync(dir,{recursive:true,force:true});}
});

test('denial and invalid failure classification fail closed',async()=>{
 const queue=new SqliteOfflineQueue(':memory:',policy),events=[],registry=new CapabilityRegistry(event=>events.push(event.outcome));let calls=0;
 registry.register(candidate,{authorize:()=>false,validate:()=>true,execute:()=>calls++});
 try{
  const item=queue.enqueue(scope,'p','update','req',{});
  assert.equal((await queue.processOne(scope,actor,registry,()=> 'unexpected',1)).status,'uncertain');
  assert.equal(queue.get(scope,'p',item.id).status,'uncertain');assert.equal(calls,0);assert.deepEqual(events,['attempt','denied']);
 }finally{queue.close();}
});
