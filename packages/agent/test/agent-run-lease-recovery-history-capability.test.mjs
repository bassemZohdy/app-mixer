import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CapabilityRegistry,createCapabilityServer} from '../../core/dist/index.js';
import {SqliteAgentRuns,SqliteAgentLeaseRecoveryHistory,registerAgentLeaseRecoveryHistory} from '../dist/index.js';
const scope={tenantId:'tenant',agentId:'agent'},actor={tenantId:'tenant',principalId:'auditor'},context={...actor,origin:'ui'},conf={definitionVersion:1,maxAttempts:2,deadline:1000};
function setup(){const dir=mkdtempSync(join(tmpdir(),'lease-history-capability-')),path=join(dir,'db.sqlite'),runs=new SqliteAgentRuns(path);for(const target of [scope,{...scope,tenantId:'other'}]){const queued=runs.create(target,'run',conf,0),running=runs.claim(target,'run',queued.revision,'worker',50,10);runs.recoverExpired(target,'run',running.revision,100,{principalId:'operator',reference:'case'});}return {dir,path,runs};}
function close(s){s.runs.close();rmSync(s.dir,{recursive:true,force:true});}

test('lease recovery history capability is authenticated, scoped and independently authorized',async()=>{
 const s=setup(),registry=new CapabilityRegistry(()=>{});let history,server,allow=true,read=true;try{
  history=new SqliteAgentLeaseRecoveryHistory(s.path,{scope,authorize:()=>read});registerAgentLeaseRecoveryHistory(registry,{history,scope,operationId:'lease-history',path:'/lease-history',limit:1,authorize:()=>allow});server=createCapabilityServer(registry,req=>req.headers.authorization==='Bearer valid'?actor:req.headers.authorization==='Bearer other'?{...actor,tenantId:'other'}:undefined,()=>{});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}/capabilities/lease-history/invoke`,call=(token,input={query:{}})=>fetch(url,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:JSON.stringify({origin:'ui',input})});
  assert.equal((await call()).status,401);assert.equal((await call('other')).status,403);assert.equal((await call('valid',{query:{after:-1}})).status,400);const response=await call('valid');assert.equal(response.status,200);const data=await response.json();assert.equal(data.result.items.length,1);assert.equal(data.result.items[0].principalId,'operator');assert.equal(data.result.items[0].reference,'case');assert.doesNotMatch(JSON.stringify(data),/leaseToken|leaseOwner|other/);allow=false;assert.equal((await call('valid')).status,403);allow=true;read=false;assert.equal((await call('valid')).status,403);
  assert.throws(()=>registerAgentLeaseRecoveryHistory(new CapabilityRegistry(()=>{}),{history,scope:{...scope,agentId:'wrong'},operationId:'other',path:'/other',limit:1,authorize:()=>true}),/Invalid lease recovery history capability/);
 }finally{if(server?.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}history?.close();close(s);}
});

test('lease history capability bounds policy and history callbacks and fences late results',async()=>{
 const s=setup(),registry=new CapabilityRegistry(()=>{});let history,server,entered,release,seen,blocked=true;const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);try{
  history=new SqliteAgentLeaseRecoveryHistory(s.path,{scope,authorize:()=>true,authorizeWithSignal:async(_actor,_action,_event,signal)=>{if(blocked){seen=signal;entered();await gate;}return true;}});registerAgentLeaseRecoveryHistory(registry,{history,scope,operationId:'lease-history',path:'/lease-history',limit:10,authorize:()=>true,timeoutMs:100,maxPending:1});server=createCapabilityServer(registry,()=>actor,()=>{});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}/capabilities/lease-history/invoke`,call=()=>fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({origin:'ui',input:{query:{}}})});const first=call();await ready;assert.equal((await first).status,503);assert.equal(seen.aborted,true);assert.equal((await call()).status,503);blocked=false;release();await new Promise(resolve=>setImmediate(resolve));assert.equal((await call()).status,200);
 }finally{release();if(server?.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}history?.close();close(s);}
});

test('lease history capability preserves per-record filtering and scope-local pagination',async()=>{
 const s=setup(),registry=new CapabilityRegistry(()=>{});let history;try{
  const second=s.runs.create(scope,'run2',conf,0),claimed=s.runs.claim(scope,'run2',second.revision,'worker',50,10);s.runs.recoverExpired(scope,'run2',claimed.revision,100,{principalId:'operator',reference:'hidden'});history=new SqliteAgentLeaseRecoveryHistory(s.path,{scope,authorize:(_actor,action,event)=>action==='list'||event.reference!=='hidden'});const options={history,scope:{...scope},operationId:'lease-history',path:'/history',limit:1,authorize:()=>true};registerAgentLeaseRecoveryHistory(registry,options);options.scope.tenantId='other';options.limit=99;const first=await registry.invoke('lease-history',{query:{}},context);assert.equal(first.items.length,1);assert.equal(first.nextAfter,1);const secondPage=await registry.invoke('lease-history',{query:{after:first.nextAfter}},context);assert.deepEqual(secondPage.items,[]);assert.doesNotMatch(JSON.stringify(secondPage),/hidden|run2/);
 }finally{history?.close();close(s);}
});

test('lease history capability bounds a stalled outer authorization policy',async()=>{
 const s=setup(),registry=new CapabilityRegistry(()=>{});let history,entered,release,signal,block=true;const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);try{
  history=new SqliteAgentLeaseRecoveryHistory(s.path,{scope,authorize:()=>true});registerAgentLeaseRecoveryHistory(registry,{history,scope,operationId:'lease-history',path:'/history',limit:1,timeoutMs:100,maxPending:1,authorize:async(_actor,provided)=>{if(block){signal=provided;entered();await gate;}return true;}});const pending=registry.invoke('lease-history',{query:{}},context);await ready;await assert.rejects(pending,/unavailable/);assert.equal(signal.aborted,true);await assert.rejects(registry.invoke('lease-history',{query:{}},context),/unavailable/);block=false;release();await new Promise(resolve=>setImmediate(resolve));assert.equal((await registry.invoke('lease-history',{query:{}},context)).items.length,1);
 }finally{release();history?.close();close(s);}
});
