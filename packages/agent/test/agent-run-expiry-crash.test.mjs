import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SqliteAgentRuns,AgentRunExpiryWorker,SqliteAgentExpiryHistory} from '../dist/index.js';
const scope={tenantId:'tenant',agentId:'agent'},other={tenantId:'other',agentId:'agent'},actor={tenantId:'tenant',principalId:'auditor'},config={definitionVersion:1,maxAttempts:2,deadline:100};
async function killAtBarrier(path,barrier,phase){
 const child=fork(fileURLToPath(new URL('./fixtures/crash-run-expiry.mjs',import.meta.url)),[path,barrier,phase],{stdio:['ignore','ignore','pipe','ipc']});let errors='',problem,exited=false;child.stderr.on('data',data=>errors+=String(data));child.on('message',message=>{if(message?.error)problem=message.error;});const exit=new Promise(resolve=>child.once('exit',()=>{exited=true;resolve();}));
 try{const limit=Date.now()+15000;while(!existsSync(barrier)){if(exited||problem)throw Error(`Worker exited before ${phase}: ${problem??errors}`);if(Date.now()>limit)throw Error(`Worker did not reach ${phase}`);await new Promise(resolve=>setTimeout(resolve,20));}child.kill('SIGKILL');await exit;}finally{if(!exited){child.kill('SIGKILL');await exit;}}
}
for(const phase of ['during','after'])test(`expiry state and evidence survive process termination ${phase} commit`,{timeout:30000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'agent-expiry-crash-')),path=join(dir,'db.sqlite'),barrier=join(dir,'barrier');let runs=new SqliteAgentRuns(path),history,db;
 try{
  const original=runs.create(scope,'run',config,0),foreign=runs.create(other,'run',config,0);runs.close();runs=undefined;await killAtBarrier(path,barrier,phase);
  db=new DatabaseSync(path);db.exec('DROP TRIGGER IF EXISTS test_crash_expiry');db.close();db=undefined;runs=new SqliteAgentRuns(path);history=new SqliteAgentExpiryHistory(path,{scope,authorize:()=>true});
  let run=runs.get(scope,'run'),events=(await history.list(actor)).items;assert.equal(run.status,phase==='after'?'failed':'queued');assert.equal(run.revision,original.revision+(phase==='after'?1:0));assert.equal(events.length,phase==='after'?1:0);assert.equal(runs.get(other,'run').status,'queued');assert.equal(runs.get(other,'run').revision,foreign.revision);
  db=new DatabaseSync(path);assert.equal(db.prepare('SELECT count(*) AS n FROM agent_run_terminal_times WHERE tenant_id=? AND agent_id=? AND run_id=?').get('tenant','agent','run').n,phase==='after'?1:0);db.close();db=undefined;
  const worker=new AgentRunExpiryWorker({runs,scope,maxPerPass:5,pollMs:100,clock:()=>100,authorizationTimeoutMs:1000,maxPendingAuthorizations:1,authorize:()=>true,onError:()=>{},evidence:{principalId:'operator',reference:'case'}});assert.equal(await worker.runOnce(),phase==='after'?0:1);assert.equal(await worker.runOnce(),0);run=runs.get(scope,'run');events=(await history.list(actor)).items;assert.equal(run.status,'failed');assert.equal(events.length,1);assert.equal(events[0].principalId,'operator');assert.equal(events[0].reference,'case');assert.equal(runs.get(other,'run').status,'queued');await worker.stop();
 }finally{db?.close();history?.close();runs?.close();rmSync(dir,{recursive:true,force:true});}
});
