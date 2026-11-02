import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AIMessage} from '@langchain/core/messages';
import {CapabilityRegistry} from '../../core/dist/index.js';
import {SqliteAgentRuns,SqliteAgentActionJournal,SqliteAgentDefinitions,createConfiguredAgentRun,AgentActionRecoveryWorker} from '../dist/index.js';
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
 const s=setup();try{await assert.rejects(s.journal.invoke('call','op',{},2,async()=>{throw Error('lost');}),/uncertain/);s.run=s.runs.settle(scope,'run',s.run.revision,s.run.leaseToken,'uncertain',20);await assert.rejects(s.journal.reconcileWith('call',async()=>{throw Error('lookup failed');}),/lookup failed/);assert.equal(s.journal.get('call').status,'uncertain');let started,resume;const ready=new Promise(r=>started=r),gate=new Promise(r=>resume=r),pending=s.journal.reconcileWith('call',async()=>{started();await gate;return {outcome:'applied',result:{receipt:'stale'}};},{principalId:'reviewer',reference:'stale-case'});await ready;s.journal.reconcile('call','not_applied');resume();await assert.rejects(pending,/stale/);assert.equal(s.journal.get('call').status,'ready');assert.deepEqual(s.journal.listReconciliations(),[]);}finally{close(s);}
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


test('action reconciliation decisions atomically retain scoped actor and evidence metadata',async()=>{
 const s=setup();let reopened,other,db;try{
  for(const id of ['first','second','unknown'])await assert.rejects(s.journal.invoke(id,'op',{secret:'input'},2,async()=>{throw Error('lost')}),/uncertain/);s.run=s.runs.settle(scope,'run',s.run.revision,s.run.leaseToken,'uncertain',20);
  assert.throws(()=>s.journal.reconcileWithEvidence('first','not_applied',undefined,{principalId:'',reference:'case'}),/evidence/);s.journal.reconcileWithEvidence('first','not_applied',undefined,{principalId:'operator',reference:'case-1'});
  const evidence={principalId:'reviewer',reference:'case-2'};assert.equal(await s.journal.reconcileWith('second',async()=>{evidence.principalId='changed';return {outcome:'applied',result:{secret:'result'}};},evidence),'applied');assert.equal(await s.journal.reconcileWith('unknown',async()=>({outcome:'unknown'}),{principalId:'reviewer',reference:'case-3'}),'unknown');
  const first=s.journal.listReconciliations({limit:1}),second=s.journal.listReconciliations({after:first[0].id,limit:1});assert.equal(first[0].actionId,'first');assert.equal(first[0].principalId,'operator');assert.equal(first[0].method,'manual');assert.equal(second[0].principalId,'reviewer');assert.equal(second[0].method,'verifier');assert.equal(second[0].outcome,'applied');assert.equal(JSON.stringify([...first,...second]).includes('secret'),false);
  other=new SqliteAgentActionJournal(s.path,{scope:{...scope,tenantId:'other'},runId:'run',leaseToken:'token'});assert.deepEqual(other.listReconciliations(),[]);reopened=new SqliteAgentActionJournal(s.path,{scope,runId:'run',leaseToken:'token'});assert.deepEqual(reopened.listReconciliations(),[...first,...second]);db=new DatabaseSync(s.path);assert.throws(()=>db.exec('DELETE FROM agent_action_reconciliations'),/immutable/);assert.throws(()=>db.exec("UPDATE agent_action_reconciliations SET reference='other'"),/immutable/);
 }finally{db?.close();other?.close();reopened?.close();close(s);}
});

test('audit insertion failure rolls back action reconciliation',async()=>{
 const s=setup();let db;try{await assert.rejects(s.journal.invoke('call','op',{},2,async()=>{throw Error('lost')}),/uncertain/);s.run=s.runs.settle(scope,'run',s.run.revision,s.run.leaseToken,'uncertain',20);db=new DatabaseSync(s.path);db.exec("CREATE TRIGGER reject_action_audit BEFORE INSERT ON agent_action_reconciliations BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;");const evidence={principalId:'reviewer',reference:'case'};assert.throws(()=>s.journal.reconcileWithEvidence('call','failed',undefined,evidence),/audit unavailable/);assert.equal(s.journal.get('call').status,'uncertain');await assert.rejects(s.journal.reconcileWith('call',async()=>({outcome:'applied',result:{ok:true}}),evidence),/audit unavailable/);assert.equal(s.journal.get('call').status,'uncertain');assert.deepEqual(s.journal.listReconciliations(),[]);
 }finally{db?.close();close(s);}
});


test('recovery worker authorizes each action, records evidence and revisits unresolved entries',async()=>{
 const s=setup(),errors=[],seen=[];try{for(const action of ['a','b','c'])await assert.rejects(s.journal.invoke(action,'op',{action},3,async()=>{throw Error('lost')}),/uncertain/);s.run=s.runs.settle(scope,'run',s.run.revision,s.run.leaseToken,'uncertain',20);let deny=true;const worker=new AgentActionRecoveryWorker({journal:s.journal,maxPerPass:2,pollMs:100,onError:(error,id)=>errors.push([error.message,id]),authorize:action=>!(deny&&action.actionId==='a'),evidence:action=>({principalId:'operator',reference:'case-'+action.actionId}),verify:async request=>{seen.push(request.action.actionId);return request.action.actionId==='b'?{outcome:'unknown'}:{outcome:'applied',result:{id:request.action.actionId}};}});assert.equal(await worker.runOnce(),0);assert.equal(s.journal.get('a').status,'uncertain');assert.equal(await worker.runOnce(),1);assert.equal(s.journal.get('c').status,'succeeded');deny=false;assert.equal(await worker.runOnce(),1);assert.equal(s.journal.get('a').status,'succeeded');assert.equal(s.journal.get('b').status,'uncertain');assert.deepEqual(s.journal.listReconciliations().map(event=>[event.actionId,event.principalId,event.reference,event.method]),[['c','operator','case-c','verifier'],['a','operator','case-a','verifier']]);assert.deepEqual(seen,['b','c','a','b']);assert.deepEqual(errors,[]);assert.equal(s.runs.get(scope,'run').status,'uncertain');
 }finally{close(s);}
});

test('recovery worker rejects missing evidence and policy revocation before committing',async()=>{
 const s=setup(),errors=[];try{await assert.rejects(s.journal.invoke('one','op',{},2,async()=>{throw Error('lost')}),/uncertain/);s.run=s.runs.settle(scope,'run',s.run.revision,s.run.leaseToken,'uncertain',20);let calls=0,allowed=true,proof;const worker=new AgentActionRecoveryWorker({journal:s.journal,maxPerPass:1,pollMs:100,onError:error=>errors.push(error.message),authorize:()=>allowed,evidence:()=>proof,verify:async()=>{calls++;allowed=false;return {outcome:'applied',result:'result'};}});assert.equal(await worker.runOnce(),0);assert.equal(calls,0);assert.match(errors[0],/evidence/);proof={principalId:'operator',reference:'case'};assert.equal(await worker.runOnce(),0);assert.equal(calls,1);assert.match(errors[1],/forbidden/);assert.equal(s.journal.get('one').status,'uncertain');assert.deepEqual(s.journal.listReconciliations(),[]);
 }finally{close(s);}
});

test('stopping a recovery worker prevents a late verifier result from changing the journal',async()=>{
 const s=setup();let entered,release;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);try{await assert.rejects(s.journal.invoke('one','op',{},2,async()=>{throw Error('lost')}),/uncertain/);s.run=s.runs.settle(scope,'run',s.run.revision,s.run.leaseToken,'uncertain',20);const worker=new AgentActionRecoveryWorker({journal:s.journal,maxPerPass:1,pollMs:100,onError:()=>{},authorize:()=>true,evidence:()=>({principalId:'operator',reference:'case'}),verify:async()=>{entered();await gate;return {outcome:'applied',result:'verified'};}});worker.start();await started;const stopping=worker.stop();release();await stopping;assert.equal(s.journal.get('one').status,'uncertain');assert.deepEqual(s.journal.listReconciliations(),[]);assert.equal(await worker.runOnce(),1);assert.equal(s.journal.get('one').status,'succeeded');assert.equal(s.journal.listReconciliations().length,1);
 }finally{close(s);}
});

test('stopping a manual recovery pass discards a late verifier result and permits retry',async()=>{
 const s=setup(),errors=[];let entered,release,block=true;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 try{await assert.rejects(s.journal.invoke('one','op',{},2,async()=>{throw Error('lost')}),/uncertain/);s.run=s.runs.settle(scope,'run',s.run.revision,s.run.leaseToken,'uncertain',20);
  const worker=new AgentActionRecoveryWorker({journal:s.journal,maxPerPass:1,pollMs:100,onError:error=>errors.push(error),authorize:()=>true,evidence:()=>({principalId:'operator',reference:'case'}),verify:async()=>{if(block){entered();await gate;}return {outcome:'applied',result:'verified'};}});
  const pending=worker.runOnce();await started;const stopping=worker.stop();block=false;release();assert.equal(await pending,0);await stopping;assert.equal(s.journal.get('one').status,'uncertain');assert.deepEqual(s.journal.listReconciliations(),[]);assert.deepEqual(errors,[]);
  assert.equal(await worker.runOnce(),1);assert.equal(s.journal.get('one').status,'succeeded');assert.equal(s.journal.listReconciliations().length,1);
 }finally{close(s);}
});

test('recovery worker signals cancellation to every cooperative host callback',async()=>{
 for(const phase of ['authorize','evidence','verify','reauthorize']){const s=setup(),errors=[];let entered,seen,blocking=true,authorizationCalls=0;const started=new Promise(resolve=>entered=resolve),pause=async signal=>{assert.ok(signal instanceof AbortSignal);seen=signal;entered();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));throw Error('callback cancelled');};try{await assert.rejects(s.journal.invoke('one','op',{},2,async()=>{throw Error('lost')}),/uncertain/);s.run=s.runs.settle(scope,'run',s.run.revision,s.run.leaseToken,'uncertain',20);const worker=new AgentActionRecoveryWorker({journal:s.journal,maxPerPass:1,pollMs:100,onError:error=>errors.push(error),authorize:async(_action,signal)=>{authorizationCalls++;if(blocking&&(phase==='authorize'&&authorizationCalls===1||phase==='reauthorize'&&authorizationCalls===2))await pause(signal);return true;},evidence:async(_action,signal)=>{if(blocking&&phase==='evidence')await pause(signal);return {principalId:'operator',reference:'case'};},verify:async(_request,signal)=>{if(blocking&&phase==='verify')await pause(signal);return {outcome:'applied',result:'verified'};}});const pending=worker.runOnce();await started;await worker.stop();assert.equal(seen.aborted,true,phase);assert.equal(await pending,0);assert.equal(s.journal.get('one').status,'uncertain');assert.deepEqual(s.journal.listReconciliations(),[]);assert.deepEqual(errors,[]);blocking=false;assert.equal(await worker.runOnce(),1);assert.equal(s.journal.get('one').status,'succeeded');assert.equal(s.journal.listReconciliations().length,1);await worker.stop();}finally{close(s);}}
});

test('recovery worker fences uncooperative evidence and ignores async error observers',async()=>{
 const s=setup();let entered,release,block=true,verified=0;const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);try{await assert.rejects(s.journal.invoke('one','op',{},2,async()=>{throw Error('lost')}),/uncertain/);s.run=s.runs.settle(scope,'run',s.run.revision,s.run.leaseToken,'uncertain',20);const worker=new AgentActionRecoveryWorker({journal:s.journal,maxPerPass:1,pollMs:100,onError:()=>Promise.reject(Error('observer unavailable')),authorize:()=>true,evidence:async()=>{if(block){entered();await gate;}return {principalId:'operator',reference:'case'};},verify:async()=>{verified++;throw Error('provider unavailable');}});worker.start();await started;const stopping=worker.stop();block=false;release();await stopping;assert.equal(verified,0);assert.equal(s.journal.get('one').status,'uncertain');assert.equal(await worker.runOnce(),0);assert.equal(verified,1);assert.equal(s.journal.get('one').status,'uncertain');await worker.stop();}finally{release();close(s);}
});
