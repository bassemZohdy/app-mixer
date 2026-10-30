import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {SqliteAgentRuns,SqliteAgentRunMetrics} from '../dist/index.js';

const scope={tenantId:'tenant-secret',agentId:'agent-secret'},actor={tenantId:'tenant-secret',principalId:'auditor-secret'},config={definitionVersion:1,maxAttempts:2,deadline:1000};
function setup(){const dir=mkdtempSync(join(tmpdir(),'agent-metrics-')),path=join(dir,'runs.sqlite'),runs=new SqliteAgentRuns(path);return {dir,path,runs};}

test('metrics reflect scoped durable states and archive flags across reopen',async()=>{
 const s=setup();let metrics;
 try{s.runs.create(scope,'queued-secret',config,0);let run=s.runs.create(scope,'completed-secret',config,0);run=s.runs.claim(scope,run.runId,run.revision,'worker-secret',100,1);run=s.runs.settle(scope,run.runId,run.revision,run.leaseToken,'succeeded',2);s.runs.archive(scope,run.runId,run.revision);s.runs.create({...scope,tenantId:'other'},'other',config,0);s.runs.create({...scope,agentId:'other'},'other',config,0);
  metrics=new SqliteAgentRunMetrics(s.path,{scope,authorize:()=>true});const snapshot=await metrics.snapshot(actor),find=(status,archived)=>snapshot.find(row=>row.status===status&&row.archived===archived).count;assert.equal(snapshot.length,18);assert.equal(find('queued',false),1);assert.equal(find('succeeded',true),1);assert.equal(find('succeeded',false),0);const text=await metrics.render(actor);assert.match(text,/app_mixer_agent_runs\{status="queued",archived="false"\} 1/);for(const secret of ['tenant-secret','agent-secret','queued-secret','worker-secret','auditor-secret'])assert.equal(text.includes(secret),false);metrics.close();metrics=new SqliteAgentRunMetrics(s.path,{scope,authorize:()=>true});assert.deepEqual(await metrics.snapshot(actor),snapshot);
 }finally{metrics?.close();s.runs.close();rmSync(s.dir,{recursive:true,force:true});}
});

test('metrics require aggregate authorization before and after the snapshot',async()=>{
 const s=setup();let metrics;try{s.runs.create(scope,'run',config,0);let calls=0;metrics=new SqliteAgentRunMetrics(s.path,{scope,authorize:async(who,selected)=>{calls++;assert.deepEqual(who,actor);assert.deepEqual(selected,scope);return calls===1;}});await assert.rejects(metrics.snapshot(actor),/access denied/);assert.equal(calls,2);await assert.rejects(metrics.snapshot({...actor,tenantId:'other'}),/actor/);assert.equal(calls,2);metrics.close();metrics=new SqliteAgentRunMetrics(s.path,{scope,authorize:()=>{throw Error('secret policy error');}});await assert.rejects(metrics.render(actor),/access denied/);}finally{metrics?.close();s.runs.close();rmSync(s.dir,{recursive:true,force:true});}
});

test('unexpected database states cannot create dynamic metric labels',async()=>{
 const s=setup();let metrics,db;try{s.runs.create(scope,'run',config,0);metrics=new SqliteAgentRunMetrics(s.path,{scope,authorize:()=>true});db=new DatabaseSync(s.path);db.prepare('UPDATE agent_runs SET status=? WHERE tenant_id=? AND agent_id=?').run('secret-status',scope.tenantId,scope.agentId);await assert.rejects(metrics.render(actor),/Invalid agent metrics data/);}finally{db?.close();metrics?.close();s.runs.close();rmSync(s.dir,{recursive:true,force:true});}
});


test('operational metrics measure scoped overdue queues and expired leases without identifiers',async()=>{
 const s=setup();let metrics;try{s.runs.create(scope,'queued',config,0);let paused=s.runs.create(scope,'paused',config,0);paused=s.runs.request(scope,'paused',paused.revision,'pause',1);let active=s.runs.create(scope,'active',config,0);active=s.runs.claim(scope,'active',active.revision,'worker',500,1,2);s.runs.create({...scope,tenantId:'other'},'hidden',config,0);s.runs.create(scope,'future',{...config,deadline:2000},0);metrics=new SqliteAgentRunMetrics(s.path,{scope,authorize:()=>true,includeOperational:true,clock:()=>1500});assert.deepEqual(await metrics.operational(actor),[{kind:'queued',count:1,oldestOverdueSeconds:0.5},{kind:'paused',count:1,oldestOverdueSeconds:0.5},{kind:'lease',count:1,oldestOverdueSeconds:0.999}]);const text=await metrics.render(actor);assert.match(text,/app_mixer_agent_overdue_runs\{kind="queued"\} 1/);assert.match(text,/app_mixer_agent_oldest_overdue_seconds\{kind="lease"\} 0\.999/);for(const secret of ['tenant-secret','agent-secret','queued','worker'])assert.equal(text.includes(secret),secret==='queued');let now=100;metrics.close();metrics=new SqliteAgentRunMetrics(s.path,{scope,authorize:()=>true,includeOperational:true,clock:()=>now});assert.ok((await metrics.operational(actor)).every(x=>x.count===0&&x.oldestOverdueSeconds===0));now=1500;assert.equal((await metrics.operational(actor)).find(x=>x.kind==='lease').count,1);
 }finally{metrics?.close();s.runs.close();rmSync(s.dir,{recursive:true,force:true});}
});

test('operational metrics require authorization and reject invalid clock and lease data',async()=>{
 const s=setup();let metrics,db;try{s.runs.create(scope,'run',config,0);let calls=0;metrics=new SqliteAgentRunMetrics(s.path,{scope,authorize:()=>++calls===1,includeOperational:true,clock:()=>1500});await assert.rejects(metrics.operational(actor),/access denied/);assert.equal(calls,2);metrics.close();metrics=new SqliteAgentRunMetrics(s.path,{scope,authorize:()=>true,clock:()=>NaN});await assert.rejects(metrics.operational(actor),/clock/);metrics.close();metrics=new SqliteAgentRunMetrics(s.path,{scope,authorize:()=>true,clock:()=>1500});db=new DatabaseSync(s.path);db.prepare("UPDATE agent_runs SET status='running', lease_until=NULL WHERE tenant_id=? AND agent_id=?").run(scope.tenantId,scope.agentId);await assert.rejects(metrics.operational(actor),/Invalid agent metrics data/);
 }finally{db?.close();metrics?.close();s.runs.close();rmSync(s.dir,{recursive:true,force:true});}
});
