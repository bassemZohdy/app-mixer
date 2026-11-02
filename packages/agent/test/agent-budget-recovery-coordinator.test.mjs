import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteAgentRuns,SqliteAgentTokenBudget,SqliteAgentBudgetRecoveryDiscovery,AgentBudgetRecovery,AgentBudgetRecoveryWorker,AgentBudgetRecoveryCoordinator} from '../dist/index.js';
const scope={tenantId:'tenant',agentId:'agent'},actor={tenantId:'tenant',principalId:'operator'},config={definitionVersion:1,maxAttempts:2,deadline:1000};
function setup(){const dir=mkdtempSync(join(tmpdir(),'budget-coordinator-')),path=join(dir,'runs.sqlite'),runs=new SqliteAgentRuns(path);return {dir,path,runs};}
function add(s,selected,runId,finish=true){let run=s.runs.create(selected,runId,config,0);run=s.runs.claim(selected,runId,run.revision,'worker',100,1);const budget=new SqliteAgentTokenBudget(s.path,{scope:selected,runId,leaseToken:run.leaseToken,maxTokens:100,clock:()=>2});budget.reserve('call',20);if(finish)run=s.runs.settle(selected,runId,run.revision,run.leaseToken,'uncertain',3);budget.close();return run;}
function session(s,runId,verify,closed,selected=scope){const budget=new SqliteAgentTokenBudget(s.path,{scope:selected,runId,leaseToken:'retired',maxTokens:100,clock:()=>4}),recovery=new AgentBudgetRecovery({budget,target:{scope:selected,runId,maxTokens:100},authorize:()=>true,verify}),worker=new AgentBudgetRecoveryWorker({runs:s.runs,recovery,scope:selected,runId,actor:{tenantId:selected.tenantId,principalId:'operator'},reference:()=>`case-${runId}`,maxPerPass:1,pollMs:100,onError:()=>{}});return {worker,close:()=>{closed.push(runId);budget.close();}};}
function coordinator(discovery,options={}){return new AgentBudgetRecoveryCoordinator({discovery,scope,actor,authorize:()=>true,open:()=>{throw Error('not configured');},maxRunsPerPass:1,pollMs:100,onError:()=>{},...options});}
function close(s){s.runs.close();rmSync(s.dir,{recursive:true,force:true});}
test('coordinator scans bounded authorized runs, skips active runs and closes sessions',async()=>{
 const s=setup();let discovery;try{for(const name of ['a','b','c'])add(s,scope,name);add(s,scope,'live',false);add(s,{...scope,tenantId:'other'},'foreign');discovery=new SqliteAgentBudgetRecoveryDiscovery(s.path,{scope,authorize:()=>true});const closed=[],opened=[],service=coordinator(discovery,{authorize:item=>item.runId!=='a',open:item=>{opened.push(item.runId);return session(s,item.runId,()=>item.runId==='c'?undefined:{usedTokens:5},closed);}});assert.equal(await service.runOnce(),0);assert.equal(await service.runOnce(),1);assert.equal(await service.runOnce(),0);assert.equal(await service.runOnce(),0);assert.deepEqual(opened,['b','c']);assert.deepEqual(closed,['b','c']);const remaining=await discovery.list(actor);assert.deepEqual(remaining.items.map(item=>item.runId),['a','c','live']);assert.equal(s.runs.get(scope,'b').status,'uncertain');assert.equal(s.runs.get({...scope,tenantId:'other'},'foreign').status,'uncertain');
 }finally{discovery?.close();close(s);}
});
test('coordinator rechecks authorization after opening and rejects wrong workers',async()=>{
 const s=setup();let discovery;try{add(s,scope,'a');add(s,scope,'b');discovery=new SqliteAgentBudgetRecoveryDiscovery(s.path,{scope,authorize:()=>true});const closed=[],errors=[];let checks=0,verified=0;const service=coordinator(discovery,{authorize:()=>++checks===1,open:item=>session(s,item.runId,()=>{verified++;return {usedTokens:1};},closed),onError:(_error,id)=>errors.push(id)});assert.equal(await service.runOnce(),0);assert.deepEqual(closed,['a']);assert.equal(verified,0);const wrong=coordinator(discovery,{open:()=>session(s,'b',()=>({usedTokens:1}),closed),onError:(_error,id)=>errors.push(id)});assert.equal(await wrong.runOnce(),0);assert.deepEqual(errors,['a']);assert.deepEqual(closed,['a','b']);assert.throws(()=>coordinator(discovery,{scope:{tenantId:'other',agentId:'agent'}}),/Invalid/);
 }finally{discovery?.close();close(s);}
});
test('coordinator cancellation fences a delayed discovery policy',async()=>{
 const s=setup();let discovery,release;try{add(s,scope,'a');let entered,opens=0,received;const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);discovery=new SqliteAgentBudgetRecoveryDiscovery(s.path,{scope,authorize:async(_actor,_scope,signal)=>{received=signal;entered();await gate;return true;}});const service=coordinator(discovery,{open:()=>{opens++;throw Error('unexpected');}}),pending=service.runOnce();await ready;await service.stop();assert.equal(await pending,0);assert.equal(received.aborted,true);release();await new Promise(resolve=>setImmediate(resolve));assert.equal(opens,0);
 }finally{release?.();discovery?.close();close(s);}
});
test('coordinator closes a late-opened session after stopping',async()=>{
 const s=setup();let discovery,release;try{add(s,scope,'a');let entered,verified=0;const closed=[],ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);discovery=new SqliteAgentBudgetRecoveryDiscovery(s.path,{scope,authorize:()=>true});const service=coordinator(discovery,{open:async item=>{entered();await gate;return session(s,item.runId,()=>{verified++;return {usedTokens:1};},closed);}}),pending=service.runOnce();await ready;let done=false;const stopping=service.stop().then(()=>done=true);await Promise.resolve();assert.equal(done,false);release();await stopping;assert.equal(await pending,0);assert.deepEqual(closed,['a']);assert.equal(verified,0);
 }finally{release?.();discovery?.close();close(s);}
});
test('coordinator stops an in-flight verifier and rejects its late result',async()=>{
 const s=setup();let discovery,release;try{add(s,scope,'a');let entered,received;const closed=[],ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);discovery=new SqliteAgentBudgetRecoveryDiscovery(s.path,{scope,authorize:()=>true});const service=coordinator(discovery,{open:item=>session(s,item.runId,async(_actor,_target,_call,_cost,_reference,signal)=>{received=signal;entered();await gate;return {usedTokens:5};},closed)}),pending=service.runOnce();await ready;await service.stop();assert.equal(await pending,0);assert.equal(received.aborted,true);assert.deepEqual(closed,['a']);release();await new Promise(resolve=>setImmediate(resolve));const budget=new SqliteAgentTokenBudget(s.path,{scope,runId:'a',leaseToken:'retired',maxTokens:100,clock:()=>4});try{assert.equal(budget.get('call').status,'reserved');assert.deepEqual(budget.reconciliationHistory(),[]);}finally{budget.close();}
 }finally{release?.();discovery?.close();close(s);}
});


test('coordinator polling stops without starting later passes',async()=>{
 const s=setup();let discovery,release;try{add(s,scope,'a');let entered,authorizations=0,opens=0;const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);discovery=new SqliteAgentBudgetRecoveryDiscovery(s.path,{scope,authorize:()=>true});const service=coordinator(discovery,{authorize:async()=>{authorizations++;entered();await gate;return true;},open:()=>{opens++;throw Error('unexpected');}});service.start();await ready;assert.throws(()=>service.start(),/already running/);const stopping=service.stop();release();await stopping;await new Promise(resolve=>setTimeout(resolve,160));assert.equal(authorizations,1);assert.equal(opens,0);
 }finally{release?.();discovery?.close();close(s);}
});
