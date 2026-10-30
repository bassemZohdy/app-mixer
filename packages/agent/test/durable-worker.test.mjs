import test from 'node:test';
import assert from 'node:assert/strict';
import {AIMessage} from '@langchain/core/messages';
import {CapabilityRegistry} from '../../core/dist/index.js';
import {SqliteAgentRuns,SqliteAgentDefinitions,DurableAgentWorker,createConfiguredAgentRun} from '../dist/index.js';
import {context,trace,ROOT_CONTEXT,SpanStatusCode} from '@opentelemetry/api';
import {AsyncLocalStorageContextManager} from '@opentelemetry/context-async-hooks';
import {TracerProvider,SimpleSpanProcessor,InMemorySpanExporter} from '@opentelemetry/sdk-trace';
const scope={tenantId:'t',agentId:'agent'};
const manifest={manifestVersion:1,tenantId:'t',agentId:'agent',name:'Operations',owner:{kind:'organization',id:'org'},administrators:['admin'],servicePrincipalId:'service',model:{provider:'local',model:'test'},allowedCapabilities:['lookup'],lifecycle:{enabled:true,maxAttempts:3,runTimeoutMs:10000},quotas:{maxConcurrentRuns:1,maxTokensPerRun:1000,maxRunsPerDay:10}};
const input={threadId:'thread',runId:'one',messages:[{role:'user',content:'Find it'}]};
function setup(){const runs=new SqliteAgentRuns(':memory:'),definitions=new SqliteAgentDefinitions(':memory:');definitions.save('t',manifest,0);runs.create(scope,'one',{definitionVersion:1,maxAttempts:3,deadline:Date.now()+10000});return {runs,definitions};}
const options=s=>({...s,workerId:'worker',leaseMs:600,pollMs:25,authorizeStart:()=>true});

test('worker checks asynchronous definitions at protected capability calls',async()=>{
 const s=setup();try{const definitions={get:async(...args)=>s.definitions.get(...args)},registry=new CapabilityRegistry(()=>{});let calls=0;registry.register({operationId:'lookup',method:'GET',path:'/lookup'},{authorize:()=>true,validate:()=>true,execute:()=>{calls++;return 'ok'}});
  const worker=new DurableAgentWorker({...options(s),definitions,asyncDefinitions:true,execute:async(run,{signal,assertLease,assertLeaseAsync})=>{assert.throws(assertLease,/unavailable/);const agent=await createConfiguredAgentRun({definitions,tenantId:'t',agentId:'agent',expectedVersion:run.definitionVersion,bindings:[{operationId:'lookup',toolName:'lookup',description:'Lookup'}],registry,authorizeRun:()=>true,authorizeCapability:async()=>{await assertLeaseAsync();return true},createModel:()=>{let turn=0;return {async invoke(){return ++turn===1?new AIMessage({content:'',tool_calls:[{id:'call',name:'lookup',args:{}}]}):new AIMessage('Done')}}}});let last;for await(const event of agent.run(input,{signal}))last=event;return last?.type==='RUN_FINISHED'?'succeeded':'uncertain'} });assert.equal((await worker.runOnce(scope,'one')).status,'succeeded');assert.equal(calls,1);
 }finally{s.runs.close();s.definitions.close();}
});

test('asynchronous definitions require explicit mode and recheck before claim',async()=>{
 const s=setup();try{const definitions={get:async(...args)=>s.definitions.get(...args)};await assert.rejects(new DurableAgentWorker({...options(s),definitions,execute:async()=> 'succeeded'}).runOnce(scope,'one'),/require asyncDefinitions/);let entered,release;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r),worker=new DurableAgentWorker({...options(s),definitions,asyncDefinitions:true,authorizeStart:async()=>{entered();await gate;return true},execute:async()=> 'succeeded'}),pending=worker.runOnce(scope,'one');await ready;s.definitions.save('t',{...manifest,lifecycle:{...manifest.lifecycle,enabled:false}},1);release();await assert.rejects(pending,/definition changed/);assert.equal(s.runs.get(scope,'one').status,'queued');
 }finally{s.runs.close();s.definitions.close();}
});

test('async lease validation fences a cancellation during a definition lookup',async()=>{
 const s=setup();try{let block=false,entered,release;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r),definitions={get:async(...args)=>{if(block){entered();await gate}return s.definitions.get(...args)}},worker=new DurableAgentWorker({...options(s),definitions,asyncDefinitions:true,execute:async(_run,{assertLeaseAsync})=>{block=true;const check=assertLeaseAsync();await ready;const current=s.runs.get(scope,'one');s.runs.request(scope,'one',current.revision,'cancel');release();await assert.rejects(check,/unavailable/);return 'stopped'}});assert.equal((await worker.runOnce(scope,'one')).status,'cancelled');
 }finally{s.runs.close();s.definitions.close();}
});

test('failed asynchronous definition refresh aborts and cannot settle a successful result',async()=>{
 const s=setup();try{let fail=false,started;const ready=new Promise(r=>started=r),definitions={get:async(...args)=>{if(fail)throw Error('storage unavailable');return s.definitions.get(...args)}},worker=new DurableAgentWorker({...options(s),definitions,asyncDefinitions:true,execute:async(_run,{signal})=>{started();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));return 'succeeded'}}),pending=worker.runOnce(scope,'one');await ready;fail=true;assert.equal((await pending).status,'uncertain');
 }finally{s.runs.close();s.definitions.close();}
});

test('async worker rechecks a changed definition before accepting completion',async()=>{
 const s=setup();try{const definitions={get:async(...args)=>s.definitions.get(...args)},worker=new DurableAgentWorker({...options(s),definitions,asyncDefinitions:true,execute:async()=>{s.definitions.save('t',{...manifest,lifecycle:{...manifest.lifecycle,enabled:false}},1);return 'succeeded'}});assert.equal((await worker.runOnce(scope,'one')).status,'uncertain');
 }finally{s.runs.close();s.definitions.close();}
});

test('durable worker creates an active, sanitized span and records the settled state',async()=>{
 const s=setup(),manager=new AsyncLocalStorageContextManager().enable();context.setGlobalContextManager(manager);const exporter=new InMemorySpanExporter(),provider=new TracerProvider({spanProcessors:[new SimpleSpanProcessor({exporter})]}),tracer=provider.getTracer('test'),parent=tracer.startSpan('parent');let nested;
 try{const worker=new DurableAgentWorker({...options(s),tracing:{tracer},execute:async()=>{await Promise.resolve();nested=tracer.startSpan('child',undefined,context.active());nested.end();return 'succeeded';}});const result=await context.with(trace.setSpan(ROOT_CONTEXT,parent),()=>worker.runOnce(scope,'one'));assert.equal(result.status,'succeeded');parent.end();const spans=exporter.getFinishedSpans(),run=spans.find(span=>span.name==='agent.run'),child=spans.find(span=>span.name==='child');assert.ok(run);assert.equal(run.parentSpanContext.spanId,parent.spanContext().spanId);assert.equal(child.parentSpanContext.spanId,run.spanContext().spanId);assert.equal(run.attributes['app_mixer.agent.run.status'],'succeeded');const data=JSON.stringify(spans.map(span=>({name:span.name,attributes:span.attributes})));for(const value of ['worker','one','service','Find it',result.leaseToken].filter(Boolean))assert.equal(data.includes(value),false);
 }finally{await provider.shutdown();context.disable();manager.disable();s.runs.close();s.definitions.close();}
});

test('durable worker traces uncertainty and denials without exception details',async()=>{
 const s=setup(),exporter=new InMemorySpanExporter(),provider=new TracerProvider({spanProcessors:[new SimpleSpanProcessor({exporter})]}),tracer=provider.getTracer('test');
 try{const denied=new DurableAgentWorker({...options(s),tracing:{tracer},authorizeStart:()=>false,execute:async()=> 'succeeded'});await assert.rejects(denied.runOnce(scope,'one'),/forbidden/);let span=exporter.getFinishedSpans().at(-1);assert.equal(span.status.code,SpanStatusCode.ERROR);assert.equal(span.attributes['error.type'],'agent_run_failed');assert.equal(span.events.length,0);const worker=new DurableAgentWorker({...options(s),tracing:{tracer},execute:async()=>{throw Error('private provider detail');}});assert.equal((await worker.runOnce(scope,'one')).status,'uncertain');span=exporter.getFinishedSpans().at(-1);assert.equal(span.status.code,SpanStatusCode.ERROR);assert.equal(span.attributes['app_mixer.agent.run.status'],'uncertain');assert.equal(JSON.stringify(span.attributes).includes('private'),false);
 }finally{await provider.shutdown();s.runs.close();s.definitions.close();}
});

test('tracer failures do not prevent durable agent execution',async()=>{
 const s=setup();try{const worker=new DurableAgentWorker({...options(s),tracing:{tracer:{startSpan(){throw Error('telemetry unavailable');}}},execute:async()=> 'succeeded'});assert.equal((await worker.runOnce(scope,'one')).status,'succeeded');}finally{s.runs.close();s.definitions.close();}
});

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
