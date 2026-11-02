import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {SqliteAgentRuns,SqliteAgentTriggers,SqliteAgentSchedules,SqliteAgentScheduleMetrics,SqliteAgentRunMetrics,createAgentMetricsServer} from '../dist/index.js';
const scope={tenantId:'tenant-secret',agentId:'agent-secret'},actor={tenantId:'tenant-secret',principalId:'reader-secret'},config={enabled:true,principalId:'scheduler-secret',rule:{kind:'interval',intervalMs:1000}};
function setup(){const dir=mkdtempSync(join(tmpdir(),'schedule-metrics-')),path=join(dir,'db.sqlite'),runs=new SqliteAgentRuns(path),triggers=new SqliteAgentTriggers(path),schedules=new SqliteAgentSchedules(path);return {dir,path,runs,triggers,schedules};}
function close(s){s.schedules.close();s.triggers.close();s.runs.close();rmSync(s.dir,{recursive:true,force:true});}

test('schedule gauges track scoped due backlog and change after an occurrence',async()=>{
 const s=setup();let metrics,server;try{const due=s.schedules.save(scope,'private-due',config,0,0);s.schedules.save(scope,'private-future',config,0,1000);s.schedules.save(scope,'private-disabled',{...config,enabled:false},0,0);s.schedules.save({...scope,tenantId:'other'},'foreign',config,0,0);s.schedules.save({...scope,agentId:'other'},'foreign',config,0,0);metrics=new SqliteAgentScheduleMetrics(s.path,{scope,clock:()=>1500,authorize:()=>true});assert.deepEqual(await metrics.snapshot(actor),{due:1,upcoming:1,disabled:1,oldestDueSeconds:0.5});const text=await metrics.render(actor);assert.match(text,/app_mixer_agent_schedules\{state="due"\} 1/);assert.match(text,/app_mixer_agent_oldest_schedule_due_seconds 0\.5/);for(const secret of ['tenant-secret','agent-secret','reader-secret','private-due','scheduler-secret'])assert.equal(text.includes(secret),false);s.schedules.fire(scope,'private-due',due.revision,{definitionVersion:1,maxAttempts:2,runTimeoutMs:10000,maxPending:10},1500);assert.deepEqual(await metrics.snapshot(actor),{due:0,upcoming:2,disabled:1,oldestDueSeconds:0});server=createAgentMetricsServer({metrics,authenticate:req=>req.headers.authorization==='Bearer allowed'?actor:undefined,timeoutMs:1000,maxPending:2});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}/metrics`;assert.equal((await fetch(url)).status,401);assert.match(await (await fetch(url,{headers:{authorization:'Bearer allowed'}})).text(),/app_mixer_agent_schedules\{state="upcoming"\} 2/);
 }finally{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}metrics?.close();close(s);}
});

test('schedule gauges recheck authorization and fail closed on invalid data',async()=>{
 const s=setup();let metrics,db;try{s.schedules.save(scope,'one',config,0,0);let checks=0;metrics=new SqliteAgentScheduleMetrics(s.path,{scope,clock:()=>1500,authorize:()=>++checks===1});await assert.rejects(metrics.snapshot(actor),/access denied/);assert.equal(checks,2);await assert.rejects(metrics.snapshot({...actor,tenantId:'other'}),/actor/);metrics.close();metrics=new SqliteAgentScheduleMetrics(s.path,{scope,clock:()=>NaN,authorize:()=>true});await assert.rejects(metrics.snapshot(actor),/clock/);metrics.close();metrics=new SqliteAgentScheduleMetrics(s.path,{scope,clock:()=>1500,authorize:()=>true});db=new DatabaseSync(s.path);db.prepare('UPDATE agent_schedules SET enabled=2 WHERE tenant_id=? AND agent_id=?').run(scope.tenantId,scope.agentId);await assert.rejects(metrics.render(actor),/Invalid schedule metrics data/);db.prepare("UPDATE agent_schedules SET enabled=1,next_at='invalid' WHERE tenant_id=? AND agent_id=?").run(scope.tenantId,scope.agentId);await assert.rejects(metrics.render(actor),/Invalid schedule metrics data/);
 }finally{db?.close();metrics?.close();close(s);}
});


test('combined run and schedule scrape uses one read snapshot and clock sample',async()=>{
 const s=setup();let metrics,writer;try{s.schedules.save(scope,'due',config,0,0);s.runs.create(scope,'queued',{definitionVersion:1,maxAttempts:2,deadline:1000},0);writer=new DatabaseSync(s.path);writer.exec('PRAGMA journal_mode=WAL');let changed=false,calls=0;metrics=new SqliteAgentRunMetrics(s.path,{scope,includeOperational:true,includeScheduleBacklog:true,authorize:()=>true,clock:()=>{calls++;if(!changed){changed=true;writer.prepare("UPDATE agent_runs SET status='failed' WHERE tenant_id=? AND agent_id=? AND run_id=?").run(scope.tenantId,scope.agentId,'queued');writer.prepare("UPDATE agent_schedules SET enabled=0 WHERE tenant_id=? AND agent_id=? AND schedule_id=?").run(scope.tenantId,scope.agentId,'due');}return 1500;}});const first=await metrics.render(actor);assert.equal(calls,1);assert.match(first,/app_mixer_agent_runs\{status="queued",archived="false"\} 1/);assert.match(first,/app_mixer_agent_overdue_runs\{kind="queued"\} 1/);assert.match(first,/app_mixer_agent_schedules\{state="due"\} 1/);const second=await metrics.render(actor);assert.equal(calls,2);assert.match(second,/app_mixer_agent_runs\{status="queued",archived="false"\} 0/);assert.match(second,/app_mixer_agent_schedules\{state="due"\} 0/);assert.match(second,/app_mixer_agent_schedules\{state="disabled"\} 1/);
 }finally{metrics?.close();writer?.close();close(s);}
});

test('combined schedule metrics require aggregate permission and reject invalid configuration',async()=>{
 const s=setup();let metrics;try{s.schedules.save(scope,'due',config,0,0);assert.throws(()=>new SqliteAgentRunMetrics(s.path,{scope,authorize:()=>true,includeScheduleBacklog:'yes'}),/configuration/);let checks=0;metrics=new SqliteAgentRunMetrics(s.path,{scope,includeScheduleBacklog:true,authorize:()=>++checks===1,clock:()=>1500});await assert.rejects(metrics.render(actor),/access denied/);assert.equal(checks,2);metrics.close();metrics=new SqliteAgentRunMetrics(s.path,{scope,authorize:()=>true});assert.doesNotMatch(await metrics.render(actor),/app_mixer_agent_schedules/);
 }finally{metrics?.close();close(s);}
});
