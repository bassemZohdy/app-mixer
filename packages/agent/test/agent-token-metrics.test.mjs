import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {SqliteAgentTokenBudget,SqliteAgentRuns,SqliteAgentRunMetrics} from '../dist/index.js';

const scope={tenantId:'tenant',agentId:'agent'},other={tenantId:'other',agentId:'agent'},actor={tenantId:'tenant',principalId:'auditor'};
function setup(){
 const dir=mkdtempSync(join(tmpdir(),'agent-token-metrics-')),path=join(dir,'runs.sqlite'),runs=new SqliteAgentRuns(path),budget=new SqliteAgentTokenBudget(path,{scope,runId:'run',leaseToken:'lease',maxTokens:1000});
 return {path,close:()=>{budget.close?.();runs.close?.();}};
}
function insert(path,who,run,call,reserved,used,status){
 const db=new DatabaseSync(path);try{db.prepare('INSERT INTO agent_token_calls VALUES (?,?,?,?,?,?,?)').run(who.tenantId,who.agentId,run,call,reserved,used,status);}finally{db.close();}
}

test('token metrics sum reservations across the agent\'s runs and ignore other scopes',async()=>{
 const s=setup();let metrics;try{
  insert(s.path,scope,'run','a',100,null,'reserved');insert(s.path,scope,'run2','b',50,null,'reserved');insert(s.path,scope,'run','c',200,180,'settled');insert(s.path,scope,'run2','d',300,10,'settled');insert(s.path,other,'run','e',999,null,'reserved');
  metrics=new SqliteAgentRunMetrics(s.path,{scope,authorize:()=>true,includeTokens:true});
  assert.deepEqual(await metrics.tokens(actor),{reservedCalls:2,settledCalls:2,reservedTokens:150,committedTokens:190});
  const text=await metrics.render(actor);assert.match(text,/^app_mixer_agent_token_calls\{state="reserved"\} 2$/m);assert.match(text,/^app_mixer_agent_tokens\{state="committed"\} 190$/m);assert.doesNotMatch(text,/run2|call_id/);
  insert(s.path,scope,'run','f',1,null,'mystery');await assert.rejects(metrics.tokens(actor),/Invalid agent metrics data/);
 }finally{metrics?.close();s.close();}
});

test('token metrics are empty without calls, opt-in, authorized and need the token table',async()=>{
 const s=setup();let metrics,denied;try{
  metrics=new SqliteAgentRunMetrics(s.path,{scope,authorize:()=>true,includeTokens:true});assert.deepEqual(await metrics.tokens(actor),{reservedCalls:0,settledCalls:0,reservedTokens:0,committedTokens:0});
  const plain=new SqliteAgentRunMetrics(s.path,{scope,authorize:()=>true});try{await assert.rejects(plain.tokens(actor),/not enabled/);assert.doesNotMatch(await plain.render(actor),/app_mixer_agent_tokens/);}finally{plain.close();}
  assert.throws(()=>new SqliteAgentRunMetrics(s.path,{scope,authorize:()=>true,includeTokens:'yes'}),/Invalid agent metrics configuration/);
  denied=new SqliteAgentRunMetrics(s.path,{scope,authorize:()=>false,includeTokens:true});await assert.rejects(denied.tokens(actor),/denied/);
 }finally{metrics?.close();denied?.close();s.close();}
 const dir=mkdtempSync(join(tmpdir(),'agent-token-metrics-')),path=join(dir,'runs.sqlite'),runs=new SqliteAgentRuns(path);
 try{assert.throws(()=>new SqliteAgentRunMetrics(path,{scope,authorize:()=>true,includeTokens:true}),/unavailable/);}finally{runs.close?.();}
});
