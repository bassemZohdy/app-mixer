import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {SqliteAgentRuns,AgentRunLeaseRecoveryWorker,SqliteAgentLeaseRecoveryHistory,AgentLeaseRecoveryMetrics} from '../dist/index.js';
const scope={tenantId:'tenant',agentId:'agent'},config={definitionVersion:1,maxAttempts:2,deadline:1000};
function claim(runs,id,target=scope,leaseMs=50){const run=runs.create(target,id,config,0);return runs.claim(target,id,run.revision,'worker',leaseMs,10,10);}
const worker=(runs,overrides={})=>new AgentRunLeaseRecoveryWorker({runs,scope,maxPerPass:2,pollMs:100,clock:()=>100,authorize:()=>true,onError:()=>{},...overrides});

test('lease recovery metrics count passes without exposing run identities and recheck access',async()=>{
 const runs=new SqliteAgentRuns(':memory:'),actor={tenantId:'tenant',principalId:'auditor'};let checks=0,allowed=true;try{
  claim(runs,'recovered-secret');claim(runs,'denied-secret');claim(runs,'error-secret');const metrics=new AgentLeaseRecoveryMetrics({authorize:()=>{checks++;return allowed;}}),w=worker(runs,{maxPerPass:3,observe:metrics.observe,authorize:lease=>{if(lease.runId==='denied-secret')return false;if(lease.runId==='error-secret')throw Error('unavailable');return true;}});
  assert.equal(await w.runOnce(),1);const output=await metrics.render(actor);assert.match(output,/app_mixer_agent_lease_recovery_passes_total\{outcome="completed"\} 1/);assert.match(output,/app_mixer_agent_lease_recovery_recovered_total 1/);assert.match(output,/app_mixer_agent_lease_recovery_skipped_total\{reason="denied"\} 1/);assert.match(output,/app_mixer_agent_lease_recovery_skipped_total\{reason="error"\} 1/);assert.doesNotMatch(output,/secret|tenant|auditor/);assert.equal(checks,2);allowed=false;await assert.rejects(metrics.render(actor),/access denied/);
  const revoked=new AgentLeaseRecoveryMetrics({authorize:()=>++checks%2===0});checks=1;await assert.rejects(revoked.render(actor),/access denied/);await assert.rejects(metrics.renderWithSignal(actor,AbortSignal.abort()),/unavailable/);assert.throws(()=>metrics.observe({outcome:'completed',recovered:101,denied:0,errors:0,durationMs:1}),/Invalid/);
 }finally{runs.close();}
});

test('lease recovery observes stopped and failed passes without allowing observer failures to affect work',async()=>{
 const runs=new SqliteAgentRuns(':memory:'),observations=[];let release,entered;const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>entered=resolve);try{
  claim(runs,'a');const stopped=worker(runs,{authorizationTimeoutMs:1000,maxPendingAuthorizations:1,authorize:async()=>{entered();await gate;return true;},observe:value=>observations.push(value)}),pending=stopped.runOnce();await ready;await stopped.stop();assert.equal(await pending,0);assert.equal(observations[0].outcome,'stopped');assert.equal(runs.get(scope,'a').status,'running');release();await new Promise(resolve=>setImmediate(resolve));
  const failing=worker(runs,{clock:()=>-1,observe:value=>observations.push(value)});await assert.rejects(failing.runOnce());assert.equal(observations[1].outcome,'failed');const throwing=worker(runs,{observe:()=>{throw Error('observer unavailable');}});assert.equal(await throwing.runOnce(),1);assert.equal(runs.get(scope,'a').status,'uncertain');
 }finally{release();runs.close();}
});

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


test('lease recovery evidence commits atomically, remains scoped and rechecks access',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'lease-recovery-audit-')),path=join(dir,'runs.sqlite');let runs=new SqliteAgentRuns(path),history,foreign,db;try{
  const a=claim(runs,'a');claim(runs,'b');const other={...scope,tenantId:'other'},outside=claim(runs,'outside',other);runs.recoverExpired(scope,'a',a.revision,100,{principalId:'operator',reference:'ticket-1'});runs.recoverExpired(other,'outside',outside.revision,100,{principalId:'foreign',reference:'ticket-2'});
  const opts={evidence:{principalId:'worker',reference:'batch-1'}},w=worker(runs,opts);opts.evidence.principalId='changed';assert.equal(await w.runOnce(),1);assert.equal(runs.get(scope,'b').status,'uncertain');runs.close();runs=new SqliteAgentRuns(path);
  const actor={tenantId:'tenant',principalId:'auditor'};history=new SqliteAgentLeaseRecoveryHistory(path,{scope,authorize:()=>true});const first=await history.list(actor,{limit:1}),second=await history.list(actor,{limit:1,after:first.nextAfter});assert.deepEqual(first.items.map(x=>[x.runId,x.previousStatus,x.leaseUntil,x.principalId,x.reference,x.observedAt]),[['a','running',60,'operator','ticket-1',100]]);assert.deepEqual(second.items.map(x=>[x.runId,x.principalId,x.reference]),[['b','worker','batch-1']]);assert.equal(first.items[0].id,1);assert.equal(second.items[0].id,2);await assert.rejects(history.list({...actor,tenantId:'other'}),/actor/);
  foreign=new SqliteAgentLeaseRecoveryHistory(path,{scope:other,authorize:()=>true});assert.deepEqual((await foreign.list({...actor,tenantId:'other'})).items.map(x=>x.runId),['outside']);assert.equal((await foreign.list({...actor,tenantId:'other'})).items[0].id,1);
  db=new DatabaseSync(path);assert.throws(()=>db.exec("UPDATE agent_run_lease_recovery_audit SET reference='changed'"),/immutable/);assert.throws(()=>db.exec('DELETE FROM agent_run_lease_recovery_audit'),/immutable/);assert.throws(()=>db.exec("INSERT OR REPLACE INTO agent_run_lease_recovery_audit SELECT * FROM agent_run_lease_recovery_audit WHERE run_id='a'"),/immutable/);db.close();db=undefined;
  history.close();let reads=0;history=new SqliteAgentLeaseRecoveryHistory(path,{scope,authorize:(_actor,action)=>action==='list'||++reads===1});await assert.rejects(history.list(actor,{limit:1}),/access denied/);
 }finally{db?.close();history?.close();foreign?.close();runs.close();rmSync(dir,{recursive:true,force:true});}
});

test('failed lease recovery audit leaves the run unchanged',()=>{
 const dir=mkdtempSync(join(tmpdir(),'lease-recovery-audit-fail-')),path=join(dir,'runs.sqlite'),runs=new SqliteAgentRuns(path),db=new DatabaseSync(path);try{const run=claim(runs,'a');assert.throws(()=>runs.recoverExpired(scope,'a',run.revision,100,{principalId:'',reference:'case'}),/evidence/);db.exec("CREATE TRIGGER test_lease_audit_fail BEFORE INSERT ON agent_run_lease_recovery_audit BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");assert.throws(()=>runs.recoverExpired(scope,'a',run.revision,100,{principalId:'operator',reference:'case'}),/audit unavailable/);const current=runs.get(scope,'a');assert.equal(current.status,'running');assert.equal(current.revision,run.revision);assert.equal(current.leaseToken,run.leaseToken);db.exec('DROP TRIGGER test_lease_audit_fail');assert.equal(runs.recoverExpired(scope,'a',run.revision,100,{principalId:'operator',reference:'case'}).status,'uncertain');}finally{db.close();runs.close();rmSync(dir,{recursive:true,force:true});}
});

test('bounded history authorization aborts, fences late decisions and retains capacity',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'lease-history-timeout-')),path=join(dir,'db.sqlite'),runs=new SqliteAgentRuns(path);let history,release,entered,seen,block=true;const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>entered=resolve),actor={tenantId:'tenant',principalId:'auditor'};
 try{const run=claim(runs,'a');runs.recoverExpired(scope,'a',run.revision,100,{principalId:'operator',reference:'case'});history=new SqliteAgentLeaseRecoveryHistory(path,{scope,authorizationTimeoutMs:100,maxPendingAuthorizations:1,authorize:()=>{throw Error('legacy policy must not run');},authorizeWithSignal:async(_actor,_action,_event,signal)=>{if(block){seen=signal;entered();await gate;}return true;}});const pending=history.list(actor);await ready;await assert.rejects(pending,/unavailable/);assert.equal(seen.aborted,true);await assert.rejects(history.list(actor),/unavailable/);block=false;release();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual((await history.list(actor)).items.map(x=>x.runId),['a']);
 }finally{release();history?.close();runs.close();rmSync(dir,{recursive:true,force:true});}
});

test('cancelled history authorization cannot return partial results',async()=>{
 for(const phase of [2,4]){
  const dir=mkdtempSync(join(tmpdir(),'lease-history-cancel-')),path=join(dir,'db.sqlite'),runs=new SqliteAgentRuns(path);let history,release,entered,seen,calls=0;const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>entered=resolve),controller=new AbortController();
  try{const run=claim(runs,'a');runs.recoverExpired(scope,'a',run.revision,100,{principalId:'operator',reference:'case'});history=new SqliteAgentLeaseRecoveryHistory(path,{scope,authorizationTimeoutMs:1000,maxPendingAuthorizations:1,authorize:()=>true,authorizeWithSignal:async(_actor,_action,_event,signal)=>{if(++calls===phase){seen=signal;entered();await gate;}return true;}});const pending=history.listWithSignal({tenantId:'tenant',principalId:'auditor'},{},controller.signal);await ready;controller.abort();await assert.rejects(pending,/unavailable/);assert.equal(seen.aborted,true);release();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,phase);await assert.rejects(history.listWithSignal({tenantId:'tenant',principalId:'auditor'},{},AbortSignal.abort()),/unavailable/);
  }finally{release();history?.close();runs.close();rmSync(dir,{recursive:true,force:true});}
 }
});

test('history policy bounds must be paired and valid',()=>{
 const dir=mkdtempSync(join(tmpdir(),'lease-history-options-')),path=join(dir,'db.sqlite'),runs=new SqliteAgentRuns(path);try{const options={scope,authorize:()=>true};for(const limits of [{authorizationTimeoutMs:100},{maxPendingAuthorizations:1},{authorizationTimeoutMs:99,maxPendingAuthorizations:1},{authorizationTimeoutMs:100,maxPendingAuthorizations:101},{authorizeWithSignal:true}])assert.throws(()=>new SqliteAgentLeaseRecoveryHistory(path,{...options,...limits}),/Invalid lease recovery history/);}finally{runs.close();rmSync(dir,{recursive:true,force:true});}
});
