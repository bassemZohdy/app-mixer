import test from 'node:test';
import assert from 'node:assert/strict';
import {AIMessage} from '@langchain/core/messages';
import {CapabilityRegistry} from '../../core/dist/index.js';
import {SqliteAgentRuns,SqliteAgentDefinitions,DurableAgentWorker,createConfiguredAgentRun} from '../dist/index.js';
const scope={tenantId:'t',agentId:'agent'};
const manifest={manifestVersion:1,tenantId:'t',agentId:'agent',name:'Operations',owner:{kind:'organization',id:'org'},administrators:['admin'],servicePrincipalId:'service',model:{provider:'local',model:'test'},allowedCapabilities:['lookup'],lifecycle:{enabled:true,maxAttempts:3,runTimeoutMs:10000},quotas:{maxConcurrentRuns:1,maxTokensPerRun:1000,maxRunsPerDay:10}};
const input={threadId:'thread',runId:'one',messages:[{role:'user',content:'Find it'}]};
function setup(){const runs=new SqliteAgentRuns(':memory:'),definitions=new SqliteAgentDefinitions(':memory:');definitions.save('t',manifest,0);runs.create(scope,'one',{definitionVersion:1,maxAttempts:3,deadline:Date.now()+10000});return {runs,definitions};}
const options=s=>({...s,workerId:'worker',leaseMs:600,pollMs:25,authorizeStart:()=>true});

test('worker executes a configured agent under the service principal and records completion',async()=>{
 const s=setup();try{const audit=[],registry=new CapabilityRegistry(e=>audit.push(e));let calls=0;
  registry.register({operationId:'lookup',method:'GET',path:'/lookup'},{authorize:c=>c.tenantId==='t'&&c.principalId==='service',validate:()=>true,execute:()=>{calls++;return 'ok';}});
  const worker=new DurableAgentWorker({...options(s),execute:async(run,{signal,assertLease})=>{
   const agent=await createConfiguredAgentRun({definitions:s.definitions,tenantId:'t',agentId:'agent',expectedVersion:run.definitionVersion,bindings:[{operationId:'lookup',toolName:'lookup',description:'Lookup'}],registry,authorizeRun:()=>true,authorizeCapability:()=>{assertLease();return true;},createModel:()=>{let turn=0;return {async invoke(){return ++turn===1?new AIMessage({content:'',tool_calls:[{id:'call',name:'lookup',args:{}}]}):new AIMessage('Done');}};}});
   let final;for await(const event of agent.run(input,{signal}))final=event;return final?.type==='RUN_FINISHED'?'succeeded':'uncertain';
  }});
  assert.equal((await worker.runOnce(scope,'one')).status,'succeeded');assert.equal(calls,1);assert.equal(audit[0].principalId,'service');
 }finally{s.runs.close();s.definitions.close();}
});

test('worker observes cancellation and records a cooperative stop',async()=>{
 const s=setup();try{let started;const ready=new Promise(r=>started=r);const worker=new DurableAgentWorker({...options(s),execute:async(_run,{signal})=>{started();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));return 'stopped';}});
  const pending=worker.runOnce(scope,'one');await ready;const active=s.runs.get(scope,'one');s.runs.request(scope,'one',active.revision,'cancel');assert.equal((await pending).status,'cancelled');
 }finally{s.runs.close();s.definitions.close();}
});

test('unclassified errors and changed definitions do not automatically replay',async()=>{
 for(const mode of ['error','changed']){const s=setup();try{let started,resume;const ready=new Promise(r=>started=r),gate=new Promise(r=>resume=r);
  const worker=new DurableAgentWorker({...options(s),execute:async(_run,{signal,assertLease})=>{started();if(mode==='error')throw Error('ambiguous');await gate;assert.equal(signal.aborted,true);assert.throws(assertLease,/unavailable/);return 'uncertain';}});
  const pending=worker.runOnce(scope,'one');await ready;if(mode==='changed'){s.definitions.save('t',{...manifest,lifecycle:{...manifest.lifecycle,enabled:false}},1);await new Promise(resolve=>setTimeout(resolve,80));resume();}const result=await pending;assert.equal(result.status,'uncertain');assert.equal(result.attempts,1);
 }finally{s.runs.close();s.definitions.close();}}
});

test('worker refuses invalid policy, stale definitions and competing claims',async()=>{
 const s=setup();try{
  await assert.rejects(new DurableAgentWorker({...options(s),authorizeStart:()=>false,execute:async()=> 'succeeded'}).runOnce(scope,'one'),/forbidden/);assert.equal(s.runs.get(scope,'one').status,'queued');
  let started,resume;const ready=new Promise(r=>started=r),gate=new Promise(r=>resume=r);const worker=new DurableAgentWorker({...options(s),execute:async()=>{started();await gate;return 'succeeded';}});const pending=worker.runOnce(scope,'one');await ready;await assert.rejects(worker.runOnce(scope,'one'),/unavailable/);resume();assert.equal((await pending).status,'succeeded');
 }finally{s.runs.close();s.definitions.close();}
});


test('expired worker cannot settle after its lease is recovered',async()=>{
 const s=setup();try{let now=100,started,resume;const ready=new Promise(r=>started=r),gate=new Promise(r=>resume=r);
  const worker=new DurableAgentWorker({...options(s),leaseMs:300,pollMs:20,clock:()=>now,execute:async()=>{started();await gate;return 'succeeded';}});
  const pending=worker.runOnce(scope,'one');await ready;now=401;const current=s.runs.get(scope,'one');const recovered=s.runs.recoverExpired(scope,'one',current.revision,now);assert.equal(recovered.status,'uncertain');resume();await assert.rejects(pending,/lease lost/);assert.equal(s.runs.get(scope,'one').status,'uncertain');
 }finally{s.runs.close();s.definitions.close();}
});
