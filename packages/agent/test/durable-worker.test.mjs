import test from 'node:test';
import assert from 'node:assert/strict';
import {AIMessage} from '@langchain/core/messages';
import {CapabilityRegistry} from '../../core/dist/index.js';
import {SqliteAgentRuns,SqliteAgentDefinitions,DurableAgentWorker,PostgresAgentRunSlots,createConfiguredAgentRun} from '../dist/index.js';
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


test('worker detects cancellation while a definition renewal is blocked', {timeout:5000}, async()=>{
 for(const mode of ['signal-aware','fallback']){const s=setup();let release;try{let block=false,entered,seen;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r),source={get:async(...args)=>{if(block&&mode==='fallback'){entered();await gate;}return s.definitions.get(...args);}};if(mode==='signal-aware')source.getWithSignal=async(tenant,agent,signal)=>{seen=signal;if(block){entered();await gate;}return s.definitions.get(tenant,agent);};const worker=new DurableAgentWorker({...options(s),definitions:source,asyncDefinitions:true,execute:async(_run,{signal})=>{block=true;await new Promise(r=>signal.addEventListener('abort',r,{once:true}));return 'stopped';}}),pending=worker.runOnce(scope,'one');await ready;const current=s.runs.get(scope,'one');s.runs.request(scope,'one',current.revision,'cancel');const settled=await pending;assert.equal(settled.status,'cancelled');if(mode==='signal-aware')assert.equal(seen.aborted,true);release();await new Promise(r=>setImmediate(r));assert.equal(s.runs.get(scope,'one').status,'cancelled');}finally{release?.();s.runs.close();s.definitions.close();}}
});

test('worker finishes without waiting for an obsolete renewal lookup', {timeout:5000}, async()=>{
 const s=setup();let release,finish;try{let block=false,entered,seen;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r),done=new Promise(r=>finish=r),definitions={get:async(...args)=>s.definitions.get(...args),getWithSignal:async(tenant,agent,signal)=>{if(block){seen=signal;entered();await gate;}return s.definitions.get(tenant,agent);}},worker=new DurableAgentWorker({...options(s),definitions,asyncDefinitions:true,execute:async()=>{block=true;await done;block=false;return 'succeeded';}}),pending=worker.runOnce(scope,'one');await ready;finish();assert.equal((await pending).status,'succeeded');assert.equal(seen.aborted,true);release();await new Promise(r=>setImmediate(r));assert.equal(s.runs.get(scope,'one').status,'succeeded');}finally{finish?.();release?.();s.runs.close();s.definitions.close();}
});


test('worker aborts a blocked definition check when its lease expires', {timeout:5000}, async()=>{
 const s=setup();let release;try{let now=100,block=false,entered,seen;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r),definitions={get:async(...args)=>s.definitions.get(...args),getWithSignal:async(tenant,agent,signal)=>{seen=signal;if(block){entered();await gate;}return s.definitions.get(tenant,agent);}},worker=new DurableAgentWorker({...options(s),definitions,asyncDefinitions:true,leaseMs:300,pollMs:20,clock:()=>now,execute:async(_run,{signal})=>{block=true;await new Promise(r=>signal.addEventListener('abort',r,{once:true}));return 'uncertain';}}),pending=worker.runOnce(scope,'one');await ready;now=401;await assert.rejects(pending,/lease lost/);assert.equal(seen.aborted,true);const current=s.runs.get(scope,'one');assert.equal(s.runs.recoverExpired(scope,'one',current.revision,now).status,'uncertain');release();await new Promise(r=>setImmediate(r));assert.equal(s.runs.get(scope,'one').status,'uncertain');}finally{release?.();s.runs.close();s.definitions.close();}
});


test('a failed shared slot renewal remains a failure when execution finishes', {timeout:5000}, async()=>{
 for(const failure of ['lost','error']){const s=setup();let release,finish;try{let entered,released=0;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r),done=new Promise(r=>finish=r),shared=new PostgresAgentRunSlots({enabled:true,query:async()=>({rows:[],rowCount:0}),transaction:async fn=>fn(async()=>({rows:[],rowCount:0}))});shared.acquire=async()=> 'slot';shared.renew=async()=>{entered();await gate;if(failure==='error')throw Error('database unavailable');return false;};shared.release=async()=>{released++;};const definitions={get:async(...args)=>s.definitions.get(...args)},worker=new DurableAgentWorker({...options(s),definitions,asyncDefinitions:true,sharedSlots:shared,execute:async()=>{await done;return 'succeeded';}}),pending=worker.runOnce(scope,'one');await ready;finish();await new Promise(r=>setImmediate(r));release();assert.equal((await pending).status,'uncertain');assert.equal(released,1);}finally{finish?.();release?.();s.runs.close();s.definitions.close();}}
});


test('shared slot verification requires a slot store and a boolean option',()=>{
 const s=setup();try{for(const extra of [{verifySharedSlotAtUse:true},{verifySharedSlotAtUse:'yes'}])assert.throws(()=>new DurableAgentWorker({...options(s),execute:async()=> 'succeeded',...extra}),/Invalid agent worker/);}finally{s.runs.close();s.definitions.close();}
});


test('shared slot check failures abort and remain uncertain even if execution claims success',async()=>{
 const s=setup();try{let checks=0;const shared=new PostgresAgentRunSlots({enabled:true,query:async()=>({rows:[],rowCount:0}),transaction:async fn=>fn(async()=>({rows:[],rowCount:0}))});shared.acquire=async()=> 'slot';shared.release=async()=>{};shared.holds=async()=>{if(++checks>1)throw Error('database unavailable');return true;};const configured={...options(s),sharedSlots:shared,verifySharedSlotAtUse:true,execute:async(_run,{signal,assertLease,assertLeaseAsync})=>{assert.throws(assertLease,/unavailable/);await assert.rejects(assertLeaseAsync(),/unavailable/);assert.equal(signal.aborted,true);return 'succeeded';}},worker=new DurableAgentWorker(configured);configured.verifySharedSlotAtUse=false;assert.equal((await worker.runOnce(scope,'one')).status,'uncertain');assert.equal(checks,2);}finally{s.runs.close();s.definitions.close();}
});


test('cancellation fences a blocked shared slot check', {timeout:5000}, async()=>{
 const s=setup();let release;try{let checks=0,entered;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r),shared=new PostgresAgentRunSlots({enabled:true,query:async()=>({rows:[],rowCount:0}),transaction:async fn=>fn(async()=>({rows:[],rowCount:0}))});shared.acquire=async()=> 'slot';shared.release=async()=>{};shared.renew=async()=>true;shared.holds=async()=>{if(++checks>1){entered();await gate;}return true;};let effects=0;const worker=new DurableAgentWorker({...options(s),sharedSlots:shared,verifySharedSlotAtUse:true,execute:async(_run,{assertLeaseAsync})=>{await assert.rejects(async()=>{await assertLeaseAsync();effects++;},/unavailable/);return 'stopped';}}),pending=worker.runOnce(scope,'one');await ready;const current=s.runs.get(scope,'one');s.runs.request(scope,'one',current.revision,'cancel');assert.equal((await pending).status,'cancelled');release();await new Promise(r=>setImmediate(r));assert.equal(effects,0);assert.equal(s.runs.get(scope,'one').status,'cancelled');}finally{release?.();s.runs.close();s.definitions.close();}
});

test('an unresolved slot renewal cannot delay settlement or establish success', {timeout:5000}, async()=>{
 const s=setup();let release,finish;try{let entered,released=false;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r),done=new Promise(r=>finish=r),shared=new PostgresAgentRunSlots({enabled:true,query:async()=>({rows:[],rowCount:0}),transaction:async fn=>fn(async()=>({rows:[],rowCount:0}))});shared.acquire=async()=> 'slot';shared.release=async()=>{released=true;};shared.renew=async()=>{entered();await gate;return true;};const worker=new DurableAgentWorker({...options(s),sharedSlots:shared,execute:async()=>{await done;return 'succeeded';}}),pending=worker.runOnce(scope,'one');await ready;finish();assert.equal((await pending).status,'uncertain');assert.equal(released,true);release();await new Promise(r=>setImmediate(r));assert.equal(s.runs.get(scope,'one').status,'uncertain');}finally{finish?.();release?.();s.runs.close();s.definitions.close();}
});

test('worker snapshots validated options without replacing live definition policy',async()=>{
 const s=setup(),other=setup();try{
  let selectedCalls=0,replacementCalls=0,authorized=0;const settings={...options(s),authorizeStart:()=>{authorized++;return true;},execute:async()=>{selectedCalls++;return 'succeeded';}};const worker=new DurableAgentWorker(settings);
  settings.runs=other.runs;settings.definitions=other.definitions;settings.workerId='changed';settings.leaseMs=0;settings.pollMs=0;settings.authorizeStart=()=>false;settings.execute=async()=>{replacementCalls++;return 'failed';};
  assert.equal(worker.usesRegistry(s.runs),true);assert.equal(worker.usesRegistry(other.runs),false);assert.equal((await worker.runOnce(scope,'one')).status,'succeeded');assert.equal(selectedCalls,1);assert.equal(replacementCalls,0);assert.equal(authorized,2);assert.equal(other.runs.get(scope,'one').status,'queued');
 }finally{s.runs.close();s.definitions.close();other.runs.close();other.definitions.close();}
});

test('bounded startup policy fences late authorization and limits pending callbacks',async()=>{
 const s=setup();let release,entered,seenSignal,block=true,executed=0;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);
 try{
  const settings={...options(s),startupCallbackTimeoutMs:100,maxPendingStartupCallbacks:1,authorizeStartWithSignal:async(_run,_definition,signal)=>{if(block){seenSignal=signal;entered();await gate;}return true;},execute:async()=>{executed++;return 'succeeded';}},worker=new DurableAgentWorker(settings);const first=worker.runOnce(scope,'one');await ready;await assert.rejects(first,/startup callback unavailable/);assert.equal(seenSignal.aborted,true);assert.equal(s.runs.get(scope,'one').status,'queued');await assert.rejects(worker.runOnce(scope,'one'),/startup callback unavailable/);block=false;release();await new Promise(r=>setImmediate(r));assert.equal(s.runs.get(scope,'one').status,'queued');assert.equal(executed,0);assert.equal((await worker.runOnce(scope,'one')).status,'succeeded');assert.equal(executed,1);
 }finally{release();s.runs.close();s.definitions.close();}
});

test('bounded post-claim authorization does not execute a run after a late decision',async()=>{
 const s=setup();let release,signal,executed=false;const gate=new Promise(r=>release=r);try{
  const worker=new DurableAgentWorker({...options(s),startupCallbackTimeoutMs:100,maxPendingStartupCallbacks:1,authorizeStartWithSignal:async(run,_definition,provided)=>{if(run.status==='running'){signal=provided;await gate;}return true;},execute:async()=>{executed=true;return 'succeeded';}});const result=await worker.runOnce(scope,'one');assert.equal(result.status,'failed');assert.equal(signal.aborted,true);release();await new Promise(r=>setImmediate(r));assert.equal(executed,false);assert.equal(s.runs.get(scope,'one').status,'failed');
 }finally{release();s.runs.close();s.definitions.close();}
});

test('bounded async startup definition lookup uses cancellation and does not claim on timeout',async()=>{
 const s=setup();let release,signal;const gate=new Promise(r=>release=r);try{
  const definitions={get:async(...args)=>s.definitions.get(...args),getWithSignal:async(_tenant,_agent,provided)=>{signal=provided;await gate;return s.definitions.get('t','agent');}},worker=new DurableAgentWorker({...options(s),definitions,asyncDefinitions:true,startupCallbackTimeoutMs:100,maxPendingStartupCallbacks:1,execute:async()=> 'succeeded'});await assert.rejects(worker.runOnce(scope,'one'),/startup callback unavailable/);assert.equal(signal.aborted,true);assert.equal(s.runs.get(scope,'one').status,'queued');release();await new Promise(r=>setImmediate(r));assert.equal(s.runs.get(scope,'one').status,'queued');
 }finally{release();s.runs.close();s.definitions.close();}
});

test('startup callback bounds must be paired and valid',()=>{const s=setup();try{for(const limits of [{startupCallbackTimeoutMs:100},{maxPendingStartupCallbacks:1},{startupCallbackTimeoutMs:99,maxPendingStartupCallbacks:1},{startupCallbackTimeoutMs:100,maxPendingStartupCallbacks:101}])assert.throws(()=>new DurableAgentWorker({...options(s),...limits,execute:async()=> 'succeeded'}),/Invalid agent worker/);}finally{s.runs.close();s.definitions.close();}});
