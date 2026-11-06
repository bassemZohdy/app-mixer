import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {SqliteAgentRuns,SqliteAgentTriggers,SqliteAgentSchedules,SqliteAgentActionJournal,SqliteAgentRunMetrics} from '../dist/index.js';

const scope={tenantId:'tenant',agentId:'agent'},other={tenantId:'other',agentId:'agent'},actor={tenantId:'tenant',principalId:'auditor'},interval=ms=>({enabled:true,principalId:'scheduler',rule:{kind:'interval',intervalMs:ms}});
function setup(){
 const dir=mkdtempSync(join(tmpdir(),'agent-backlog-metrics-')),path=join(dir,'runs.sqlite'),runs=new SqliteAgentRuns(path),triggers=new SqliteAgentTriggers(path),schedules=new SqliteAgentSchedules(path);
 runs.create(scope,'run',{definitionVersion:1,maxAttempts:2,deadline:100000},0);const claimed=runs.claim(scope,'run',runs.get(scope,'run').revision,'worker',60000,0);
 const journal=new SqliteAgentActionJournal(path,{scope,runId:'run',leaseToken:claimed.leaseToken,clock:()=>0});journal.close();
 return {dir,path,runs,triggers,schedules,close(){schedules.close();triggers.close();runs.close();rmSync(dir,{recursive:true,force:true});}};
}
const insertAction=(path,target,actionId,status)=>{const db=new DatabaseSync(path);try{db.prepare('INSERT INTO agent_action_journal (tenant_id,agent_id,run_id,action_id,operation_id,input_json,input_hash,idempotency_key,status,attempts,max_attempts,result_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)').run(target.tenantId,target.agentId,'run',actionId,'operation','{}','hash',target.tenantId+':'+actionId,status,1,2);}finally{db.close();}};

test('schedule backlog counts only enabled, due and unfired occurrences in scope',async()=>{
 const s=setup();let metrics;try{
  s.schedules.save(scope,'late',interval(1000),0,1000);s.schedules.save(scope,'recent',interval(3000),0,1000);s.schedules.save(scope,'future',interval(60000),0,1000);s.schedules.save(scope,'off',{...interval(1000),enabled:false},0,0);s.schedules.save(other,'elsewhere',interval(1000),0,0);
  let now=4000;metrics=new SqliteAgentRunMetrics(s.path,{scope,authorize:()=>true,includeSchedules:true,clock:()=>now});
  // late is due at 2000 and recent at 4000; future is not due and off is disabled; the other tenant is not counted.
  assert.deepEqual(await metrics.schedules(actor),{due:2,oldestDueSeconds:2});
  const late=s.schedules.get(scope,'late');s.schedules.fire(scope,'late',late.revision,{definitionVersion:1,maxAttempts:1,runTimeoutMs:10000,maxPending:10},4000);
  assert.deepEqual(await metrics.schedules(actor),{due:2,oldestDueSeconds:1},'late advanced to 3000 and is still behind');
  now=1500;assert.deepEqual(await metrics.schedules(actor),{due:0,oldestDueSeconds:0});
  now=4000;const text=await metrics.render(actor);assert.match(text,/^app_mixer_agent_due_schedules 2$/m);assert.match(text,/^app_mixer_agent_oldest_due_schedule_seconds 1$/m);assert.doesNotMatch(text,/app_mixer_agent_actions/);assert.doesNotMatch(text,/late|recent|tenant/);
  await assert.rejects(metrics.actions(actor),/not enabled/);await assert.rejects(metrics.schedules({...actor,tenantId:'other'}),/actor/);
  const denied=new SqliteAgentRunMetrics(s.path,{scope,authorize:()=>false,includeSchedules:true});try{await assert.rejects(denied.schedules(actor),/denied/);}finally{denied.close();}
  const badClock=new SqliteAgentRunMetrics(s.path,{scope,authorize:()=>true,includeSchedules:true,clock:()=>-1});try{await assert.rejects(badClock.schedules(actor),/clock/);}finally{badClock.close();}
 }finally{metrics?.close();s.close();}
});

test('action metrics report every journal state with fixed labels and reject unknown states',async()=>{
 const s=setup();let metrics;try{
  insertAction(s.path,scope,'a','ready');insertAction(s.path,scope,'b','dispatching');insertAction(s.path,scope,'c','uncertain');insertAction(s.path,scope,'d','uncertain');insertAction(s.path,scope,'e','succeeded');insertAction(s.path,other,'f','uncertain');
  metrics=new SqliteAgentRunMetrics(s.path,{scope,authorize:()=>true,includeActions:true});
  assert.deepEqual(await metrics.actions(actor),[{status:'ready',count:1},{status:'dispatching',count:1},{status:'uncertain',count:2},{status:'succeeded',count:1},{status:'failed',count:0}]);
  const text=await metrics.render(actor);assert.match(text,/^app_mixer_agent_actions\{status="uncertain"\} 2$/m);assert.match(text,/^app_mixer_agent_actions\{status="failed"\} 0$/m);assert.doesNotMatch(text,/app_mixer_agent_due_schedules/);
  await assert.rejects(metrics.schedules(actor),/not enabled/);
  insertAction(s.path,scope,'g','mystery');await assert.rejects(metrics.actions(actor),/Invalid agent metrics data/);
 }finally{metrics?.close();s.close();}
});

test('backlog metrics are opt-in and require their tables',()=>{
 const dir=mkdtempSync(join(tmpdir(),'agent-backlog-metrics-')),path=join(dir,'runs.sqlite'),runs=new SqliteAgentRuns(path);
 try{
  for(const bad of [{includeSchedules:'yes'},{includeActions:1}])assert.throws(()=>new SqliteAgentRunMetrics(path,{scope,authorize:()=>true,...bad}),/Invalid agent metrics configuration/);
  assert.throws(()=>new SqliteAgentRunMetrics(path,{scope,authorize:()=>true,includeSchedules:true}),/unavailable/);assert.throws(()=>new SqliteAgentRunMetrics(path,{scope,authorize:()=>true,includeActions:true}),/unavailable/);
  const plain=new SqliteAgentRunMetrics(path,{scope,authorize:()=>true});plain.close();
 }finally{runs.close();rmSync(dir,{recursive:true,force:true});}
});
