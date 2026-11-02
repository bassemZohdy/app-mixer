import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {SqliteOfflineQueue,OfflineRetentionWorker} from '../dist/index.js';
const scope={tenantId:'tenant',applicationId:'app'},proof={operatorId:'retention-service',reference:'policy-30d'};
function setup(){const dir=mkdtempSync(join(tmpdir(),'offline-retention-')),path=join(dir,'db.sqlite'),queue=new SqliteOfflineQueue(path,{enabled:true,maxAttempts:2,retryDelayMs:0}),db=new DatabaseSync(path);return {dir,queue,db};}
function done(s,key,time,where=scope,owner='owner',operation='change'){const item=s.queue.enqueue(where,owner,operation,key,{private:key});s.queue.discard(where,owner,item.id);if(time===undefined)s.db.prepare('DELETE FROM offline_terminal_times WHERE tenant_id=? AND application_id=? AND principal_id=? AND id=?').run(where.tenantId,where.applicationId,owner,item.id);else s.db.prepare('UPDATE offline_terminal_times SET completed_at=? WHERE tenant_id=? AND application_id=? AND principal_id=? AND id=?').run(time,where.tenantId,where.applicationId,owner,item.id);return item;}
function options(s,extra={}){return {queue:s.queue,scope,queuePrincipalId:'owner',operationId:'change',operatorId:proof.operatorId,reference:proof.reference,minAgeMs:200,maxPerPass:1,pollMs:100,authorize:()=>true,onError:()=>{},now:()=>1000,...extra};}
function close(s){s.db.close();s.queue.close();rmSync(s.dir,{recursive:true,force:true});}

test('retention scans fairly, rechecks policy and excludes young, unknown and foreign records',async()=>{
 const s=setup();try{const a=done(s,'a',500),b=done(s,'b',600),denied=[a.id,b.id].sort()[0],young=done(s,'young',800),unknown=done(s,'unknown',undefined),other=done(s,'other',500,{tenantId:'other',applicationId:'app'}),otherOwner=done(s,'owner',500,scope,'other'),otherOp=done(s,'operation',500,scope,'owner','other'),pending=s.queue.enqueue(scope,'owner','change','pending',{}),seen=[];const config=options(s,{authorize:(actor,selection,operation,signal)=>{assert.deepEqual(actor,{tenantId:'tenant',principalId:'retention-service'});assert.deepEqual(selection,scope);assert.equal(signal.aborted,false);seen.push(operation.id);return operation.id!==denied;}}),worker=new OfflineRetentionWorker(config);config.operationId='other';config.scope={tenantId:'other',applicationId:'app'};config.reference='changed';
  assert.equal(await worker.runOnce(),0);assert.equal(await worker.runOnce(),1);const kept=[a,b].find(x=>x.id!==denied),archived=s.queue.getArchived(scope,'owner',kept.id);assert.equal(archived.reference,proof.reference);assert.equal(archived.operatorId,proof.operatorId);assert.equal(archived.recordedAt,1000);assert.equal(s.queue.get(scope,'owner',denied).status,'discarded');assert.ok(seen.filter(x=>x===kept.id).length===2);for(const [where,owner,item] of [[scope,'owner',young],[scope,'owner',unknown],[{tenantId:'other',applicationId:'app'},'owner',other],[scope,'other',otherOwner],[scope,'owner',otherOp],[scope,'owner',pending]])assert.ok(s.queue.get(where,owner,item.id));
 }finally{close(s);}
});

test('stop aborts in-flight policy and prevents both manual and polling passes from retiring',async()=>{
 for(const polling of [false,true]){const s=setup();let started,release,signal;const ready=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);try{const item=done(s,'one',500),worker=new OfflineRetentionWorker(options(s,{authorize:async(_actor,_scope,_item,passed)=>{signal=passed;started();await gate;return true;}}));let pending;if(polling)worker.start();else pending=worker.runOnce();await ready;assert.throws(()=>worker.runOnce(),/already running/);const stopping=worker.stop();assert.equal(signal.aborted,true);release();await stopping;if(pending)assert.equal(await pending,0);assert.equal(s.queue.get(scope,'owner',item.id).status,'discarded');assert.equal(s.queue.getArchived(scope,'owner',item.id),undefined);}finally{release?.();close(s);}}
});

test('retention rechecks changed claims and permission before retiring',async()=>{
 for(const mode of ['stale','revoked']){const s=setup(),errors=[];let calls=0,allowed=true;try{const item=done(s,'one',500),worker=new OfflineRetentionWorker(options(s,{onError:error=>errors.push(error),authorize:()=>{if(++calls===2){if(mode==='stale')s.db.prepare('UPDATE offline_terminal_times SET completed_at=900 WHERE id=?').run(item.id);else allowed=false;}return allowed;}}));assert.equal(await worker.runOnce(),0);assert.equal(s.queue.get(scope,'owner',item.id).status,'discarded');assert.equal(s.queue.getArchived(scope,'owner',item.id),undefined);assert.equal(errors.length,mode==='stale'?1:0);}finally{close(s);}}
});

test('retention worker validates bounds and clock',async()=>{const s=setup();try{for(const bad of [{minAgeMs:-1},{maxPerPass:0},{pollMs:1},{authorize:null},{now:3},{policyTimeoutMs:100},{policyTimeoutMs:99,maxPendingPolicies:1},{policyTimeoutMs:100,maxPendingPolicies:0}])assert.throws(()=>new OfflineRetentionWorker(options(s,bad)),/worker/);const worker=new OfflineRetentionWorker(options(s,{now:()=>NaN}));await assert.rejects(worker.runOnce(),/time/);}finally{close(s);}});


test('retention fences reentrant passes and stopping before a pass starts',async()=>{
 const s=setup();try{const item=done(s,'one',500);let worker,checks=0;worker=new OfflineRetentionWorker(options(s,{authorize:()=>{checks++;assert.throws(()=>worker.runOnce(),/already running/);return true;}}));assert.equal(await worker.runOnce(),1);assert.equal(checks,2);assert.equal(s.queue.getArchived(scope,'owner',item.id).status,'discarded');let clockCalls=0;const stopped=new OfflineRetentionWorker(options(s,{now:()=>{clockCalls++;return 1000;}})),pending=stopped.runOnce();await stopped.stop();assert.equal(await pending,0);assert.equal(clockCalls,0);}finally{close(s);}
});


test('started retention worker polls bounded pages until stopped',async()=>{
 const s=setup();let worker;try{const a=done(s,'a',500),b=done(s,'b',500);worker=new OfflineRetentionWorker(options(s));worker.start();const deadline=Date.now()+3000;while(!s.queue.getArchived(scope,'owner',a.id)||!s.queue.getArchived(scope,'owner',b.id)){if(Date.now()>deadline)throw Error('retention polling timed out');await new Promise(resolve=>setTimeout(resolve,20));}await worker.stop();assert.equal(s.queue.list(scope,'owner').length,0);}finally{await worker?.stop();close(s);}
});


test('policy deadlines fence late results and bound outstanding checks',async()=>{
 const s=setup(),errors=[];let started,release,seen,calls=0;const ready=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);try{const item=done(s,'one',500),worker=new OfflineRetentionWorker(options(s,{policyTimeoutMs:100,maxPendingPolicies:1,onError:error=>errors.push(error),authorize:async(_actor,_scope,_operation,signal)=>{calls++;if(calls===1){seen=signal;started();await gate;}return true;}}));const pending=worker.runOnce();await ready;assert.equal(await pending,0);assert.equal(seen.aborted,true);assert.equal(s.queue.get(scope,'owner',item.id).status,'discarded');assert.equal(await worker.runOnce(),0);assert.equal(calls,1);assert.equal(errors.length,2);release();await new Promise(resolve=>setTimeout(resolve,20));assert.equal(s.queue.getArchived(scope,'owner',item.id),undefined);assert.equal(await worker.runOnce(),1);assert.equal(calls,3);assert.equal(s.queue.getArchived(scope,'owner',item.id).reference,proof.reference);}finally{release?.();close(s);}
});

test('configured policy deadlines bound stop when a callback ignores cancellation',async()=>{
 const s=setup();let started,release,signal;const ready=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);try{const item=done(s,'one',500),worker=new OfflineRetentionWorker(options(s,{policyTimeoutMs:100,maxPendingPolicies:1,authorize:async(_actor,_scope,_operation,passed)=>{signal=passed;started();await gate;return true;}})),pending=worker.runOnce();await ready;await worker.stop();assert.equal(signal.aborted,true);assert.equal(await pending,0);assert.equal(s.queue.get(scope,'owner',item.id).status,'discarded');release();await new Promise(resolve=>setTimeout(resolve,20));assert.equal(s.queue.getArchived(scope,'owner',item.id),undefined);}finally{release?.();close(s);}
});
