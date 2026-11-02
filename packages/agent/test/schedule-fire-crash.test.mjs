import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SqliteAgentRuns,SqliteAgentTriggers,SqliteAgentSchedules,SqliteAgentScheduleHistory} from '../dist/index.js';
const scope={tenantId:'tenant',agentId:'agent'},other={tenantId:'other',agentId:'agent'},config={enabled:true,principalId:'scheduler',rule:{kind:'interval',intervalMs:1000}},policy={definitionVersion:1,maxAttempts:2,runTimeoutMs:10000,maxPending:10};
async function killAtBarrier(path,barrier,phase){
 const child=fork(fileURLToPath(new URL('./fixtures/crash-schedule-fire.mjs',import.meta.url)),[path,barrier,phase],{stdio:['ignore','ignore','pipe','ipc']});let errors='',problem,exited=false;child.stderr.on('data',data=>errors+=String(data));child.on('message',message=>{if(message?.error)problem=message.error;});const exit=new Promise(resolve=>child.once('exit',()=>{exited=true;resolve();}));
 try{const limit=Date.now()+15000;while(!existsSync(barrier)){if(exited||problem)throw Error(`Worker exited before ${phase}: ${problem??errors}`);if(Date.now()>limit)throw Error(`Worker did not reach ${phase}`);await new Promise(resolve=>setTimeout(resolve,20));}child.kill('SIGKILL');await exit;}finally{if(!exited){child.kill('SIGKILL');await exit;}}
}
for(const phase of ['receipt','audit','after'])test(`scheduled activation survives process termination at ${phase}`,{timeout:30000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'schedule-fire-crash-')),path=join(dir,'db.sqlite'),barrier=join(dir,'barrier');let runs=new SqliteAgentRuns(path),triggers=new SqliteAgentTriggers(path),schedules=new SqliteAgentSchedules(path),history,db;
 try{
  schedules.save(scope,'timer',config,0,0,'admin');const foreign=schedules.save(other,'timer',config,0,0,'admin');schedules.close();triggers.close();runs.close();schedules=triggers=runs=undefined;
  await killAtBarrier(path,barrier,phase);db=new DatabaseSync(path);db.exec('DROP TRIGGER IF EXISTS test_schedule_crash');db.close();db=undefined;
  runs=new SqliteAgentRuns(path);triggers=new SqliteAgentTriggers(path);schedules=new SqliteAgentSchedules(path);history=new SqliteAgentScheduleHistory(path,{scope,authorize:()=>true});
  const committed=phase==='after',schedule=schedules.get(scope,'timer');assert.equal(schedule.revision,committed?2:1);assert.equal(schedule.nextAt,committed?2000:1000);assert.equal(runs.list(scope).length,committed?1:0);assert.equal(schedules.getOccurrence(scope,'timer',1,1000)!==undefined,committed);assert.equal((await history.list({tenantId:'tenant',principalId:'auditor'})).items.length,committed?2:1);
  if(!committed)schedules.fire(scope,'timer',1,policy,1000,'worker');
  const runId=schedules.getOccurrence(scope,'timer',1,1000);assert.ok(runId);assert.equal(runs.list(scope).length,1);assert.deepEqual(triggers.get(scope,runId).payload,{scheduleId:'timer',scheduledAt:1000});assert.throws(()=>schedules.fire(scope,'timer',1,policy,1000,'worker'),/revision conflict/);
  const events=(await history.list({tenantId:'tenant',principalId:'auditor'})).items;assert.deepEqual(events.map(x=>x.kind),['created','fired']);assert.equal(events[1].runId,runId);assert.equal(events[1].actorId,'worker');assert.deepEqual(schedules.get(other,'timer'),foreign);assert.equal(runs.list(other).length,0);
  db=new DatabaseSync(path,{readOnly:true});const receipts=db.prepare('SELECT received_at FROM agent_trigger_receipts WHERE tenant_id=? AND agent_id=? AND run_id=?').all(scope.tenantId,scope.agentId,runId);assert.deepEqual(receipts.map(row=>row.received_at),[1000]);
 }finally{db?.close();history?.close();schedules?.close();triggers?.close();runs?.close();rmSync(dir,{recursive:true,force:true});}
});
