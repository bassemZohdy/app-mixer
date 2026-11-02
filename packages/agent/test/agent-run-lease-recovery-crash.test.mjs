import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SqliteAgentRuns,AgentRunLeaseRecoveryWorker,SqliteAgentLeaseRecoveryHistory} from '../dist/index.js';
const scope={tenantId:'tenant',agentId:'agent'},other={tenantId:'other',agentId:'agent'},actor={tenantId:'tenant',principalId:'auditor'},config={definitionVersion:1,maxAttempts:2,deadline:1000};
async function killAtBarrier(path,barrier,phase){
 const child=fork(fileURLToPath(new URL('./fixtures/crash-run-lease-recovery.mjs',import.meta.url)),[path,barrier,phase],{stdio:['ignore','ignore','pipe','ipc']});let errors='',problem,exited=false;child.stderr.on('data',data=>errors+=String(data));child.on('message',message=>{if(message?.error)problem=message.error;});const exit=new Promise(resolve=>child.once('exit',()=>{exited=true;resolve();}));
 try{const limit=Date.now()+15000;while(!existsSync(barrier)){if(exited||problem)throw Error(`Worker exited before ${phase}: ${problem??errors}`);if(Date.now()>limit)throw Error(`Worker did not reach ${phase}`);await new Promise(resolve=>setTimeout(resolve,20));}child.kill('SIGKILL');await exit;}finally{if(!exited){child.kill('SIGKILL');await exit;}}
}
for(const phase of ['during','after'])test(`lease recovery evidence survives process termination ${phase} commit`,{timeout:30000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'lease-recovery-crash-')),path=join(dir,'db.sqlite'),barrier=join(dir,'barrier');let runs=new SqliteAgentRuns(path),history,db;
 try{
  const create=target=>{const run=runs.create(target,'run',config,0);return runs.claim(target,'run',run.revision,'worker',50,10);},original=create(scope),outside=create(other);runs.close();runs=undefined;await killAtBarrier(path,barrier,phase);
  db=new DatabaseSync(path);db.exec('DROP TRIGGER IF EXISTS test_crash_lease_recovery');db.close();db=undefined;runs=new SqliteAgentRuns(path);history=new SqliteAgentLeaseRecoveryHistory(path,{scope,authorize:()=>true});let current=runs.get(scope,'run'),events=(await history.list(actor)).items;assert.equal(current.status,phase==='after'?'uncertain':'running');assert.equal(current.revision,original.revision+(phase==='after'?1:0));assert.equal(current.leaseToken,phase==='after'?null:original.leaseToken);assert.equal(events.length,phase==='after'?1:0);assert.equal(runs.get(other,'run').revision,outside.revision);assert.equal(runs.get(other,'run').status,'running');
  const worker=new AgentRunLeaseRecoveryWorker({runs,scope,maxPerPass:5,pollMs:100,clock:()=>100,authorizationTimeoutMs:1000,maxPendingAuthorizations:1,authorize:()=>true,onError:()=>{},evidence:{principalId:'operator',reference:'ticket-1'}});assert.equal(await worker.runOnce(),phase==='after'?0:1);assert.equal(await worker.runOnce(),0);current=runs.get(scope,'run');events=(await history.list(actor)).items;assert.equal(current.status,'uncertain');assert.equal(events.length,1);assert.equal(events[0].id,1);assert.equal(events[0].principalId,'operator');assert.equal(events[0].reference,'ticket-1');assert.equal(runs.get(other,'run').status,'running');await worker.stop();
 }finally{db?.close();history?.close();runs?.close();rmSync(dir,{recursive:true,force:true});}
});
