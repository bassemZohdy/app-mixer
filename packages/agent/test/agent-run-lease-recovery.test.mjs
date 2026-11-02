import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SqliteAgentRuns,AgentRunLeaseRecoveryWorker} from '../dist/index.js';
const scope={tenantId:'tenant',agentId:'agent'},config={definitionVersion:1,maxAttempts:2,deadline:1000};
function claim(runs,id,target=scope,leaseMs=50){const run=runs.create(target,id,config,0);return runs.claim(target,id,run.revision,'worker',leaseMs,10,10);}
const worker=(runs,overrides={})=>new AgentRunLeaseRecoveryWorker({runs,scope,maxPerPass:2,pollMs:100,clock:()=>100,authorize:()=>true,onError:()=>{},...overrides});

test('expired lease discovery is bounded, scoped and excludes lease secrets',()=>{
 const runs=new SqliteAgentRuns(':memory:');try{
  const a=claim(runs,'a'),b=claim(runs,'b'),c=claim(runs,'c');runs.request(scope,'b',b.revision,'pause',11);runs.request(scope,'c',c.revision,'cancel',11);claim(runs,'future',scope,200);claim(runs,'outside',{...scope,tenantId:'other'});runs.create(scope,'queued',config,0);
  const first=runs.expiredLeasePage(scope,100,{limit:1}),second=runs.expiredLeasePage(scope,100,{limit:2,after:first.next});assert.deepEqual(first.items,[{runId:'a',revision:a.revision,status:'running',leaseUntil:60}]);assert.deepEqual(second.items.map(x=>[x.runId,x.status]),[['b','pause_requested'],['c','cancel_requested']]);assert.equal(second.next,undefined);assert.doesNotMatch(JSON.stringify([first,second]),/leaseToken|leaseOwner|worker/);assert.deepEqual(runs.expiredLeasePage(scope,59).items,[]);
  for(const query of [{limit:0},{limit:101},{after:{leaseUntil:-1,runId:'a'}},{after:{leaseUntil:0,runId:'bad id'}}])assert.throws(()=>runs.expiredLeasePage(scope,100,query),/Invalid expired lease query/);
 }finally{runs.close();}
});

test('lease recovery respects policy, fences renewed leases and never replays a run',async()=>{
 const runs=new SqliteAgentRuns(':memory:'),errors=[];try{
  const a=claim(runs,'a'),b=claim(runs,'b'),c=claim(runs,'c');claim(runs,'outside',{...scope,tenantId:'other'});let deny=true,renew=true;
  const w=worker(runs,{maxPerPass:1,onError:(e,id)=>errors.push([e.message,id]),authorize:lease=>{assert.equal(Object.hasOwn(lease,'leaseToken'),false);if(lease.runId==='a'&&renew){renew=false;runs.renew(scope,'a',a.revision,a.leaseToken,200,59);lease.runId='c';return true;}if(lease.runId==='b'&&deny)return false;return true;}});
  assert.equal(await w.runOnce(),0);assert.equal(runs.get(scope,'a').status,'running');assert.equal(await w.runOnce(),0);assert.equal(runs.get(scope,'b').status,'running');assert.equal(await w.runOnce(),1);assert.equal(runs.get(scope,'c').status,'uncertain');assert.equal(runs.get(scope,'c').leaseToken,null);deny=false;assert.equal(await w.runOnce(),1);assert.equal(runs.get(scope,'b').status,'uncertain');assert.equal(runs.get(scope,'a').status,'running');assert.equal(runs.get({...scope,tenantId:'other'},'outside').status,'running');assert.equal(runs.get(scope,'c').attempts,c.attempts);assert.equal(await w.runOnce(),0);assert.deepEqual(errors,[]);assert.equal(runs.get(scope,'b').attempts,b.attempts);
 }finally{runs.close();}
});

test('bounded authorization stops safely, fences late decisions and retains capacity',async()=>{
 const runs=new SqliteAgentRuns(':memory:');let release,entered,signal,block=true;const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>entered=resolve),errors=[];try{
  claim(runs,'a');const w=worker(runs,{authorizationTimeoutMs:100,maxPendingAuthorizations:1,onError:(error,id)=>errors.push([error.message,id]),authorize:async(_lease,provided)=>{if(block){signal=provided;entered();await gate;}return true;}}),pending=w.runOnce();await ready;assert.equal(await pending,0);assert.equal(signal.aborted,true);assert.equal(runs.get(scope,'a').status,'running');assert.equal(await w.runOnce(),0);assert.equal(errors.length,2);block=false;release();await new Promise(resolve=>setImmediate(resolve));assert.equal(runs.get(scope,'a').status,'running');assert.equal(await w.runOnce(),1);assert.equal(runs.get(scope,'a').status,'uncertain');
 }finally{release();runs.close();}
});

test('stopping a bounded recovery pass aborts authorization and preserves the lease',async()=>{
 const runs=new SqliteAgentRuns(':memory:');let release,entered,signal,block=true;const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>entered=resolve);try{
  claim(runs,'a');const w=worker(runs,{authorizationTimeoutMs:1000,maxPendingAuthorizations:1,authorize:async(_lease,provided)=>{if(block){signal=provided;entered();await gate;}return true;}}),pending=w.runOnce();await ready;await w.stop();assert.equal(await pending,0);assert.equal(signal.aborted,true);assert.equal(runs.get(scope,'a').status,'running');block=false;release();await new Promise(resolve=>setImmediate(resolve));assert.equal(await w.runOnce(),1);assert.equal(runs.get(scope,'a').status,'uncertain');
 }finally{release();runs.close();}
});

test('lease recovery requires paired authorization limits',()=>{const runs=new SqliteAgentRuns(':memory:');try{for(const limits of [{authorizationTimeoutMs:100},{maxPendingAuthorizations:1},{authorizationTimeoutMs:99,maxPendingAuthorizations:1},{authorizationTimeoutMs:100,maxPendingAuthorizations:101}])assert.throws(()=>worker(runs,limits),/Invalid lease recovery worker/);}finally{runs.close();}});


test('lease recovery rechecks authorization and fences revoked or stopped decisions',async()=>{
 const runs=new SqliteAgentRuns(':memory:');let calls=0;try{claim(runs,'a');const w=worker(runs,{authorize:()=>++calls===1});assert.equal(await w.runOnce(),0);assert.equal(calls,2);assert.equal(runs.get(scope,'a').status,'running');const allowed=worker(runs);assert.equal(await allowed.runOnce(),1);assert.equal(runs.get(scope,'a').status,'uncertain');}finally{runs.close();}
});

test('uncertain recovery persists across reopening and requires explicit reconciliation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'lease-recovery-')),path=join(dir,'runs.sqlite');let runs=new SqliteAgentRuns(path);try{
  const a=claim(runs,'a');claim(runs,'outside',{...scope,tenantId:'other'});const w=worker(runs);assert.equal(await w.runOnce(),1);await w.stop();runs.close();runs=new SqliteAgentRuns(path);const recovered=runs.get(scope,'a');assert.equal(recovered.status,'uncertain');assert.equal(recovered.leaseToken,null);assert.equal(recovered.attempts,a.attempts);assert.deepEqual(runs.expiredLeasePage(scope,100).items,[]);assert.equal(runs.get({...scope,tenantId:'other'},'outside').status,'running');assert.equal(runs.reconcile(scope,'a',recovered.revision,'retry',100).status,'queued');
 }finally{runs.close();rmSync(dir,{recursive:true,force:true});}
});
