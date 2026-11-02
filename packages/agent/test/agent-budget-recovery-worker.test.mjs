import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteAgentRuns,SqliteAgentTokenBudget,AgentBudgetRecovery,AgentBudgetRecoveryWorker} from '../dist/index.js';
const scope={tenantId:'tenant',agentId:'agent'},actor={tenantId:'tenant',principalId:'operator'},config={definitionVersion:1,maxAttempts:2,deadline:1000};
function setup(){const dir=mkdtempSync(join(tmpdir(),'budget-worker-')),path=join(dir,'runs.sqlite'),runs=new SqliteAgentRuns(path);let run=runs.create(scope,'run',config,0);run=runs.claim(scope,'run',run.revision,'worker',100,1);const budget=new SqliteAgentTokenBudget(path,{scope,runId:'run',leaseToken:run.leaseToken,maxTokens:100,clock:()=>2});return {dir,path,runs,budget,get run(){return run;},set run(value){run=value;}};}
function close(s){s.budget.close();s.runs.close();rmSync(s.dir,{recursive:true,force:true});}
const recovery=(s,verify,authorize=()=>true)=>new AgentBudgetRecovery({budget:s.budget,target:{scope,runId:'run',maxTokens:100},authorize,verify});
const worker=(s,service,options={})=>new AgentBudgetRecoveryWorker({runs:s.runs,recovery:service,scope,runId:'run',actor,reference:(_actor,_scope,_run,call)=>'case-'+call.callId,maxPerPass:1,pollMs:100,onError:()=>{},...options});
test('budget recovery worker scans bounded pages, keeps unknown usage and records evidence',async()=>{
 const s=setup();try{for(const call of ['a','b','c'])s.budget.reserve(call,20);let resolveA=false,seen=[];const service=recovery(s,(_actor,_target,call)=>{seen.push(call.callId);return call.callId==='a'&&!resolveA?undefined:{usedTokens:5};}),w=worker(s,service);assert.equal(await w.runOnce(),0);assert.deepEqual(seen,[]);s.run=s.runs.settle(scope,'run',s.run.revision,s.run.leaseToken,'uncertain',3);assert.equal(await w.runOnce(),0);assert.equal(await w.runOnce(),1);assert.equal(await w.runOnce(),1);assert.deepEqual(seen,['a','b','c']);assert.equal(s.budget.get('a').status,'reserved');assert.equal(s.budget.get('b').used,5);assert.deepEqual(s.budget.reconciliationHistory().map(row=>[row.callId,row.principalId,row.reference]),[['b','operator','case-b'],['c','operator','case-c']]);assert.throws(()=>s.runs.reconcile(scope,'run',s.run.revision,'retry',4),/Token usage/);resolveA=true;assert.equal(await w.runOnce(),1);assert.equal(s.runs.get(scope,'run').status,'uncertain');assert.equal(s.runs.reconcile(scope,'run',s.run.revision,'retry',4).status,'queued');
 }finally{close(s);}
});
test('stopping budget recovery fences a late verifier and permits a later pass',async()=>{
 const s=setup();let release;try{s.budget.reserve('a',20);s.run=s.runs.settle(scope,'run',s.run.revision,s.run.leaseToken,'uncertain',3);let entered,slow=true,signal;const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),service=recovery(s,async(_actor,_target,_call,_cost,_reference,received)=>{signal=received;if(slow){entered();await gate;}return {usedTokens:6};}),w=worker(s,service),pending=w.runOnce();await ready;assert.throws(()=>w.runOnce(),/already running/);await w.stop();assert.equal(await pending,0);assert.equal(signal.aborted,true);slow=false;release();await new Promise(resolve=>setImmediate(resolve));assert.equal(s.budget.get('a').status,'reserved');assert.deepEqual(s.budget.reconciliationHistory(),[]);assert.equal(await w.runOnce(),1);assert.equal(s.budget.get('a').used,6);
 }finally{release?.();close(s);}
});
test('stopping a worker fences late reference callbacks and does not run verification',async()=>{
 const s=setup();let release;try{s.budget.reserve('a',20);s.run=s.runs.settle(scope,'run',s.run.revision,s.run.leaseToken,'uncertain',3);let entered,verified=0,stopped=false;const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),service=recovery(s,()=>{verified++;return {usedTokens:1};}),w=worker(s,service,{reference:async()=>{entered();await gate;return 'case';}}),pending=w.runOnce();await ready;const stopping=w.stop().then(()=>{stopped=true;});await Promise.resolve();assert.equal(stopped,false);release();await stopping;assert.equal(await pending,0);assert.equal(verified,0);assert.equal(s.budget.get('a').status,'reserved');
 }finally{release?.();close(s);}
});
test('budget recovery worker isolates errors, snapshots settings and rejects wrong targets',async()=>{
 const s=setup();try{s.budget.reserve('a',20);s.budget.reserve('b',20);s.run=s.runs.settle(scope,'run',s.run.revision,s.run.leaseToken,'uncertain',3);const errors=[],service=recovery(s,()=>({usedTokens:4})),options={runs:s.runs,recovery:service,scope:{...scope},runId:'run',actor:{...actor},reference:(_actor,_scope,_run,call)=>call.callId==='a'?'bad reference':'case-b',maxPerPass:1,pollMs:100,onError:(_error,callId)=>errors.push(callId)},w=new AgentBudgetRecoveryWorker(options);options.scope.tenantId='other';options.actor.principalId='changed';options.reference=()=>{throw Error('replacement');};options.maxPerPass=99;assert.equal(await w.runOnce(),0);assert.deepEqual(errors,['a']);assert.equal(await w.runOnce(),1);assert.equal(s.budget.get('b').used,4);assert.throws(()=>new AgentBudgetRecoveryWorker({...options,scope,actor,runId:'other'}),/Invalid/);assert.throws(()=>new AgentBudgetRecoveryWorker({...options,scope,actor,runId:'run',maxPerPass:100}),/Invalid/);
 }finally{close(s);}
});


test('stopping while listing is authorized fences late policy results',async()=>{
 const s=setup();let release;try{s.budget.reserve('a',20);s.run=s.runs.settle(scope,'run',s.run.revision,s.run.leaseToken,'uncertain',3);let entered,references=0,received;const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),service=recovery(s,()=>({usedTokens:1}),async(_actor,_target,action,_call,signal)=>{if(action==='pending'){received=signal;entered();await gate;}return true;}),w=worker(s,service,{reference:()=>{references++;return 'case';}}),pending=w.runOnce();await ready;await w.stop();assert.equal(await pending,0);assert.equal(received.aborted,true);release();await new Promise(resolve=>setImmediate(resolve));assert.equal(references,0);assert.equal(s.budget.get('a').status,'reserved');
 }finally{release?.();close(s);}
});

test('polling budget recovery stops without starting another pass',async()=>{
 const s=setup();let release;try{s.budget.reserve('a',20);s.run=s.runs.settle(scope,'run',s.run.revision,s.run.leaseToken,'uncertain',3);let entered,calls=0;const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),service=recovery(s,async()=>{calls++;entered();await gate;return {usedTokens:3};}),w=worker(s,service);w.start();await ready;assert.throws(()=>w.start(),/already running/);await w.stop();release();await new Promise(resolve=>setTimeout(resolve,160));assert.equal(calls,1);assert.equal(s.budget.get('a').status,'reserved');
 }finally{release?.();close(s);}
});
