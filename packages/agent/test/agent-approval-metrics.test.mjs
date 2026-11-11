import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {SqliteAgentApprovals,SqliteAgentRuns,SqliteAgentRunMetrics} from '../dist/index.js';

const scope={tenantId:'tenant',agentId:'agent'},other={tenantId:'other',agentId:'agent'},actor={tenantId:'tenant',principalId:'auditor'};
function setup(){
 const dir=mkdtempSync(join(tmpdir(),'agent-approval-metrics-')),path=join(dir,'runs.sqlite'),runs=new SqliteAgentRuns(path);
 const approvals=new SqliteAgentApprovals(path,{scope,runId:'run',authorize:()=>true});
 return {path,close:()=>{approvals.close?.();runs.close?.();}};
}
function insert(path,who,id,status,expiresAt){
 const db=new DatabaseSync(path);try{db.prepare('INSERT INTO agent_approvals VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)').run(who.tenantId,who.agentId,'run',id,'op','{}','h',1,status,expiresAt,'requester');}finally{db.close();}
}

test('approval metrics report every state, count lapsed pending approvals as expired and ignore other scopes',async()=>{
 const s=setup();let metrics;try{
  insert(s.path,scope,'a','pending',9000);insert(s.path,scope,'b','pending',9000);insert(s.path,scope,'c','pending',1000);insert(s.path,scope,'d','approved',9000);insert(s.path,scope,'e','approved',1000);insert(s.path,scope,'f','rejected',9000);insert(s.path,scope,'g','cancelled',9000);insert(s.path,other,'h','pending',9000);
  metrics=new SqliteAgentRunMetrics(s.path,{scope,authorize:()=>true,includeApprovals:true,clock:()=>5000});
  assert.deepEqual(await metrics.approvals(actor),[{status:'pending',count:2},{status:'approved',count:1},{status:'rejected',count:1},{status:'cancelled',count:1},{status:'expired',count:2}]);
  const text=await metrics.render(actor);assert.match(text,/^app_mixer_agent_approvals\{status="pending"\} 2$/m);assert.match(text,/^app_mixer_agent_approvals\{status="expired"\} 2$/m);assert.doesNotMatch(text,/approval_id|run_id|action/);
  insert(s.path,scope,'i','mystery',9000);await assert.rejects(metrics.approvals(actor),/Invalid agent metrics data/);
 }finally{metrics?.close();s.close();}
});

test('approval metrics are opt-in, authorized and need the approval table',async()=>{
 const s=setup();let metrics,denied;try{
  const plain=new SqliteAgentRunMetrics(s.path,{scope,authorize:()=>true});try{await assert.rejects(plain.approvals(actor),/not enabled/);assert.doesNotMatch(await plain.render(actor),/app_mixer_agent_approvals/);}finally{plain.close();}
  assert.throws(()=>new SqliteAgentRunMetrics(s.path,{scope,authorize:()=>true,includeApprovals:'yes'}),/Invalid agent metrics configuration/);
  denied=new SqliteAgentRunMetrics(s.path,{scope,authorize:()=>false,includeApprovals:true});await assert.rejects(denied.approvals(actor),/denied/);
  metrics=new SqliteAgentRunMetrics(s.path,{scope,authorize:()=>true,includeApprovals:true,clock:()=>-1});await assert.rejects(metrics.approvals(actor),/Invalid agent metrics clock/);
  await assert.rejects(new SqliteAgentRunMetrics(s.path,{scope,authorize:()=>true,includeApprovals:true}).approvals({tenantId:'other',principalId:'auditor'}),/Invalid agent metrics actor/);
 }finally{metrics?.close();denied?.close();s.close();}
 const dir=mkdtempSync(join(tmpdir(),'agent-approval-metrics-')),path=join(dir,'runs.sqlite'),runs=new SqliteAgentRuns(path);
 try{assert.throws(()=>new SqliteAgentRunMetrics(path,{scope,authorize:()=>true,includeApprovals:true}),/unavailable/);}finally{runs.close?.();}
});
