import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SqliteAgentRuns,SqliteAgentDelegations} from '../dist/index.js';

const scope={tenantId:'tenant',agentId:'agent'},admin={tenantId:'tenant',principalId:'admin'},worker={tenantId:'tenant',principalId:'worker'},workerPath=fileURLToPath(new URL('./fixtures/crash-delegation-worker.mjs',import.meta.url));
const authorize=(actor,action)=>actor.principalId==='admin'||(actor.principalId==='worker'&&action==='verify');

for(const mode of ['issued','renewed'])test(`process kill after a delegation grant is ${mode} preserves revision, expiry and revocation fencing`,{timeout:30000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'agent-delegation-crash-')),path=join(dir,'runs.sqlite');let runs,store,child,now=10;
 try{
  runs=new SqliteAgentRuns(path);runs.create(scope,'run',{definitionVersion:1,maxAttempts:3,deadline:1000},0);
  child=fork(workerPath,[path,mode],{stdio:['ignore','ignore','ignore','ipc']});
  const [message]=await Promise.race([once(child,'message'),once(child,'exit').then(([code,signal])=>{throw Error(`worker exited early (${code??signal})`);})]);assert.equal(message.type,mode);
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;child=undefined;

  store=new SqliteAgentDelegations(path,{scope,runId:'run',authorize,clock:()=>now});
  const revision=mode==='issued'?1:2,expiresAt=mode==='issued'?50:100,record=await store.get(admin,'grant');
  assert.equal(record.revision,revision);assert.equal(record.grant.expiresAt,expiresAt);
  assert.deepEqual((await store.history(admin,'grant')).map(event=>event.event),mode==='issued'?['issued']:['issued','renewed']);
  // Another tenant's actor is rejected; the worker may verify but not read.
  await assert.rejects(store.verify({tenantId:'other',principalId:'worker'},record.grant),/actor/);
  await assert.rejects(store.get(worker,'grant'),/denied/);
  assert.equal(await store.verify(worker,record.grant),true);
  // The grant stops verifying at its expiry.
  now=expiresAt;assert.equal(await store.verify(worker,record.grant),false);now=10;
  // A stale revision cannot renew or revoke; the current revision revokes exactly once.
  await assert.rejects(store.renew(admin,'grant',revision-1||99,'v9',200));
  await assert.rejects(store.revoke(admin,'grant',revision+1));
  assert.equal((await store.revoke(admin,'grant',revision)).revision,revision+1);
  assert.equal(await store.verify(worker,record.grant),false);
  await assert.rejects(store.revoke(admin,'grant',revision));
  assert.deepEqual((await store.history(admin,'grant')).map(event=>event.event).at(-1),'revoked');
 }finally{if(child){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}store?.close();runs?.close();rmSync(dir,{recursive:true,force:true});}
});
