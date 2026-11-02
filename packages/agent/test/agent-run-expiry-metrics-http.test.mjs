import test from 'node:test';
import assert from 'node:assert/strict';
import {SqliteAgentRuns,AgentRunExpiryWorker,AgentRunExpiryMetrics,AgentCombinedMetrics,createAgentMetricsServer} from '../dist/index.js';

test('expiry worker metrics are independently authorized through the protected scrape endpoint',async()=>{
 const scope={tenantId:'tenant',agentId:'agent'},actor={tenantId:'tenant',principalId:'operator'},runs=new SqliteAgentRuns(':memory:');let allowed=true;
 const metrics=new AgentRunExpiryMetrics({authorize:who=>allowed&&who.tenantId===actor.tenantId&&who.principalId===actor.principalId}),combined=new AgentCombinedMetrics({sources:[metrics],authorize:()=>true}),server=createAgentMetricsServer({metrics:combined,timeoutMs:1000,maxPending:2,authenticate:req=>req.headers.authorization==='Bearer valid'?actor:undefined});
 try{
  runs.create(scope,'private-run',{definitionVersion:1,maxAttempts:1,deadline:100},0);const worker=new AgentRunExpiryWorker({runs,scope,maxPerPass:2,pollMs:100,clock:()=>100,authorize:()=>true,onError:()=>{},observe:metrics.observe});assert.equal(await worker.runOnce(),1);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}/metrics`;assert.equal((await fetch(url)).status,401);const headers={authorization:'Bearer valid'},response=await fetch(url,{headers});assert.equal(response.status,200);const body=await response.text();assert.match(body,/app_mixer_agent_run_expiry_passes_total\{outcome="completed"\} 1/);assert.match(body,/app_mixer_agent_run_expiry_results_total\{result="expired"\} 1/);for(const secret of ['private-run','tenant','operator'])assert.equal(body.includes(secret),false);allowed=false;assert.equal((await fetch(url,{headers})).status,403);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));runs.close();}
});

test('scrape timeout cancels expiry metrics authorization and rejects late results',async()=>{
 const actor={tenantId:'tenant',principalId:'operator'};let release,entered,seen,blocked=true;const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>entered=resolve),metrics=new AgentRunExpiryMetrics({authorize:async(_actor,signal)=>{if(blocked){seen=signal;entered();await gate;}return true;}}),combined=new AgentCombinedMetrics({sources:[metrics],authorize:()=>true,callbackTimeoutMs:1000,maxPendingCallbacks:1}),server=createAgentMetricsServer({metrics:combined,timeoutMs:100,maxPending:1,authenticate:()=>actor});
 try{await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}/metrics`,pending=fetch(url);await ready;assert.equal((await pending).status,503);assert.equal(seen.aborted,true);assert.equal((await fetch(url)).status,503);blocked=false;release();await new Promise(resolve=>setImmediate(resolve));assert.equal((await fetch(url)).status,200);}finally{release();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
