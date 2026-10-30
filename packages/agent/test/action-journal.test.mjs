import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AIMessage} from '@langchain/core/messages';
import {CapabilityRegistry} from '../../core/dist/index.js';
import {SqliteAgentRuns,SqliteAgentActionJournal,SqliteAgentDefinitions,createConfiguredAgentRun} from '../dist/index.js';
const scope={tenantId:'tenant',agentId:'agent'};
function setup(){const dir=mkdtempSync(join(tmpdir(),'app-mixer-actions-')),path=join(dir,'runs.sqlite'),runs=new SqliteAgentRuns(path);let now=10,run=runs.create(scope,'run',{definitionVersion:1,maxAttempts:3,deadline:10000},0);run=runs.claim(scope,'run',run.revision,'worker',100,now);const journal=new SqliteAgentActionJournal(path,{scope,runId:'run',leaseToken:run.leaseToken,clock:()=>now});return {dir,path,runs,journal,get run(){return run;},set run(value){run=value;},get now(){return now;},set now(value){now=value;}};}
function close(s){s.journal.close();s.runs.close();rmSync(s.dir,{recursive:true,force:true});}

test('successful actions are durable, deduplicated and bound to their canonical input',async()=>{
 const s=setup();try{let calls=0,key;const dispatch=async(_input,k)=>{calls++;key=k;return {ok:true};};assert.deepEqual(await s.journal.invoke('call','op',{b:2,a:1},3,dispatch),{ok:true});assert.deepEqual(await s.journal.invoke('call','op',{a:1,b:2},3,dispatch),{ok:true});assert.equal(calls,1);assert.equal(s.journal.get('call').idempotencyKey,key);assert.equal(s.journal.get('call').status,'succeeded');
  await assert.rejects(s.journal.invoke('call','op',{a:2,b:2},3,dispatch),/identity conflict/);await assert.rejects(s.journal.invoke('call','other',{a:1,b:2},3,dispatch),/identity conflict/);await assert.rejects(s.journal.invoke('bad','op',{value:undefined},3,dispatch),/Invalid action data/);
 }finally{close(s);}
});

test('ambiguous effect must be reconciled before a later run can reuse its result',async()=>{
 const s=setup();let next;try{let effects=0;await assert.rejects(s.journal.invoke('call','op',{x:1},2,async()=>{effects++;throw Error('response lost');}),/outcome uncertain/);assert.equal(s.journal.get('call').status,'uncertain');await assert.rejects(s.journal.invoke('call','op',{x:1},2,async()=>{}),/reconciliation/);
  s.run=s.runs.settle(scope,'run',s.run.revision,s.run.leaseToken,'uncertain',20);s.journal.reconcile('call','applied',{receipt:'ok'});s.run=s.runs.reconcile(scope,'run',s.run.revision,'retry',21);s.run=s.runs.claim(scope,'run',s.run.revision,'worker2',100,22);
  next=new SqliteAgentActionJournal(s.path,{scope,runId:'run',leaseToken:s.run.leaseToken,clock:()=>23});assert.deepEqual(await next.invoke('call','op',{x:1},2,async()=>{effects++;return null;}),{receipt:'ok'});assert.equal(effects,1);
 }finally{next?.close();close(s);}
});

test('unresolved actions force uncertainty and block every run reconciliation outcome',async()=>{
 for(const outcome of ['succeeded','failed','stopped','uncertain']){const s=setup();let reopened;try{await assert.rejects(s.journal.invoke('first','op',{},2,async()=>{throw Error('unknown')}),/uncertain/);await assert.rejects(s.journal.invoke('second','op',{},2,async()=>{throw Error('unknown')}),/uncertain/);if(outcome==='stopped')s.run=s.runs.request(scope,'run',s.run.revision,'pause',11);s.run=s.runs.settle(scope,'run',s.run.revision,s.run.leaseToken,outcome,12);assert.equal(s.run.status,'uncertain');reopened=new SqliteAgentRuns(s.path);for(const decision of ['retry','succeeded','failed','cancelled','paused'])assert.throws(()=>reopened.reconcile(scope,'run',s.run.revision,decision,13),/Action requires reconciliation/);assert.equal(reopened.get(scope,'run').revision,s.run.revision);s.journal.reconcile('first','not_applied');assert.throws(()=>reopened.reconcile(scope,'run',s.run.revision,'retry',13),/Action requires reconciliation/);s.journal.reconcile('second','applied',{receipt:'ok'});assert.equal(reopened.reconcile(scope,'run',s.run.revision,'retry',13).status,'queued');}finally{reopened?.close();close(s);}}
});

test('an in-flight action keeps the run uncertain and cannot settle after the lease ends',async()=>{
 const s=setup();try{let started,release;const ready=new Promise(resolve=>started=resolve),pending=s.journal.invoke('call','op',{},2,()=>{started();return new Promise(resolve=>release=resolve);});const observed=assert.rejects(pending,/uncertain/);await ready;s.run=s.runs.settle(scope,'run',s.run.revision,s.run.leaseToken,'succeeded',12);assert.equal(s.run.status,'uncertain');assert.throws(()=>s.runs.reconcile(scope,'run',s.run.revision,'failed',13),/Action requires reconciliation/);release({ok:true});await observed;assert.equal(s.journal.get('call').status,'dispatching');s.journal.markUncertain('call');s.journal.reconcile('call','applied',{ok:true});assert.equal(s.runs.reconcile(scope,'run',s.run.revision,'succeeded',13).status,'succeeded');}finally{close(s);}
});

test('unresolved actions are scoped to their tenant and run',async()=>{const s=setup();try{await assert.rejects(s.journal.invoke('call','op',{},2,async()=>{throw Error('unknown')}),/uncertain/);const otherScope={...scope,tenantId:'other'};let other=s.runs.create(otherScope,'run',{definitionVersion:1,maxAttempts:2,deadline:1000},0);other=s.runs.claim(otherScope,'run',other.revision,'worker',100,10);other=s.runs.settle(otherScope,'run',other.revision,other.leaseToken,'succeeded',11);assert.equal(other.status,'succeeded');}finally{close(s);}});

test('a crashed dispatch requires explicit recovery and keeps its idempotency key',async()=>{
 const s=setup();let next;try{let started,rejectDispatch,key;const ready=new Promise(r=>started=r);const pending=s.journal.invoke('call','op',{x:1},2,(_input,k)=>{key=k;started();return new Promise((_resolve,reject)=>rejectDispatch=reject);});await ready;assert.equal(s.journal.get('call').status,'dispatching');s.now=110;s.run=s.runs.recoverExpired(scope,'run',s.run.revision,s.now);rejectDispatch(Error('worker stopped'));await assert.rejects(pending,/outcome uncertain/);s.journal.markUncertain('call');s.journal.reconcile('call','not_applied');s.run=s.runs.reconcile(scope,'run',s.run.revision,'retry',111);s.run=s.runs.claim(scope,'run',s.run.revision,'worker2',100,112);
  next=new SqliteAgentActionJournal(s.path,{scope,runId:'run',leaseToken:s.run.leaseToken,clock:()=>113});assert.deepEqual(await next.invoke('call','op',{x:1},2,async(_input,k)=>{assert.equal(k,key);return {ok:true};}),{ok:true});assert.equal(next.get('call').attempts,2);
 }finally{next?.close();close(s);}
});

test('lease and tenant isolation block stale workers and invalid reconciliation',async()=>{
 const s=setup();let other;try{other=new SqliteAgentActionJournal(s.path,{scope:{...scope,tenantId:'other'},runId:'run',leaseToken:s.run.leaseToken,clock:()=>10});assert.equal(other.get('call'),undefined);await assert.rejects(other.invoke('call','op',{},1,async()=>null),/lease/);assert.throws(()=>s.journal.reconcile('call','not_applied'),/Run is not uncertain/);s.now=110;await assert.rejects(s.journal.invoke('call','op',{},1,async()=>null),/lease/);
 }finally{other?.close();close(s);}
});


test('configured agent journals a tool call and reuses its result after recovery',async()=>{
 const s=setup();let next,definitions;try{
  definitions=new SqliteAgentDefinitions(':memory:');definitions.save('tenant',{manifestVersion:1,tenantId:'tenant',agentId:'agent',name:'Agent',owner:{kind:'organization',id:'org'},administrators:['admin'],servicePrincipalId:'service',model:{provider:'local',model:'model'},allowedCapabilities:['lookup'],lifecycle:{enabled:true,maxAttempts:3,runTimeoutMs:1000},quotas:{maxConcurrentRuns:1,maxTokensPerRun:100,maxRunsPerDay:10}},0);
  let calls=0,seenKey,checks=0;const registry=new CapabilityRegistry(()=>{});registry.register({operationId:'lookup',method:'POST',path:'/lookup'},{authorize:c=>c.tenantId==='tenant'&&c.principalId==='service',validate:value=>typeof value.idempotencyKey==='string',execute:value=>{calls++;seenKey=value.idempotencyKey;return {ok:true};}});
  const input={threadId:'thread',runId:'run',messages:[{role:'user',content:'Do it'}]},collect=async stream=>{const events=[];for await(const event of stream)events.push(event);return events;};
  const configured=async(journal,fail)=>createConfiguredAgentRun({definitions,tenantId:'tenant',agentId:'agent',expectedVersion:1,bindings:[{operationId:'lookup',toolName:'lookup',description:'Lookup'}],registry,authorizeRun:()=>true,authorizeCapability:()=>{checks++;return true;},actionJournal:{journal,maxAttempts:2,prepareInput:(_operation,value,key)=>({...value,idempotencyKey:key})},createModel:()=>{let turn=0;return {async invoke(){if(++turn===1)return new AIMessage({content:'',tool_calls:[{id:'call-1',name:'lookup',args:{}}]});if(fail)throw Error('model failed');return new AIMessage('Done');}};}});
  const first=await configured(s.journal,true);assert.equal((await collect(first.run(input))).at(-1).type,'RUN_ERROR');assert.equal(calls,1);assert.equal(s.journal.get('call-1').idempotencyKey,seenKey);
  s.run=s.runs.settle(scope,'run',s.run.revision,s.run.leaseToken,'uncertain',20);s.run=s.runs.reconcile(scope,'run',s.run.revision,'retry',21);s.run=s.runs.claim(scope,'run',s.run.revision,'second',100,22);next=new SqliteAgentActionJournal(s.path,{scope,runId:'run',leaseToken:s.run.leaseToken,clock:()=>23});
  const second=await configured(next,false);assert.equal((await collect(second.run(input))).at(-1).type,'RUN_FINISHED');assert.equal(calls,1);assert.equal(checks,2);
 }finally{definitions?.close();next?.close();close(s);}
});


test('retry limit prevents another dispatch after repeated uncertain outcomes',async()=>{
 const s=setup();let next;try{
  await assert.rejects(s.journal.invoke('call','op',{},1,async()=>{throw Error('unknown');}),/uncertain/);s.run=s.runs.settle(scope,'run',s.run.revision,s.run.leaseToken,'uncertain',20);
  assert.throws(()=>s.journal.reconcile('call','not_applied'),/attempts exhausted/);s.journal.reconcile('call','failed');assert.equal(s.journal.get('call').status,'failed');
  s.run=s.runs.reconcile(scope,'run',s.run.revision,'retry',21);s.run=s.runs.claim(scope,'run',s.run.revision,'second',100,22);next=new SqliteAgentActionJournal(s.path,{scope,runId:'run',leaseToken:s.run.leaseToken,clock:()=>23});let calls=0;await assert.rejects(next.invoke('call','op',{},1,async()=>{calls++;return null;}),/reconciliation/);assert.equal(calls,0);
 }finally{next?.close();close(s);}
});


test('a trusted verifier reconciles an applied effect without dispatching it again',async()=>{
 const s=setup();let next;try{let dispatches=0;await assert.rejects(s.journal.invoke('call','op',{x:1},2,async()=>{dispatches++;throw Error('response lost');},false,'delegated-authority'),/uncertain/);s.run=s.runs.settle(scope,'run',s.run.revision,s.run.leaseToken,'uncertain',20);const outcome=await s.journal.reconcileWith('call',async request=>{assert.deepEqual(request.scope,scope);assert.equal(request.runId,'run');assert.equal(request.action.operationId,'op');assert.equal(request.action.idempotencyKey,s.journal.get('call').idempotencyKey);assert.deepEqual(request.input,{x:1});assert.equal(request.authority,'delegated-authority');request.input.x=9;return {outcome:'applied',result:{receipt:'verified'}};});assert.equal(outcome,'applied');s.run=s.runs.reconcile(scope,'run',s.run.revision,'retry',21);s.run=s.runs.claim(scope,'run',s.run.revision,'next',100,22);next=new SqliteAgentActionJournal(s.path,{scope,runId:'run',leaseToken:s.run.leaseToken,clock:()=>23});assert.deepEqual(await next.invoke('call','op',{x:1},2,async()=>{dispatches++;},false,'delegated-authority'),{receipt:'verified'});assert.equal(dispatches,1);}finally{next?.close();close(s);}
});

test('unknown, failed and malformed verifier outcomes leave safe journal states',async()=>{
 for(const decision of [{outcome:'unknown'},{outcome:'failed'},{outcome:'not_applied'},null,{outcome:'applied'},{outcome:'not_applied',result:null}]){const s=setup();try{await assert.rejects(s.journal.invoke('call','op',{},2,async()=>{throw Error('lost');}),/uncertain/);s.run=s.runs.settle(scope,'run',s.run.revision,s.run.leaseToken,'uncertain',20);if(decision&&['unknown','failed','not_applied'].includes(decision.outcome)&&!Object.hasOwn(decision,'result')){assert.equal(await s.journal.reconcileWith('call',async()=>decision),decision.outcome);assert.equal(s.journal.get('call').status,decision.outcome==='unknown'?'uncertain':decision.outcome==='failed'?'failed':'ready');}else{await assert.rejects(s.journal.reconcileWith('call',async()=>decision),/Invalid action verification/);assert.equal(s.journal.get('call').status,'uncertain');}}finally{close(s);}}
});

test('verification failure and competing reconciliation cannot commit stale evidence',async()=>{
 const s=setup();try{await assert.rejects(s.journal.invoke('call','op',{},2,async()=>{throw Error('lost');}),/uncertain/);s.run=s.runs.settle(scope,'run',s.run.revision,s.run.leaseToken,'uncertain',20);await assert.rejects(s.journal.reconcileWith('call',async()=>{throw Error('lookup failed');}),/lookup failed/);assert.equal(s.journal.get('call').status,'uncertain');let started,resume;const ready=new Promise(r=>started=r),gate=new Promise(r=>resume=r),pending=s.journal.reconcileWith('call',async()=>{started();await gate;return {outcome:'applied',result:{receipt:'stale'}};});await ready;s.journal.reconcile('call','not_applied');resume();await assert.rejects(pending,/stale/);assert.equal(s.journal.get('call').status,'ready');}finally{close(s);}
});

test('verifier results cannot settle after the run changes or attempts are exhausted',async()=>{
 const s=setup();try{await assert.rejects(s.journal.invoke('call','op',{},1,async()=>{throw Error('lost');}),/uncertain/);s.run=s.runs.settle(scope,'run',s.run.revision,s.run.leaseToken,'uncertain',20);await assert.rejects(s.journal.reconcileWith('call',async()=>({outcome:'not_applied'})),/attempts exhausted/);let started,resume;const ready=new Promise(r=>started=r),gate=new Promise(r=>resume=r),pending=s.journal.reconcileWith('call',async()=>{started();await gate;return {outcome:'failed'};});await ready;assert.throws(()=>s.runs.reconcile(scope,'run',s.run.revision,'failed',21),/Action requires reconciliation/);s.journal.reconcile('call','failed');s.run=s.runs.reconcile(scope,'run',s.run.revision,'failed',21);resume();await assert.rejects(pending,/Run is not uncertain/);assert.equal(s.journal.get('call').status,'failed');}finally{close(s);}
});


test('a verified non-application retries using the original idempotency key',async()=>{
 const s=setup();let next,original;try{await assert.rejects(s.journal.invoke('call','op',{x:1},2,async(_input,k)=>{original=k;throw Error('lost');}),/uncertain/);s.run=s.runs.settle(scope,'run',s.run.revision,s.run.leaseToken,'uncertain',20);assert.equal(await s.journal.reconcileWith('call',async request=>{assert.equal(request.action.idempotencyKey,original);return {outcome:'not_applied'};}),'not_applied');s.run=s.runs.reconcile(scope,'run',s.run.revision,'retry',21);s.run=s.runs.claim(scope,'run',s.run.revision,'next',100,22);next=new SqliteAgentActionJournal(s.path,{scope,runId:'run',leaseToken:s.run.leaseToken,clock:()=>23});assert.deepEqual(await next.invoke('call','op',{x:1},2,async(_input,k)=>{assert.equal(k,original);return {ok:true};}),{ok:true});}finally{next?.close();close(s);}
});


test('scoped action listing paginates and filters without returning inputs',async()=>{
 const s=setup();let other;try{for(const id of ['alpha','beta','gamma'])await assert.rejects(s.journal.invoke(id,'op',{secret:id},2,async()=>{throw Error('lost');}),/uncertain/);await s.journal.invoke('done','op',{secret:'done'},2,async()=>({ok:true}));const first=s.journal.list({status:'uncertain',limit:2});assert.deepEqual(first.actions.map(x=>x.actionId),['alpha','beta']);assert.equal(first.next,'beta');assert.equal(JSON.stringify(first).includes('secret'),false);assert.deepEqual(s.journal.list({status:'uncertain',limit:2,after:first.next}).actions.map(x=>x.actionId),['gamma']);assert.deepEqual(s.journal.list({status:'succeeded'}).actions.map(x=>x.actionId),['done']);other=new SqliteAgentActionJournal(s.path,{scope:{...scope,tenantId:'other'},runId:'run',leaseToken:s.run.leaseToken});assert.deepEqual(other.list().actions,[]);for(const opts of [{limit:0},{limit:101},{after:'bad space'},{status:'nope'}])assert.throws(()=>s.journal.list(opts),/Invalid action listing/);}finally{other?.close();close(s);}
});

test('bounded recovery passes verify uncertain actions individually without replay',async()=>{
 const s=setup();try{for(const id of ['alpha','beta','gamma'])await assert.rejects(s.journal.invoke(id,'op',{id},2,async()=>{throw Error('lost');}),/uncertain/);let calls=[];await assert.rejects(s.journal.reconcilePending(async()=>({outcome:'unknown'})),/Run is not uncertain/);s.run=s.runs.settle(scope,'run',s.run.revision,s.run.leaseToken,'uncertain',20);const verify=async request=>{calls.push(request.action.actionId);if(request.action.actionId==='alpha')return {outcome:'applied',result:{ok:true}};if(request.action.actionId==='beta')throw Error('unavailable');return {outcome:'unknown'};};const first=await s.journal.reconcilePending(verify,{limit:2});assert.equal(first.next,'beta');assert.deepEqual(first.results.map(x=>x.actionId),['alpha','beta']);assert.equal(first.results[0].outcome,'applied');assert.match(first.results[1].error.message,/unavailable/);const second=await s.journal.reconcilePending(verify,{limit:2,after:first.next});assert.deepEqual(second.results,[{actionId:'gamma',outcome:'unknown'}]);assert.deepEqual(calls,['alpha','beta','gamma']);assert.equal(s.journal.get('alpha').status,'succeeded');assert.equal(s.journal.get('beta').status,'uncertain');assert.equal(s.journal.get('gamma').status,'uncertain');assert.equal(s.run.status,'uncertain');}finally{close(s);}
});

test('recovery pass reports a stale decision after competing reconciliation',async()=>{
 const s=setup();try{await assert.rejects(s.journal.invoke('one','op',{},2,async()=>{throw Error('lost');}),/uncertain/);s.run=s.runs.settle(scope,'run',s.run.revision,s.run.leaseToken,'uncertain',20);let started,resume;const ready=new Promise(r=>started=r),gate=new Promise(r=>resume=r),pending=s.journal.reconcilePending(async()=>{started();await gate;return {outcome:'applied',result:'stale'};});await ready;s.journal.reconcile('one','not_applied');resume();const result=await pending;assert.match(result.results[0].error.message,/stale/);assert.equal(s.journal.get('one').status,'ready');}finally{close(s);}
});
