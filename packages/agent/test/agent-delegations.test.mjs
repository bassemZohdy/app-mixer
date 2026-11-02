import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {SqliteAgentRuns,SqliteAgentDelegations} from '../dist/index.js';
const scope={tenantId:'tenant',agentId:'agent'},admin={tenantId:'tenant',principalId:'admin'},worker={tenantId:'tenant',principalId:'worker'},grant={...scope,runId:'run',grantId:'grant',principalId:'user',permissionVersion:'v1',expiresAt:50};
function setup(authorize=(actor,action)=>actor.principalId==='admin'||(actor.principalId==='worker'&&action==='verify')){const dir=mkdtempSync(join(tmpdir(),'delegation-')),path=join(dir,'runs.sqlite'),runs=new SqliteAgentRuns(path);runs.create(scope,'run',{definitionVersion:1,maxAttempts:3,deadline:1000},0);let now=10;const options={scope,runId:'run',authorize,clock:()=>now},store=new SqliteAgentDelegations(path,options);return {dir,path,runs,store,options,set now(value){now=value}};}
function close(s){s.store.close();s.runs.close();rmSync(s.dir,{recursive:true,force:true});}

test('grants survive restart, expire, renew, revoke and retain immutable audit history',async()=>{const s=setup();let reopened,db;try{
 const issued=await s.store.issue(admin,grant);assert.equal(issued.revision,1);assert.equal(await s.store.verify(worker,issued.grant),true);await assert.rejects(s.store.get(worker,'grant'),/denied/);await assert.rejects(s.store.verify({tenantId:'other',principalId:'worker'},issued.grant),/actor/);
 s.now=50;assert.equal(await s.store.verify(worker,issued.grant),false);const renewed=await s.store.renew(admin,'grant',1,'v2',100);assert.equal(renewed.grant.principalId,'user');assert.equal(await s.store.verify(worker,issued.grant),false);assert.equal(await s.store.verify(worker,renewed.grant),true);
 reopened=new SqliteAgentDelegations(s.path,s.options);assert.deepEqual(await reopened.get(admin,'grant'),renewed);const revoked=await reopened.revoke(admin,'grant',2);assert.equal(revoked.revoked,true);assert.equal(await s.store.verify(worker,renewed.grant),false);await assert.rejects(s.store.renew(admin,'grant',3,'v3',120),/revoked/);assert.deepEqual((await s.store.history(admin,'grant')).map(e=>e.event),['issued','renewed','revoked']);db=new DatabaseSync(s.path);assert.throws(()=>db.exec('DELETE FROM agent_delegation_events'),/immutable/);assert.throws(()=>db.exec('UPDATE agent_delegation_events SET event=\'x\''),/immutable/);
 }finally{db?.close();reopened?.close();close(s);}});

test('scope, deadline, revocation races and stale revisions fail closed',async()=>{let release,started;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);let block=false;const s=setup(async(actor,action)=>{if(block&&action==='verify'){started();await gate;}return actor.principalId==='admin'||actor.principalId==='worker'&&action==='verify'});try{
 await assert.rejects(s.store.issue(admin,{...grant,tenantId:'other'}),/Invalid delegation/);await assert.rejects(s.store.issue(admin,{...grant,expiresAt:1001}),/expiry/);const issued=await s.store.issue(admin,grant);await assert.rejects(s.store.issue(admin,grant),/already exists/);
 const results=await Promise.allSettled([s.store.renew(admin,'grant',1,'v2',100),s.store.renew(admin,'grant',1,'v3',100)]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);const renewed=await s.store.get(admin,'grant');assert.equal(await s.store.verify(worker,issued.grant),false);block=true;const pending=s.store.verify(worker,renewed.grant);await ready;await s.store.revoke(admin,'grant',2);release();assert.equal(await pending,false);
 }finally{close(s);}});

test('renewal cannot reactivate an earlier identical grant snapshot',async()=>{const s=setup();try{const first=await s.store.issue(admin,grant);await s.store.renew(admin,'grant',1,'v2',60);const third=await s.store.renew(admin,'grant',2,'v1',50);assert.equal(await s.store.verify(worker,first.grant),false);assert.equal(await s.store.verify(worker,third.grant),true);assert.equal(await s.store.verify(worker,{...third.grant,revision:undefined}),false);}finally{close(s);}});

test('maximum delegation revision blocks renewal but remains revocable',async()=>{
 const s=setup();let db;try{
  await s.store.issue(admin,grant);db=new DatabaseSync(s.path);db.prepare('UPDATE agent_delegations SET revision=? WHERE grant_id=?').run(Number.MAX_SAFE_INTEGER-1,'grant');
  const last=await s.store.renew(admin,'grant',Number.MAX_SAFE_INTEGER-1,'v2',100);assert.equal(last.revision,Number.MAX_SAFE_INTEGER);assert.equal(await s.store.verify(worker,last.grant),true);
  await assert.rejects(s.store.renew(admin,'grant',Number.MAX_SAFE_INTEGER,'v3',120),/revision|Invalid/);assert.equal((await s.store.get(admin,'grant')).revision,Number.MAX_SAFE_INTEGER);
  const revoked=await s.store.revoke(admin,'grant',Number.MAX_SAFE_INTEGER);assert.equal(revoked.revision,Number.MAX_SAFE_INTEGER);assert.equal(revoked.revoked,true);assert.equal(await s.store.verify(worker,last.grant),false);
  await assert.rejects(s.store.revoke(admin,'grant',Number.MAX_SAFE_INTEGER),/revoked/);const events=await s.store.history(admin,'grant');assert.deepEqual(events.map(event=>event.event),['issued','renewed','revoked']);assert.equal(events.at(-1).revision,Number.MAX_SAFE_INTEGER);
 }finally{db?.close();close(s);}
});

test('maximum-revision revocation fences pending delegation reads and history',async()=>{
 for(const access of ['read','history']){
  const s=setup();let db,restricted,entered,release;const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  try{
   await s.store.issue(admin,grant);db=new DatabaseSync(s.path);db.prepare('UPDATE agent_delegations SET revision=? WHERE grant_id=?').run(Number.MAX_SAFE_INTEGER,'grant');
   restricted=new SqliteAgentDelegations(s.path,{...s.options,authorize:async(_actor,action)=>{if(action===access){entered();await gate;}return true;}});
   const pending=access==='read'?restricted.get(admin,'grant'):restricted.history(admin,'grant');await ready;
   await s.store.revoke(admin,'grant',Number.MAX_SAFE_INTEGER);release();await assert.rejects(pending,/Delegation changed/);
   assert.equal((await s.store.get(admin,'grant')).revoked,true);assert.deepEqual((await s.store.history(admin,'grant')).map(event=>event.event),['issued','revoked']);
  }finally{release();restricted?.close();db?.close();close(s);}
 }
});

test('delegation history cannot include a renewal committed after its revision check',async()=>{
 const s=setup();try{
  s.store.db.exec('PRAGMA journal_mode=WAL');await s.store.issue(admin,grant);
  const prepare=s.store.db.prepare.bind(s.store.db);let injected=false;
  s.store.db.prepare=sql=>{
   if(!injected&&sql.startsWith('SELECT revision,event,actor_id')){
    injected=true;const child=spawnSync(process.execPath,[fileURLToPath(new URL('./fixtures/concurrent-delegation-renew.mjs',import.meta.url))],{env:{...process.env,APP_MIXER_TEST_DB:s.path},encoding:'utf8',timeout:10000});
    assert.equal(child.status,0,child.stderr);
   }
   return prepare(sql);
  };
  const history=await s.store.history(admin,'grant');assert.equal(injected,true);assert.deepEqual(history.map(event=>event.event),['issued']);
  assert.deepEqual((await s.store.history(admin,'grant')).map(event=>event.event),['issued','renewed']);
 }finally{close(s);}
});

test('delegation history rejects a renewal during authorization',async()=>{
 let entered,release;const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 const s=setup(async(_actor,action)=>{if(action==='history'){entered();await gate;}return true;});let writer;
 try{
  await s.store.issue(admin,grant);writer=new SqliteAgentDelegations(s.path,{...s.options,authorize:()=>true});
  const pending=s.store.history(admin,'grant');await ready;await writer.renew(admin,'grant',1,'v2',100);release();
  await assert.rejects(pending,/Delegation changed/);assert.deepEqual((await writer.history(admin,'grant')).map(event=>event.event),['issued','renewed']);
 }finally{release();writer?.close();close(s);}
});

test('configured runtime revalidates persisted grants and accepts only a renewed snapshot',async()=>{
 const {SqliteAgentDefinitions,createConfiguredAgentRun}=await import('../dist/index.js'),{CapabilityRegistry}=await import('../../core/dist/index.js'),{AIMessage}=await import('@langchain/core/messages');const s=setup(),definitions=new SqliteAgentDefinitions(':memory:');try{
 definitions.save('tenant',{manifestVersion:1,tenantId:'tenant',agentId:'agent',name:'Agent',owner:{kind:'organization',id:'org'},administrators:['admin'],servicePrincipalId:'worker',model:{provider:'local',model:'test'},allowedCapabilities:['lookup'],lifecycle:{enabled:true,maxAttempts:3,runTimeoutMs:1000},quotas:{maxConcurrentRuns:1,maxTokensPerRun:100,maxRunsPerDay:10}},0);
 let effects=0;const registry=new CapabilityRegistry(()=>{});registry.register({operationId:'lookup',method:'GET',path:'/lookup'},{authorize:actor=>actor.principalId==='user',validate:()=>true,execute:()=>{effects++;return true}});
 const make=async snapshot=>createConfiguredAgentRun({definitions,tenantId:'tenant',agentId:'agent',expectedVersion:1,bindings:[{operationId:'lookup',toolName:'lookup',description:'Look up'}],registry,authorizeRun:()=>true,authorizeCapability:()=>true,delegation:{grant:snapshot,clock:s.options.clock,authorize:(_identity,current)=>s.store.verify(worker,current)},createModel:()=>{let turn=0;return {async invoke(){return ++turn===1?new AIMessage({content:'',tool_calls:[{id:'action',name:'lookup',args:{}}]}):new AIMessage('Done')}}}});
 const runInput={threadId:'thread',runId:'run',messages:[{role:'user',content:'Look up'}]},run=async snapshot=>{const events=[];for await(const event of (await make(snapshot)).run(runInput))events.push(event);return events.at(-1).type};
 const issued=await s.store.issue(admin,grant);assert.equal(await run(issued.grant),'RUN_FINISHED');s.now=50;assert.equal(await run(issued.grant),'RUN_ERROR');const renewed=await s.store.renew(admin,'grant',1,'v2',100);assert.equal(await run(issued.grant),'RUN_ERROR');assert.equal(await run(renewed.grant),'RUN_FINISHED');await s.store.revoke(admin,'grant',2);assert.equal(await run(renewed.grant),'RUN_ERROR');assert.equal(effects,2);
 }finally{definitions.close();close(s);}
});

test('authenticated fixed-run delegation capabilities issue, renew, inspect and revoke with paginated history',async()=>{
 const {CapabilityRegistry,createCapabilityServer}=await import('../../core/dist/index.js'),{registerAgentDelegationCapability}=await import('../dist/index.js'),{once}=await import('node:events'),s=setup(),events=[],registry=new CapabilityRegistry(event=>events.push(event));let server;
 try{
  const base={store:s.store,scope:{...scope},runId:'run',grantId:'grant',authorize:actor=>actor.principalId==='admin',authorizeAction:(_actor,input)=>input.principalId===undefined||input.principalId==='user',historyLimit:1};for(const mode of ['issue','read','renew','revoke','history'])registerAgentDelegationCapability(registry,{...base,mode,operationId:mode,path:'/'+mode});
  assert.throws(()=>registerAgentDelegationCapability(registry,{...base,runId:'other',mode:'read',operationId:'bad',path:'/bad'}),/configuration|capability/);base.scope.agentId='other';
  server=createCapabilityServer(registry,req=>req.headers.authorization==='admin'?admin:req.headers.authorization==='other'?{...admin,tenantId:'other'}:undefined,event=>events.push(event));server.listen(0,'127.0.0.1');await once(server,'listening');const call=(mode,query,auth='admin')=>fetch(`http://127.0.0.1:${server.address().port}/capabilities/${mode}/invoke`,{method:'POST',headers:{authorization:auth,'content-type':'application/json'},body:JSON.stringify({origin:'ui',input:{query}})});
  assert.equal((await call('history',{})).status,404);assert.equal((await call('read',{},'other')).status,403);assert.equal((await call('read',{},'none')).status,401);assert.equal((await call('issue',{principalId:'user',permissionVersion:'v1',expiresAt:50,runId:'other'})).status,400);assert.equal((await call('issue',{principalId:'other',permissionVersion:'v1',expiresAt:50})).status,403);
  assert.equal((await call('issue',{principalId:'user',permissionVersion:'v1',expiresAt:1001})).status,409);let response=await call('issue',{principalId:'user',permissionVersion:'v1',expiresAt:50});assert.equal(response.status,200);let value=(await response.json()).result;assert.equal(value.revision,1);assert.equal(value.grant.runId,'run');assert.equal(value.grant.agentId,'agent');assert.equal((await call('issue',{principalId:'user',permissionVersion:'v1',expiresAt:50})).status,409);
  response=await call('renew',{revision:1,permissionVersion:'v2',expiresAt:100});assert.equal(response.status,200);value=(await response.json()).result;assert.equal(value.revision,2);assert.equal((await call('renew',{revision:1,permissionVersion:'v3',expiresAt:100})).status,409);response=await call('history',{});let page=(await response.json()).result;assert.deepEqual(page.items.map(item=>item.event),['issued']);assert.ok(page.nextAfter);response=await call('history',{after:page.nextAfter});page=(await response.json()).result;assert.deepEqual(page.items.map(item=>item.event),['renewed']);assert.equal(page.nextAfter,undefined);
  assert.equal((await call('revoke',{revision:2})).status,200);response=await call('read',{});value=(await response.json()).result;assert.equal(value.revoked,true);assert.equal(value.revision,3);assert.equal(await s.store.verify(worker,value.grant),false);assert.ok(events.some(event=>event.outcome==='denied'));
 }finally{if(server?.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}close(s);}
});

test('delegation history pages fence changes during authorization',async()=>{
 let entered,release,wait=false;const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),s=setup(async(_actor,action)=>{if(wait&&action==='history'){entered();await gate;}return true;});let writer;
 try{await s.store.issue(admin,grant);writer=new SqliteAgentDelegations(s.path,{...s.options,authorize:()=>true});wait=true;const pending=s.store.historyPage(admin,'grant',{limit:1});await ready;await writer.renew(admin,'grant',1,'v2',100);release();await assert.rejects(pending,/changed/);wait=false;const first=await s.store.historyPage(admin,'grant',{limit:1}),second=await s.store.historyPage(admin,'grant',{after:first.nextAfter,limit:1});assert.deepEqual(first.items.map(item=>item.event),['issued']);assert.deepEqual(second.items.map(item=>item.event),['renewed']);assert.equal(second.nextAfter,undefined);}finally{release();writer?.close();close(s);}
});

test('delegation capability policy deadlines retain capacity and fence late authorization',async()=>{
 const {CapabilityRegistry}=await import('../../core/dist/index.js'),{registerAgentDelegationCapability}=await import('../dist/index.js'),s=setup(),registry=new CapabilityRegistry(()=>{});let entered,release;const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);let block=true;
 try{registerAgentDelegationCapability(registry,{store:s.store,scope,runId:'run',grantId:'grant',mode:'issue',operationId:'issue',path:'/issue',authorize:()=>true,authorizeAction:async(_actor,_input,signal)=>{if(block){entered();await gate;}return !signal.aborted;},timeoutMs:100,maxPending:1});const call=()=>registry.invoke('issue',{query:{principalId:'user',permissionVersion:'v1',expiresAt:50}},{...admin,origin:'ui'});const pending=call();await ready;await assert.rejects(pending,/unavailable/);await assert.rejects(call(),/unavailable/);release();block=false;await new Promise(resolve=>setImmediate(resolve));assert.equal(await s.store.get(admin,'grant'),undefined);assert.equal((await call()).revision,1);}finally{release();close(s);}
});

test('delegation capability does not reveal a read after outer permission is revoked',async()=>{
 const {CapabilityRegistry}=await import('../../core/dist/index.js'),{registerAgentDelegationCapability}=await import('../dist/index.js');let entered,release,block=false,allowed=true;const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),s=setup(async(_actor,action)=>{if(block&&action==='read'){entered();await gate;}return true;}),registry=new CapabilityRegistry(()=>{});
 try{await s.store.issue(admin,grant);registerAgentDelegationCapability(registry,{store:s.store,scope,runId:'run',grantId:'grant',mode:'read',operationId:'read',path:'/read',authorize:()=>allowed,authorizeAction:()=>true});block=true;const pending=registry.invoke('read',{query:{}},{...admin,origin:'ui'});await ready;allowed=false;release();await assert.rejects(pending,/forbidden/);}finally{release();close(s);}
});
