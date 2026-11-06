import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SqliteAgentRuns} from '../dist/index.js';

const scope={tenantId:'tenant',agentId:'agent'},other={tenantId:'other',agentId:'agent'},workerPath=fileURLToPath(new URL('./fixtures/crash-lease-worker.mjs',import.meta.url));

test('a worker killed while holding a lease is recovered only after expiry, fenced from its old token and retried once',{timeout:30000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'agent-lease-crash-')),path=join(dir,'runs.sqlite');let runs,child;
 try{
  runs=new SqliteAgentRuns(path);runs.create(scope,'run',{definitionVersion:1,maxAttempts:3,deadline:10000},0);runs.create(other,'run',{definitionVersion:1,maxAttempts:3,deadline:10000},0);runs.close();runs=undefined;
  child=fork(workerPath,[path],{stdio:['ignore','ignore','ignore','ipc']});
  const [claimed]=await Promise.race([once(child,'message'),once(child,'exit').then(([code,signal])=>{throw Error(`worker exited early (${code??signal})`);})]);assert.equal(claimed.type,'claimed');
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;child=undefined;

  runs=new SqliteAgentRuns(path);
  const running=runs.get(scope,'run');assert.equal(running.status,'running');assert.equal(running.attempts,1);
  // The unexpired lease is not recoverable and cannot be claimed over.
  assert.throws(()=>runs.recoverExpired(scope,'run',running.revision,50));
  assert.throws(()=>runs.claim(scope,'run',running.revision,'second-worker',100,50));
  // After expiry the record becomes uncertain; it is never silently retried.
  const uncertain=runs.recoverExpired(scope,'run',running.revision,200);assert.equal(uncertain.status,'uncertain');
  assert.throws(()=>runs.recoverExpired(scope,'run',running.revision,200),'a stale revision cannot recover twice');
  // The dead worker's token can no longer settle or renew.
  assert.throws(()=>runs.settle(scope,'run',uncertain.revision,claimed.leaseToken,'succeeded',210));
  assert.throws(()=>runs.renew(scope,'run',uncertain.revision,claimed.leaseToken,100,210));
  // Explicit reconciliation requeues it; the next claim is a second attempt with a fresh token.
  const retry=runs.reconcile(scope,'run',uncertain.revision,'retry',220);assert.equal(retry.status,'queued');
  const again=runs.claim(scope,'run',retry.revision,'recovery-worker',100,230);assert.equal(again.status,'running');assert.equal(again.attempts,2);assert.notEqual(again.leaseToken,claimed.leaseToken);
  assert.throws(()=>runs.settle(scope,'run',again.revision,claimed.leaseToken,'succeeded',240));
  assert.equal(runs.settle(scope,'run',again.revision,again.leaseToken,'succeeded',240).status,'succeeded');
  // Another tenant's run with the same ID is untouched.
  assert.equal(runs.get(other,'run').status,'queued');assert.equal(runs.get(other,'run').attempts,0);
 }finally{if(child){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}runs?.close();rmSync(dir,{recursive:true,force:true});}
});
