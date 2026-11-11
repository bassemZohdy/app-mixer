import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {SqliteAgentNoticeDelivery,SqliteAgentRuns,SqliteAgentRunMetrics} from '../dist/index.js';

const scope={tenantId:'tenant',agentId:'agent'},other={tenantId:'other',agentId:'agent'},actor={tenantId:'tenant',principalId:'auditor'};
function setup(){
 const dir=mkdtempSync(join(tmpdir(),'agent-delivery-metrics-')),path=join(dir,'runs.sqlite'),runs=new SqliteAgentRuns(path),deliveries=new SqliteAgentNoticeDelivery(path,{scope,authorize:()=>true});
 return {path,close:()=>{deliveries.close?.();runs.close?.();}};
}
let next=1;
function insert(path,who,status){
 const db=new DatabaseSync(path);try{const n=next++;db.prepare('INSERT INTO agent_notice_deliveries (tenant_id,agent_id,notice_id,destination_id,idempotency_key,status,attempts,revision) VALUES (?,?,?,?,?,?,0,0)').run(who.tenantId,who.agentId,n,'destination','key-'+n,status);}finally{db.close();}
}

test('notice delivery metrics report every state with fixed labels and ignore other scopes',async()=>{
 const s=setup();let metrics;try{
  for(const status of ['pending','pending','pending','sending','uncertain','uncertain','delivered'])insert(s.path,scope,status);insert(s.path,other,'uncertain');
  metrics=new SqliteAgentRunMetrics(s.path,{scope,authorize:()=>true,includeNoticeDeliveries:true});
  assert.deepEqual(await metrics.noticeDeliveries(actor),[{status:'pending',count:3},{status:'sending',count:1},{status:'uncertain',count:2},{status:'delivered',count:1}]);
  const text=await metrics.render(actor);assert.match(text,/^app_mixer_agent_notice_deliveries\{status="pending"\} 3$/m);assert.match(text,/^app_mixer_agent_notice_deliveries\{status="uncertain"\} 2$/m);assert.doesNotMatch(text,/destination|key-|notice_id/);
 }finally{metrics?.close();s.close();}
});

test('notice delivery metrics are opt-in, authorized and need the delivery table',async()=>{
 const s=setup();let denied;try{
  const plain=new SqliteAgentRunMetrics(s.path,{scope,authorize:()=>true});try{await assert.rejects(plain.noticeDeliveries(actor),/not enabled/);assert.doesNotMatch(await plain.render(actor),/notice_deliveries/);}finally{plain.close();}
  assert.throws(()=>new SqliteAgentRunMetrics(s.path,{scope,authorize:()=>true,includeNoticeDeliveries:1}),/Invalid agent metrics configuration/);
  denied=new SqliteAgentRunMetrics(s.path,{scope,authorize:()=>false,includeNoticeDeliveries:true});await assert.rejects(denied.noticeDeliveries(actor),/denied/);
 }finally{denied?.close();s.close();}
 const dir=mkdtempSync(join(tmpdir(),'agent-delivery-metrics-')),path=join(dir,'runs.sqlite'),runs=new SqliteAgentRuns(path);
 try{assert.throws(()=>new SqliteAgentRunMetrics(path,{scope,authorize:()=>true,includeNoticeDeliveries:true}),/unavailable/);}finally{runs.close?.();}
});
