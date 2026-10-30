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
