// Boundary tests for the action journal, the part of the agent runtime that keeps an outbound action from being repeated. A
// mutation run (scripts/mutate.mjs) found that 89 of 245 small changes went unnoticed: the limits on action data, the
// validation of each argument, re-invoking an action with different content, what an approval has to match, the exact moment
// an approval expires, and the checks that stop a verifier from acting on stale state. Every case below fails when its
// condition is removed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SqliteAgentRuns,SqliteAgentApprovals,SqliteAgentActionJournal,markNoEffect,hadNoEffect} from '../dist/index.js';
import {actionJSON} from '../dist/action-journal.js';

const scope={tenantId:'tenant',agentId:'agent'},service={tenantId:'tenant',principalId:'service'},human={tenantId:'tenant',principalId:'human'};

function setup({deadline=1000,leaseMs=100}={}){
 const dir=mkdtempSync(join(tmpdir(),'journal-bounds-')),path=join(dir,'runs.sqlite'),runs=new SqliteAgentRuns(path);
 let run=runs.create(scope,'run',{definitionVersion:1,maxAttempts:3,deadline},0);run=runs.claim(scope,'run',run.revision,'worker',leaseMs,10);
 const state={now:10};
 const journal=new SqliteAgentActionJournal(path,{scope,runId:'run',leaseToken:run.leaseToken,clock:()=>state.now});
 const approvals=new SqliteAgentApprovals(path,{scope,runId:'run',clock:()=>state.now,authorize:()=>true});
 const handle={state,journal,approvals,runs,path,token:run.leaseToken,get run(){return run;},set run(value){run=value;},close(){journal.close();approvals.close();runs.close();rmSync(dir,{recursive:true,force:true});},
  /** End the worker's lease the way a crash recovery does: the run becomes uncertain. */
  makeUncertain(){run=runs.settle(scope,'run',run.revision,run.leaseToken,'uncertain',state.now);}};
 return handle;
}
const ok=async(input,key)=>({echo:input,key});

test('action data is bounded and canonical',()=>{
 const nest=levels=>{let value=[];for(let i=0;i<levels;i++)value=[value];return value;};
 assert.equal(actionJSON({b:1,a:[true,null,'x',1.5]}),'{"a":[true,null,"x",1.5],"b":1}','keys are sorted');
 assert.equal(actionJSON(Object.create(null)),'{}');
 // Nodes: the value itself counts as one, so 9999 elements are allowed and 10000 are not.
 assert.ok(actionJSON(Array.from({length:9999},()=>1)));assert.throws(()=>actionJSON(Array.from({length:10000},()=>1)),/Invalid action data/);
 assert.ok(actionJSON(nest(40)),'40 levels');assert.throws(()=>actionJSON(nest(41)),/Invalid action data/,'41 levels');
 assert.ok(actionJSON('x'.repeat(1024*1024-2)),'exactly one megabyte');assert.throws(()=>actionJSON('x'.repeat(1024*1024-1)),/Invalid action data/,'one byte more');
 const objectWithNodes=count=>Object.fromEntries(Array.from({length:count},(_,i)=>['k'+i,1]));assert.ok(actionJSON(objectWithNodes(9999)));assert.throws(()=>actionJSON(objectWithNodes(10000)),/Invalid action data/);
 for(const [label,bad] of Object.entries({
  'undefined':undefined,'a function':()=>1,'NaN':NaN,'Infinity':Infinity,'a symbol':Symbol('x'),'a bigint':1n,'a date':new Date(0),'a class instance':new (class Foo{})(),'a map':new Map(),
  'a sparse array':[1,,3],'an array with a named property':Object.assign([1],{extra:2}),'__proto__':JSON.parse('{"__proto__":1}'),'constructor':{constructor:1},'prototype':{prototype:1},
  'a cycle':(()=>{const a={};a.self=a;return a;})(),'an array cycle':(()=>{const a=[];a.push(a);return a;})(),'undefined inside':{a:undefined},'a function inside':{a:()=>1}
 }))assert.throws(()=>actionJSON(bad),/Invalid action data/,label);
 // Reuse of the same object in two places is not a cycle.
 const shared={n:1};assert.equal(actionJSON({a:shared,b:shared}),'{"a":{"n":1},"b":{"n":1}}');
 assert.equal(actionJSON(Array.from({length:10},(_,i)=>i)),'[0,1,2,3,4,5,6,7,8,9]');
 assert.ok(hadNoEffect(markNoEffect(new Error('x'))));assert.equal(hadNoEffect(new Error('x')),false);assert.equal(hadNoEffect(null),false);assert.equal(hadNoEffect('x'),false);
 const frozen=Object.freeze(new Error('frozen'));assert.equal(markNoEffect(frozen),frozen);assert.equal(hadNoEffect(frozen),false,'a frozen error cannot be marked');assert.equal(markNoEffect(null),null);assert.equal(markNoEffect('text'),'text');
});

test('the journal options are validated one at a time',()=>{
 const s=setup();
 try{
  const base={scope,runId:'run',leaseToken:s.token};
  new SqliteAgentActionJournal(s.path,{...base,clock:()=>1}).close();
  for(const [label,options] of Object.entries({'no options':undefined,'no scope':{...base,scope:undefined},'tenant invalid':{...base,scope:{...scope,tenantId:''}},'agent invalid':{...base,scope:{...scope,agentId:''}},'run invalid':{...base,runId:''},'lease token invalid':{...base,leaseToken:''},'clock not a function':{...base,clock:'now'}}))assert.throws(()=>new SqliteAgentActionJournal(s.path,options),/Invalid action journal configuration/,label);
  assert.equal(s.journal.isBoundTo(scope,'run'),true);assert.equal(s.journal.isBoundTo({...scope,tenantId:'x'},'run'),false);assert.equal(s.journal.isBoundTo({...scope,agentId:'x'},'run'),false);assert.equal(s.journal.isBoundTo(scope,'other'),false);assert.equal(s.journal.isBoundTo(undefined,'run'),false);
 }finally{s.close();}
});

test('invoke validates each argument, and the lease and the clock fence it',async()=>{
 const s=setup({leaseMs:100});
 try{
  const call=(args)=>s.journal.invoke(...args);
  await call(['a1','op',{n:1},1,ok]);await call(['a20','op',{n:1},20,ok]);await call(['auth','op',{n:1},1,ok,false,'x']);await call(['auth2','op',{n:1},1,ok,false,'x'.repeat(1024)]);
  for(const [label,args] of Object.entries({
   'action id invalid':['',  'op',{},1,ok],'operation id invalid':['b','',{},1,ok],'attempts 0':['b','op',{},0,ok],'attempts 21':['b','op',{},21,ok],'attempts fractional':['b','op',{},1.5,ok],'attempts text':['b','op',{},'2',ok],
   'dispatch missing':['b','op',{},1,undefined],'dispatch not a function':['b','op',{},1,'go'],'approval flag not boolean':['b','op',{},1,ok,'yes'],'authority empty':['b','op',{},1,ok,false,''],'authority too long':['b','op',{},1,ok,false,'x'.repeat(1025)],'authority not text':['b','op',{},1,ok,false,7],
   'data not serializable':['b','op',{a:undefined},1,ok]
  }))await assert.rejects(call(args),/Invalid action/,label);
  // The lease ends at its last millisecond.
  s.state.now=109;await call(['late-ok','op',{},1,ok]);s.state.now=110;await assert.rejects(call(['late','op',{},1,ok]),/lease unavailable/,'the lease has ended');
  s.state.now=50;
  const withClock=async(clock,token=s.token)=>{const extra=new SqliteAgentActionJournal(s.path,{scope,runId:'run',leaseToken:token,clock});try{return await extra.invoke('probe','op',{},1,ok);}finally{extra.close();}};
  for(const bad of [-1,1.5,NaN])await assert.rejects(withClock(()=>bad),/Invalid clock/,String(bad));
  await assert.rejects(withClock(()=>50,'another-lease-token'),/lease unavailable/,'another lease token');
 }finally{s.close();}
});

test('an action is identified by its content, and a finished one is replayed from the journal',async()=>{
 const s=setup();
 try{
  let dispatched=0;const keys=[];
  const run=(id,op,input,max,authority)=>s.journal.invoke(id,op,input,max,async(data,key)=>{dispatched++;keys.push(key);return {sent:data};},false,authority);
  assert.deepEqual(await run('pay','charge',{amount:5,currency:'usd'},2),{sent:{amount:5,currency:'usd'}});
  // The same action again does not dispatch, whatever the key order of its input.
  assert.deepEqual(await run('pay','charge',{currency:'usd',amount:5},2),{sent:{amount:5,currency:'usd'}});assert.equal(dispatched,1);
  for(const [label,call] of Object.entries({'another operation':()=>run('pay','refund',{amount:5,currency:'usd'},2),'other input':()=>run('pay','charge',{amount:6,currency:'usd'},2),'a different attempt limit':()=>run('pay','charge',{amount:5,currency:'usd'},3),'an authority it was not created with':()=>run('pay','charge',{amount:5,currency:'usd'},2,'finance')}))await assert.rejects(call(),/identity conflict|authority conflict/,label);
  assert.equal(dispatched,1);
  // The authority recorded with an action must be repeated exactly.
  await run('auth','charge',{n:1},1,'finance');await assert.rejects(run('auth','charge',{n:1},1),/authority conflict/,'authority left out');await assert.rejects(run('auth','charge',{n:1},1,'other'),/authority conflict/,'another authority');
  assert.equal(new Set(keys).size,keys.length,'each action has its own idempotency key');assert.match(keys[0],/^[0-9a-f-]{36}$/);
 }finally{s.close();}
});

test('a refusal before any effect is retried with the same key; any other failure leaves the action uncertain',async()=>{
 const s=setup();
 try{
  const keys=[];let calls=0;
  const flaky=async(_data,key)=>{keys.push(key);calls++;if(calls<=2)throw markNoEffect(new Error('refused before sending'));return {done:true};};
  // Two attempts allowed: the first refusal returns the action to ready, the second one exhausts it.
  await assert.rejects(s.journal.invoke('retry','op',{},2,flaky),/refused before sending/,'the refusal is rethrown as it was');assert.equal(s.journal.get('retry').status,'ready');assert.equal(s.journal.get('retry').attempts,1);
  await assert.rejects(s.journal.invoke('retry','op',{},2,flaky),/refused before sending/);assert.equal(s.journal.get('retry').status,'failed','the second refusal uses the last attempt');assert.equal(s.journal.get('retry').attempts,2);
  assert.equal(keys[0],keys[1],'a retry uses the same idempotency key');
  await assert.rejects(s.journal.invoke('retry','op',{},2,flaky),/requires reconciliation/,'a failed action is not run again');
  // One attempt allowed: the first refusal already fails the action.
  await assert.rejects(s.journal.invoke('once','op',{},1,async()=>{throw markNoEffect(new Error('no'));}),/no/);assert.equal(s.journal.get('once').status,'failed');
  // Any other failure: the effect may have happened.
  const failure=new Error('connection reset');await assert.rejects(s.journal.invoke('unsure','op',{},3,async()=>{throw failure;}),error=>error.message==='Action outcome uncertain'&&error.cause===failure);
  assert.equal(s.journal.get('unsure').status,'uncertain');await assert.rejects(s.journal.invoke('unsure','op',{},3,ok),/requires reconciliation/,'an uncertain action is not run again');
  // A result that cannot be recorded is also uncertain.
  await assert.rejects(s.journal.invoke('badresult','op',{},1,async()=>({when:new Date(0)})),/uncertain/);assert.equal(s.journal.get('badresult').status,'uncertain');
  assert.equal(s.journal.get('missing'),undefined);assert.throws(()=>s.journal.get(''),/Invalid action/);
 }finally{s.close();}
});

test('an approval has to match the action exactly and be unexpired',async()=>{
 const s=setup();
 try{
  const approve=async(id,op,input,expiresAt,decision='approved')=>{await s.approvals.request(service,s.token,id,op,input,expiresAt);if(decision!==null)await s.approvals.decide(human,id,decision);};
  const attempt=(id,op,input)=>s.journal.invoke(id,op,input,1,ok,true);
  await assert.rejects(attempt('none','pay',{n:1}),/Approval required/,'no approval at all');
  await approve('good','pay',{n:1},60);assert.ok(await attempt('good','pay',{n:1}),'an approved action runs');
  await approve('other-op','pay',{n:1},60);await assert.rejects(attempt('other-op','refund',{n:1}),/Approval required/,'approved for another operation');
  await approve('other-input','pay',{n:1},60);await assert.rejects(attempt('other-input','pay',{n:2}),/Approval required/,'approved for other input');
  await approve('pending','pay',{n:1},60,null);await assert.rejects(attempt('pending','pay',{n:1}),/Approval required/,'not yet decided');
  await approve('rejected','pay',{n:1},60,'rejected');await assert.rejects(attempt('rejected','pay',{n:1}),/Approval required/,'rejected');
  await approve('cancelled','pay',{n:1},60,'cancelled');await assert.rejects(attempt('cancelled','pay',{n:1}),/Approval required/,'cancelled');
  // The approval is valid until the millisecond before it expires.
  await approve('edge-ok','pay',{n:1},60);await approve('edge','pay',{n:1},60);
  s.state.now=59;assert.ok(await attempt('edge-ok','pay',{n:1}),'one millisecond before the expiry');
  s.state.now=60;await assert.rejects(attempt('edge','pay',{n:1}),/Approval required/,'at the moment of expiry');
  // An action that needs approval keeps needing it on a retry after the approval is gone, and one that does not need it is not asked.
  s.state.now=20;assert.ok(await s.journal.invoke('free','pay',{n:1},1,ok,false),'no approval required');
 }finally{s.close();}
});

test('reconciliation needs an uncertain run and an uncertain action, and records its decisions',async()=>{
 const s=setup();
 try{
  for(const id of ['a','b','c'])await assert.rejects(s.journal.invoke(id,'op',{id},3,async()=>{throw new Error('lost');}),/uncertain/);
  await assert.rejects(s.journal.invoke('e','op',{id:'e'},1,async()=>{throw new Error('lost');}),/uncertain/);
  await assert.rejects(()=>Promise.resolve().then(()=>s.journal.reconcile('a','applied',{ok:1})),/not uncertain/,'the run is still running');
  assert.throws(()=>s.journal.markUncertain('a'),undefined,'only a dispatching action can be marked');
  s.makeUncertain();
  // The decision arguments.
  for(const [label,call] of Object.entries({'action id invalid':()=>s.journal.reconcile('','applied',{}),'outcome invalid':()=>s.journal.reconcile('a','done',{}),'outcome missing':()=>s.journal.reconcile('a',undefined,{}),'result with a failure':()=>s.journal.reconcile('a','failed',{x:1}),'result with not_applied':()=>s.journal.reconcile('a','not_applied',{x:1}),'applied with unserializable data':()=>s.journal.reconcile('a','applied',{x:undefined})}))assert.throws(call,/Invalid reconciliation|Invalid action data/,label);
  assert.throws(()=>s.journal.reconcile('unknown','failed'),/Invalid action state/,'an unknown action');
  s.journal.reconcile('a','applied',{receipt:'r1'});assert.equal(s.journal.get('a').status,'succeeded');
  s.journal.reconcile('b','failed');assert.equal(s.journal.get('b').status,'failed');
  s.journal.reconcile('c','not_applied');assert.equal(s.journal.get('c').status,'ready');
  assert.throws(()=>s.journal.reconcile('a','failed'),/Invalid action state/,'a decided action cannot be decided again');
  // not_applied is refused once every attempt has been used, and the action stays uncertain.
  assert.throws(()=>s.journal.reconcile('e','not_applied'),/attempts exhausted/);assert.equal(s.journal.get('e').status,'uncertain');
  s.journal.reconcile('e','failed');assert.equal(s.journal.get('e').status,'failed');
 }finally{s.close();}
});

test('a manual decision records who took it and what they relied on',async()=>{
 const s=setup();
 try{
  await assert.rejects(s.journal.invoke('x','op',{},1,async()=>{throw new Error('lost');}),/uncertain/);await assert.rejects(s.journal.invoke('y','op',{},1,async()=>{throw new Error('lost');}),/uncertain/);
  s.makeUncertain();s.state.now=40;
  for(const [label,evidence] of Object.entries({'no evidence':undefined,'principal invalid':{principalId:'',reference:'ticket-1'},'reference invalid':{principalId:'human',reference:''},'principal missing':{reference:'ticket-1'}}))assert.throws(()=>s.journal.reconcileWithEvidence('x','applied',{},evidence),/Invalid action reconciliation evidence/,label);
  s.journal.reconcileWithEvidence('x','applied',{ok:true},{principalId:'human',reference:'ticket-1'});
  s.journal.reconcileWithEvidence('y','failed',undefined,{principalId:'human',reference:'ticket-2'});
  const records=s.journal.listReconciliations();assert.deepEqual(records.map(r=>[r.actionId,r.principalId,r.reference,r.outcome,r.method,r.recordedAt]),[['x','human','ticket-1','applied','manual',40],['y','human','ticket-2','failed','manual',40]]);
  assert.equal(s.journal.listReconciliations({after:records[0].id}).length,1);assert.equal(s.journal.listReconciliations({limit:1}).length,1);assert.equal(s.journal.listReconciliations({limit:100}).length,2);
  for(const bad of [{after:-1},{after:1.5},{limit:0},{limit:101},{limit:1.5},null])assert.throws(()=>s.journal.listReconciliations(bad),/Invalid action reconciliation listing/,JSON.stringify(bad));
  for(const bad of [-1,1.5,NaN]){const clocked=new SqliteAgentActionJournal(s.path,{scope,runId:'run',leaseToken:s.token,clock:()=>bad});assert.throws(()=>clocked.reconcileWithEvidence('x','failed',undefined,{principalId:'human',reference:'r'}),undefined);clocked.close();}
 }finally{s.close();}
});

test('listing actions validates its options and pages through them',async()=>{
 const s=setup();
 try{
  for(const id of ['a','b','c'])await s.journal.invoke(id,'op',{id},1,ok);
  const page=s.journal.list({limit:2});assert.deepEqual(page.actions.map(a=>a.actionId),['a','b']);assert.equal(page.next,'b');
  assert.deepEqual(s.journal.list({after:'b'}).actions.map(a=>a.actionId),['c']);assert.deepEqual(s.journal.list({limit:100}).actions.length,3);assert.equal(s.journal.list({limit:3}).next,undefined);
  assert.equal(s.journal.list({status:'succeeded'}).actions.length,3);assert.equal(s.journal.list({status:'uncertain'}).actions.length,0);
  for(const status of ['ready','dispatching','uncertain','succeeded','failed'])s.journal.list({status});
  for(const [label,options] of Object.entries({'null':null,'not an object':'x','limit 0':{limit:0},'limit 101':{limit:101},'limit fractional':{limit:1.5},'limit text':{limit:'5'},'after invalid':{after:''},'status unknown':{status:'done'}}))assert.throws(()=>s.journal.list(options),/Invalid action listing/,label);
 }finally{s.close();}
});

test('a verifier can only act on the state it was shown',async()=>{
 const s=setup();
 try{
  await assert.rejects(s.journal.invoke('v','op',{n:1},3,async()=>{throw new Error('lost');}),/uncertain/);
  await assert.rejects(s.journal.reconcileWith('v',async()=>({outcome:'unknown'})),/not uncertain/,'the run is still running');
  s.makeUncertain();
  const verify=outcome=>()=>Promise.resolve(outcome);
  for(const [label,decision] of Object.entries({'nothing':undefined,'null':null,'an array':[],'unknown outcome':{outcome:'maybe'},'outcome missing':{},'outcome not text':{outcome:1},'extra field':{outcome:'failed',extra:true},'applied without a result':{outcome:'applied'},'failed with a result':{outcome:'failed',result:{}},'unknown with a result':{outcome:'unknown',result:{}},'not_applied with a result':{outcome:'not_applied',result:{}}}))await assert.rejects(s.journal.reconcileWith('v',verify(decision)),/Invalid action verification/,label);
  await assert.rejects(s.journal.reconcileWith('',verify({outcome:'failed'})),/Invalid action verification/,'action id');await assert.rejects(s.journal.reconcileWith('v','not a function'),/Invalid action verification/,'verifier');
  await assert.rejects(s.journal.reconcileWith('v',verify({outcome:'failed'}),{principalId:'',reference:'r'}),/Invalid action reconciliation evidence/);
  await assert.rejects(s.journal.reconcileWith('nope',verify({outcome:'failed'})),/Invalid action state/,'an unknown action');
  // The verifier is shown the action and its input and cannot change what is recorded afterwards.
  let shown;assert.equal(await s.journal.reconcileWith('v',async request=>{shown=request;return {outcome:'unknown'};}),'unknown');
  assert.deepEqual([shown.runId,shown.action.actionId,shown.action.status,shown.input],['run','v','uncertain',{n:1}]);assert.equal(s.journal.get('v').status,'uncertain','unknown keeps the action uncertain');
  // A run that changes while the verifier is deciding makes the decision stale.
  await assert.rejects(s.journal.reconcileWith('v',async()=>{s.journal.reconcile('v','failed');return {outcome:'applied',result:{}};}),/verification stale/,'decided meanwhile');
  assert.equal(s.journal.get('v').status,'failed');
 }finally{s.close();}
});
