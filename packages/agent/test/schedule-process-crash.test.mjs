import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SqliteAgentRuns,SqliteAgentTriggers,SqliteAgentSchedules} from '../dist/index.js';

const scope={tenantId:'tenant',agentId:'agent'},other={tenantId:'other',agentId:'agent'},policy={definitionVersion:1,maxAttempts:2,runTimeoutMs:10000,maxPending:10},workerPath=fileURLToPath(new URL('./fixtures/crash-schedule-worker.mjs',import.meta.url));
const killWorker=async(path,mode,expected)=>{const child=fork(workerPath,[path,mode],{stdio:['ignore','ignore','ignore','ipc']});try{const [message]=await Promise.race([once(child,'message'),once(child,'exit').then(([code,signal])=>{throw Error(`worker exited early (${code??signal})`);})]);assert.equal(message.type,expected);return message;}finally{const exited=once(child,'exit');child.kill('SIGKILL');await exited;}};

for(const mode of ['before','after'])test(`process kill ${mode} a schedule fire leaves one consistent run and no duplicate after reopen`,{timeout:30000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'agent-schedule-crash-')),path=join(dir,'runs.sqlite');let runs,triggers,schedules;
 try{
  const message=await killWorker(path,mode,mode==='before'?'saved':'fired');
  runs=new SqliteAgentRuns(path);triggers=new SqliteAgentTriggers(path);schedules=new SqliteAgentSchedules(path);
  const schedule=schedules.get(scope,'daily');assert.ok(schedule);assert.equal(runs.list(other).length,0);
  if(mode==='before'){
   // Killed before the fire: nothing was created and the due occurrence is still fireable exactly once.
   assert.equal(runs.list(scope).length,0);assert.equal(schedule.nextAt,2000);
   const fired=schedules.fire(scope,'daily',schedule.revision,policy,2000);assert.equal(fired.scheduledAt,2000);assert.equal(runs.list(scope).length,1);
   assert.throws(()=>schedules.fire(scope,'daily',schedule.revision,policy,2000));
  }else{
   // Killed after the fire committed: the run exists once, the schedule advanced, and the old revision cannot fire it again.
   const list=runs.list(scope);assert.equal(list.length,1);assert.equal(list[0].runId??list[0].id,message.runId);assert.equal(runs.get(scope,message.runId).status,'queued');
   assert.ok(schedule.nextAt>2000);assert.equal(triggers.get(scope,message.runId).sourceId.startsWith('schedule.'),true);
   assert.throws(()=>schedules.fire(scope,'daily',schedule.revision-1,policy,2000));
   assert.equal(runs.list(scope).length,1);
  }
 }finally{schedules?.close();triggers?.close();runs?.close();rmSync(dir,{recursive:true,force:true});}
});
