import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {SqliteAgentRuns,SqliteAgentActionJournal,SqliteAgentRunMetrics} from '../dist/index.js';
const scope={tenantId:'tenant-secret',agentId:'agent-secret'},actor={tenantId:'tenant-secret',principalId:'operator-secret'},config={definitionVersion:1,maxAttempts:2,deadline:1000};

test('scoped action backlog shows unresolved entries by run state and follows reconciliation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'action-metrics-')),path=join(dir,'runs.sqlite'),runs=new SqliteAgentRuns(path);let journal,metrics,foreign,db;
 try{
  let run=runs.create(scope,'run-secret',config,0);run=runs.claim(scope,run.runId,run.revision,'worker-secret',100,1);journal=new SqliteAgentActionJournal(path,{scope,runId:run.runId,leaseToken:run.leaseToken,clock:()=>2});
  await assert.rejects(journal.invoke('action-secret','operation',{},2,async()=>{throw Error('unknown')}),/uncertain/);
  run=runs.settle(scope,run.runId,run.revision,run.leaseToken,'uncertain',3);
  const other={...scope,tenantId:'other'};let otherRun=runs.create(other,'other-run',config,0);otherRun=runs.claim(other,otherRun.runId,otherRun.revision,'worker',100,1);foreign=new SqliteAgentActionJournal(path,{scope:other,runId:otherRun.runId,leaseToken:otherRun.leaseToken,clock:()=>2});await assert.rejects(foreign.invoke('other-action','operation',{},2,async()=>{throw Error('unknown')}),/uncertain/);
  metrics=new SqliteAgentRunMetrics(path,{scope,includeActionBacklog:true,authorize:()=>true});let data=await metrics.actionBacklog(actor);assert.equal(data.length,18);assert.equal(data.find(x=>x.actionStatus==='uncertain'&&x.runStatus==='uncertain').count,1);assert.equal(data.reduce((sum,x)=>sum+x.count,0),1);
  db=new DatabaseSync(path);db.prepare("UPDATE agent_action_journal SET status='dispatching' WHERE tenant_id=? AND agent_id=?").run(scope.tenantId,scope.agentId);assert.equal((await metrics.actionBacklog(actor)).find(x=>x.actionStatus==='dispatching'&&x.runStatus==='uncertain').count,1);db.prepare("UPDATE agent_action_journal SET status='uncertain' WHERE tenant_id=? AND agent_id=?").run(scope.tenantId,scope.agentId);const text=await metrics.render(actor);assert.match(text,/app_mixer_agent_action_backlog\{action_status="uncertain",run_status="uncertain"\} 1/);for(const secret of ['tenant-secret','agent-secret','run-secret','action-secret','operator-secret','worker-secret'])assert.equal(text.includes(secret),false);
  journal.reconcile('action-secret','applied',{ok:true});data=await metrics.actionBacklog(actor);assert.equal(data.reduce((sum,x)=>sum+x.count,0),0);
 }finally{db?.close();metrics?.close();foreign?.close();journal?.close();runs.close();rmSync(dir,{recursive:true,force:true});}
});

test('backlog metrics require policy on both sides of the read and fail on orphaned actions',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'action-metrics-')),path=join(dir,'runs.sqlite'),runs=new SqliteAgentRuns(path);let journal,metrics,db;
 try{
  let run=runs.create(scope,'run',config,0);run=runs.claim(scope,'run',run.revision,'worker',100,1);journal=new SqliteAgentActionJournal(path,{scope,runId:'run',leaseToken:run.leaseToken,clock:()=>2});await assert.rejects(journal.invoke('action','operation',{},2,async()=>{throw Error('unknown')}),/uncertain/);
  let calls=0;metrics=new SqliteAgentRunMetrics(path,{scope,includeActionBacklog:true,authorize:()=>++calls===1});await assert.rejects(metrics.actionBacklog(actor),/access denied/);assert.equal(calls,2);metrics.close();
  metrics=new SqliteAgentRunMetrics(path,{scope,includeActionBacklog:true,authorize:()=>true});db=new DatabaseSync(path);db.prepare('UPDATE agent_action_journal SET run_id=? WHERE tenant_id=? AND agent_id=?').run('missing',scope.tenantId,scope.agentId);await assert.rejects(metrics.render(actor),/Invalid agent action metrics data/);db.prepare('UPDATE agent_action_journal SET run_id=? WHERE tenant_id=? AND agent_id=?').run('run',scope.tenantId,scope.agentId);assert.match(await metrics.render(actor),/app_mixer_agent_action_backlog/);
 }finally{db?.close();metrics?.close();journal?.close();runs.close();rmSync(dir,{recursive:true,force:true});}
});
