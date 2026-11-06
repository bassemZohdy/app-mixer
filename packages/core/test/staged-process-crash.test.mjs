import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CapabilityRegistry,SqliteStagedOperations} from '../dist/index.js';

const scope={tenantId:'tenant',applicationId:'app'},context={tenantId:'tenant',principalId:'user',origin:'ui'},workerPath=fileURLToPath(new URL('./fixtures/crash-staged-worker.mjs',import.meta.url));

test('a process killed during a staged external submission never resubmits automatically and retries with the same idempotency key after reconciliation',{timeout:30000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'staged-crash-')),path=join(dir,'db.sqlite'),keys=[];let staged,child;
 try{
  child=fork(workerPath,[path],{stdio:['ignore','ignore','ignore','ipc']});
  const [message]=await Promise.race([once(child,'message'),once(child,'exit').then(([code,signal])=>{throw Error(`worker exited early (${code??signal})`);})]);assert.equal(message.type,'submitting');
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;child=undefined;

  staged=new SqliteStagedOperations(path);
  const registry=new CapabilityRegistry(()=>{});registry.register({operationId:'charge',method:'POST',path:'/charge'},{authorize:()=>true,validate:()=>true,execute:input=>{keys.push(input.idempotencyKey);return 'charged';}});
  const stuck=staged.get(scope,message.id);assert.equal(stuck.status,'submitting');assert.equal(stuck.idempotencyKey,message.key);assert.deepEqual(stuck.payload,{amount:10});
  // Another tenant cannot see the operation.
  assert.equal(staged.get({tenantId:'other',applicationId:'app'},message.id),undefined);
  // The interrupted submission cannot be submitted again, so the possibly applied effect is not duplicated.
  await assert.rejects(staged.submit(scope,message.id,registry,context),/not staged/);assert.deepEqual(keys,[]);
  staged.recoverAbandoned(scope,message.id);assert.equal(staged.get(scope,message.id).status,'uncertain');
  await assert.rejects(staged.submit(scope,message.id,registry,context),/not staged/);assert.deepEqual(keys,[]);
  // After the host verifies the effect was not applied, one retry reuses the original key.
  staged.reconcile(scope,message.id,'not_applied');
  assert.equal(await staged.submit(scope,message.id,registry,context),'charged');assert.deepEqual(keys,[message.key]);
  assert.equal(staged.get(scope,message.id).status,'succeeded');
  await assert.rejects(staged.submit(scope,message.id,registry,context),/not staged/);assert.deepEqual(keys,[message.key]);
 }finally{if(child){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}staged?.close();rmSync(dir,{recursive:true,force:true});}
});
