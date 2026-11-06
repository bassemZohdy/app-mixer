import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SqliteAgentRuns,SqliteAgentApprovals} from '../dist/index.js';

const scope={tenantId:'tenant',agentId:'agent'},service={tenantId:'tenant',principalId:'service'},human={tenantId:'tenant',principalId:'human'},stranger={tenantId:'other',principalId:'human'},workerPath=fileURLToPath(new URL('./fixtures/crash-approval-worker.mjs',import.meta.url));
const authorize=(actor,action)=>actor.principalId==='service'?action==='request':actor.principalId==='human';

for(const mode of ['requested','decided'])test(`process kill after an approval is ${mode} preserves the durable record, history and decision rules`,{timeout:30000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'agent-approval-crash-')),path=join(dir,'runs.sqlite');let runs,approvals,child,now=10;
 try{
  runs=new SqliteAgentRuns(path);let run=runs.create(scope,'run',{definitionVersion:1,maxAttempts:3,deadline:1000},0);run=runs.claim(scope,'run',run.revision,'worker',100,10);
  child=fork(workerPath,[path,run.leaseToken,mode],{stdio:['ignore','ignore','ignore','ipc']});
  const [message]=await Promise.race([once(child,'message'),once(child,'exit').then(([code,signal])=>{throw Error(`worker exited early (${code??signal})`);})]);assert.equal(message.type,mode);
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;child=undefined;

  approvals=new SqliteAgentApprovals(path,{scope,runId:'run',clock:()=>now,authorize});
  const record=await approvals.get(human,'action');
  assert.equal(await approvals.isBoundTo?.(scope,'run'),true);
  // Another tenant's actor cannot see or change the record.
  await assert.rejects(approvals.get(stranger,'action'),/actor/);
  await assert.rejects(approvals.decide(stranger,'action','approved'));
  if(mode==='requested'){
   assert.equal(record.status,'pending');assert.deepEqual((await approvals.history(human,'action')).map(event=>event.event),['requested']);
   // The service principal that requested it cannot decide, and a human decision is recorded exactly once.
   await assert.rejects(approvals.decide(service,'action','approved'),/access denied/);
   assert.equal((await approvals.decide(human,'action','approved')).decidedBy,'human');
   await assert.rejects(approvals.decide(human,'action','approved'),/already decided/);
   assert.deepEqual((await approvals.history(human,'action')).map(event=>event.event),['requested','approved']);
  }else{
   assert.equal(record.status,'approved');assert.equal(record.decidedBy,'human');
   assert.deepEqual((await approvals.history(human,'action')).map(event=>event.event),['requested','approved']);
   await assert.rejects(approvals.decide(human,'action','rejected'),/already decided/);
   assert.deepEqual((await approvals.history(human,'action')).map(event=>event.event),['requested','approved']);
  }
 }finally{if(child){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}approvals?.close();runs?.close();rmSync(dir,{recursive:true,force:true});}
});

test('an approval left pending by a killed process expires and can no longer be decided',{timeout:30000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'agent-approval-expiry-')),path=join(dir,'runs.sqlite');let runs,approvals,child,now=10;
 try{
  runs=new SqliteAgentRuns(path);let run=runs.create(scope,'run',{definitionVersion:1,maxAttempts:3,deadline:1000},0);run=runs.claim(scope,'run',run.revision,'worker',100,10);
  child=fork(workerPath,[path,run.leaseToken,'requested'],{stdio:['ignore','ignore','ignore','ipc']});await once(child,'message');const exited=once(child,'exit');child.kill('SIGKILL');await exited;child=undefined;
  approvals=new SqliteAgentApprovals(path,{scope,runId:'run',clock:()=>now,authorize});
  now=90;assert.equal((await approvals.get(human,'action')).status,'expired');
  await assert.rejects(approvals.decide(human,'action','approved'));
 }finally{if(child){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}approvals?.close();runs?.close();rmSync(dir,{recursive:true,force:true});}
});
