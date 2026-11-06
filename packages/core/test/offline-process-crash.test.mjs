import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CapabilityRegistry,SqliteOfflineQueue} from '../dist/index.js';

const scope={tenantId:'t',applicationId:'a'},actor={tenantId:'t',principalId:'p',origin:'service'},policy={enabled:true,maxAttempts:2,retryDelayMs:100},workerPath=fileURLToPath(new URL('./fixtures/crash-offline-worker.mjs',import.meta.url));

test('a worker killed mid-execution leaves a running operation that is never re-executed until reconciled and then reuses its idempotency key',{timeout:30000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'offline-crash-')),path=join(dir,'queue.sqlite');let queue,child;const keys=[];
 try{
  child=fork(workerPath,[path],{stdio:['ignore','ignore','ignore','ipc']});
  const [message]=await Promise.race([once(child,'message'),once(child,'exit').then(([code,signal])=>{throw Error(`worker exited early (${code??signal})`);})]);assert.equal(message.type,'executing');
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;child=undefined;

  queue=new SqliteOfflineQueue(path,policy);
  const registry=new CapabilityRegistry(()=>{});registry.register({operationId:'update',method:'POST',path:'/update'},{authorize:()=>true,validate:()=>true,execute:input=>{keys.push(input.idempotencyKey);return 'ok';}});
  const [stuck]=queue.list(scope,'p');assert.equal(stuck.status,'running');assert.equal(stuck.attempts,1);assert.equal(stuck.idempotencyKey,message.key);
  // Another principal and tenant see nothing.
  assert.equal(queue.list(scope,'other').length,0);assert.equal(queue.list({tenantId:'t2',applicationId:'a'},'p').length,0);
  // A running operation is not picked up again, so the possibly applied effect is never duplicated.
  assert.equal(await queue.processOne(scope,actor,registry,()=> 'retry',1000),undefined);assert.deepEqual(keys,[]);
  // Recovery marks the outcome uncertain; nothing executes until the host reconciles it.
  queue.recoverAbandoned(scope,'p',stuck.id);assert.equal(queue.get(scope,'p',stuck.id).status,'uncertain');
  assert.equal(await queue.processOne(scope,actor,registry,()=> 'retry',2000),undefined);assert.deepEqual(keys,[]);
  // Once the host verifies it was not applied, the retry reuses the original key so a downstream can deduplicate.
  queue.reconcile(scope,'p',stuck.id,'not_applied');
  const retried=await queue.processOne(scope,actor,registry,()=> 'retry',3000);assert.equal(retried.id,stuck.id);assert.deepEqual(keys,[message.key]);
  assert.equal(queue.get(scope,'p',stuck.id).status,'succeeded');
 }finally{if(child){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}queue?.close();rmSync(dir,{recursive:true,force:true});}
});
