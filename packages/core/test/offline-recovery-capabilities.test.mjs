import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {CapabilityRegistry,createCapabilityServer,SqliteOfflineQueue,registerOfflineAbandonedRecoveryCapability,registerOfflineVerificationCapability} from '../dist/index.js';
const scope={tenantId:'tenant',applicationId:'app'},actor={tenantId:'tenant',principalId:'operator',origin:'ui'};
function setup(){const dir=mkdtempSync(join(tmpdir(),'offline-recovery-cap-')),path=join(dir,'db.sqlite'),queue=new SqliteOfflineQueue(path,{enabled:true,maxAttempts:2,retryDelayMs:0}),db=new DatabaseSync(path),events=[],registry=new CapabilityRegistry(event=>events.push(event.outcome));const item=queue.enqueue(scope,'owner','change','request',{private:'secret'});db.prepare("UPDATE offline_operations SET status='running',attempts=1 WHERE id=?").run(item.id);return {dir,queue,db,item,events,registry};}
function close(s){s.db.close();s.queue.close();rmSync(s.dir,{recursive:true,force:true});}
const candidate=id=>({operationId:id,method:'POST',path:'/recovery'});
const base={applicationId:'app',queuePrincipalId:'owner',targetOperationId:'change',authorize:actor=>actor.principalId==='operator',authorizeOperation:()=>true};

test('capabilities require confirmation, record evidence and recheck policy around verification',async()=>{
 const s=setup();let stopped=false,outcome='unknown',allowed=true;try{const options={...base,candidate:candidate('recover'),authorizeOperation:()=>allowed,verifyStopped:()=>stopped};registerOfflineAbandonedRecoveryCapability(s.registry,s.queue,options);registerOfflineVerificationCapability(s.registry,s.queue,{...base,candidate:candidate('verify'),authorizeOperation:()=>allowed,verify:()=>outcome});options.queuePrincipalId='other';options.verifyStopped=()=>true;
  const input={id:s.item.id,reference:'case'};assert.deepEqual(await s.registry.invoke('recover',input,actor),{recovered:false});assert.equal(s.queue.get(scope,'owner',s.item.id).status,'running');stopped=true;assert.deepEqual(await s.registry.invoke('recover',input,actor),{recovered:true});assert.deepEqual(await s.registry.invoke('verify',input,actor),{outcome:'unknown'});assert.equal(s.queue.get(scope,'owner',s.item.id).status,'uncertain');outcome='applied';assert.deepEqual(await s.registry.invoke('verify',input,actor),{outcome:'applied'});assert.equal(s.queue.get(scope,'owner',s.item.id).status,'succeeded');assert.deepEqual(s.queue.listRecoveryEvidence(scope,'owner',s.item.id).map(x=>[x.operatorId,x.reference,x.action]),[['operator','case','recover'],['operator','case','applied']]);assert.ok(s.events.includes('succeeded'));
  await assert.rejects(s.registry.invoke('recover',{...input,decision:'not_applied'},actor),/invalid/i);await assert.rejects(s.registry.invoke('recover',input,{...actor,principalId:'denied'}),/forbidden/i);await assert.rejects(s.registry.invoke('recover',input,{...actor,tenantId:'other'}),/not found/i);
 }finally{close(s);}
});

test('a late verifier cannot mutate the queue after policy revocation or deadline',async()=>{
 for(const mode of ['revoked','timeout']){const s=setup();let started,release,allowed=true,seen;const ready=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);try{s.queue.recoverAbandonedWithEvidence(scope,'owner',s.item.id,{operatorId:'operator',reference:'start'},1);registerOfflineVerificationCapability(s.registry,s.queue,{...base,candidate:candidate('verify'),authorizeOperation:()=>allowed,...(mode==='timeout'?{timeoutMs:100,maxPending:1}:{}),verify:async(_actor,_operation,signal)=>{seen=signal;started();await gate;return 'applied';}});const pending=s.registry.invoke('verify',{id:s.item.id,reference:'case'},actor);await ready;if(mode==='revoked'){allowed=false;release();await assert.rejects(pending,/forbidden/i);}else{await assert.rejects(pending,/unavailable/i);assert.equal(seen.aborted,true);release();await new Promise(resolve=>setTimeout(resolve,20));}assert.equal(s.queue.get(scope,'owner',s.item.id).status,'uncertain');assert.equal(s.queue.listRecoveryEvidence(scope,'owner',s.item.id).length,1);
 }finally{release?.();close(s);}}
});

test('HTTP recovery authenticates callers and does not accept client-supplied outcomes',async()=>{
 const s=setup();let server;try{registerOfflineAbandonedRecoveryCapability(s.registry,s.queue,{...base,candidate:candidate('recover'),verifyStopped:()=>true});server=createCapabilityServer(s.registry,req=>req.headers.authorization==='Bearer valid'?{tenantId:'tenant',principalId:'operator'}:undefined,()=>{});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const call=(body,token='valid')=>fetch(`http://127.0.0.1:${server.address().port}/capabilities/recover/invoke`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({origin:'ui',input:body})});assert.equal((await call({id:s.item.id,reference:'case'},'bad')).status,401);assert.equal((await call({id:s.item.id,reference:'case',outcome:'applied'})).status,400);const response=await call({id:s.item.id,reference:'case'});assert.equal(response.status,200);assert.deepEqual((await response.json()).result,{recovered:true});assert.equal(s.queue.get(scope,'owner',s.item.id).status,'uncertain');}finally{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}close(s);}
});
