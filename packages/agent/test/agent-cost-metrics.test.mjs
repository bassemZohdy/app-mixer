import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {SqliteAgentTokenBudget,SqliteAgentRuns,SqliteAgentRunMetrics} from '../dist/index.js';

const scope={tenantId:'tenant',agentId:'agent'},other={tenantId:'other',agentId:'agent'},actor={tenantId:'tenant',principalId:'auditor'};
function setup(){
 const dir=mkdtempSync(join(tmpdir(),'agent-cost-metrics-')),path=join(dir,'runs.sqlite'),runs=new SqliteAgentRuns(path),budget=new SqliteAgentTokenBudget(path,{scope,runId:'run',leaseToken:'lease',maxTokens:1000,cost:{currency:'USD',maxMicros:1000000}});
 return {path,close:()=>{budget.close?.();runs.close?.();}};
}
function budget(path,who,run,currency){const db=new DatabaseSync(path);try{db.prepare('INSERT OR REPLACE INTO agent_cost_budgets VALUES (?,?,?,?,?)').run(who.tenantId,who.agentId,run,currency,1000000);}finally{db.close();}}
function call(path,who,run,id,reserved,used,status){const db=new DatabaseSync(path);try{db.prepare('INSERT INTO agent_cost_calls VALUES (?,?,?,?,?,?,?)').run(who.tenantId,who.agentId,run,id,reserved,used,status);}finally{db.close();}}

test('cost metrics sum reservations and commitments per currency across runs and ignore other scopes',async()=>{
 const s=setup();let metrics;try{
  budget(s.path,scope,'run','USD');budget(s.path,scope,'run2','USD');budget(s.path,scope,'run3','EUR');budget(s.path,other,'run','USD');
  call(s.path,scope,'run','a',500,null,'reserved');call(s.path,scope,'run','b',300,250,'settled');call(s.path,scope,'run2','c',200,null,'reserved');call(s.path,scope,'run2','d',100,90,'settled');call(s.path,scope,'run3','e',40,35,'settled');call(s.path,other,'run','f',999,null,'reserved');
  metrics=new SqliteAgentRunMetrics(s.path,{scope,authorize:()=>true,includeCosts:true});
  assert.deepEqual(await metrics.costs(actor),[{currency:'EUR',reservedMicros:0,committedMicros:35},{currency:'USD',reservedMicros:700,committedMicros:340}]);
  const text=await metrics.render(actor);assert.match(text,/^app_mixer_agent_cost_micros\{currency="USD",state="reserved"\} 700$/m);assert.match(text,/^app_mixer_agent_cost_micros\{currency="EUR",state="committed"\} 35$/m);assert.doesNotMatch(text,/run2|call_id|run_id/);
  call(s.path,scope,'run','g',1,null,'mystery');await assert.rejects(metrics.costs(actor),/Invalid agent metrics data/);
 }finally{metrics?.close();s.close();}
});

test('cost metrics are empty without calls, bounded to eight currencies, opt-in and authorized',async()=>{
 const s=setup();let metrics,denied;try{
  metrics=new SqliteAgentRunMetrics(s.path,{scope,authorize:()=>true,includeCosts:true});assert.deepEqual(await metrics.costs(actor),[]);
  for(const [i,currency] of ['AAA','BBB','CCC','DDD','EEE','FFF','GGG','HHH','III'].entries()){budget(s.path,scope,'r'+i,currency);call(s.path,scope,'r'+i,'x',1,null,'reserved');}
  await assert.rejects(metrics.costs(actor),/Invalid agent metrics data/,'a ninth currency would add an unbounded label');
  const plain=new SqliteAgentRunMetrics(s.path,{scope,authorize:()=>true});try{await assert.rejects(plain.costs(actor),/not enabled/);assert.doesNotMatch(await plain.render(actor),/cost_micros/);}finally{plain.close();}
  assert.throws(()=>new SqliteAgentRunMetrics(s.path,{scope,authorize:()=>true,includeCosts:1}),/Invalid agent metrics configuration/);
  denied=new SqliteAgentRunMetrics(s.path,{scope,authorize:()=>false,includeCosts:true});await assert.rejects(denied.costs(actor),/denied/);
 }finally{metrics?.close();denied?.close();s.close();}
 const dir=mkdtempSync(join(tmpdir(),'agent-cost-metrics-')),path=join(dir,'runs.sqlite'),runs=new SqliteAgentRuns(path);
 try{assert.throws(()=>new SqliteAgentRunMetrics(path,{scope,authorize:()=>true,includeCosts:true}),/unavailable/);}finally{runs.close?.();}
});
