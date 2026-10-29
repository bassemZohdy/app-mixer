import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
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

test('configured runtime revalidates persisted grants and accepts only a renewed snapshot',async()=>{
 const {SqliteAgentDefinitions,createConfiguredAgentRun}=await import('../dist/index.js'),{CapabilityRegistry}=await import('../../core/dist/index.js'),{AIMessage}=await import('@langchain/core/messages');const s=setup(),definitions=new SqliteAgentDefinitions(':memory:');try{
 definitions.save('tenant',{manifestVersion:1,tenantId:'tenant',agentId:'agent',name:'Agent',owner:{kind:'organization',id:'org'},administrators:['admin'],servicePrincipalId:'worker',model:{provider:'local',model:'test'},allowedCapabilities:['lookup'],lifecycle:{enabled:true,maxAttempts:3,runTimeoutMs:1000},quotas:{maxConcurrentRuns:1,maxTokensPerRun:100,maxRunsPerDay:10}},0);
 let effects=0;const registry=new CapabilityRegistry(()=>{});registry.register({operationId:'lookup',method:'GET',path:'/lookup'},{authorize:actor=>actor.principalId==='user',validate:()=>true,execute:()=>{effects++;return true}});
 const make=async snapshot=>createConfiguredAgentRun({definitions,tenantId:'tenant',agentId:'agent',expectedVersion:1,bindings:[{operationId:'lookup',toolName:'lookup',description:'Look up'}],registry,authorizeRun:()=>true,authorizeCapability:()=>true,delegation:{grant:snapshot,clock:s.options.clock,authorize:(_identity,current)=>s.store.verify(worker,current)},createModel:()=>{let turn=0;return {async invoke(){return ++turn===1?new AIMessage({content:'',tool_calls:[{id:'action',name:'lookup',args:{}}]}):new AIMessage('Done')}}}});
 const runInput={threadId:'thread',runId:'run',messages:[{role:'user',content:'Look up'}]},run=async snapshot=>{const events=[];for await(const event of (await make(snapshot)).run(runInput))events.push(event);return events.at(-1).type};
 const issued=await s.store.issue(admin,grant);assert.equal(await run(issued.grant),'RUN_FINISHED');s.now=50;assert.equal(await run(issued.grant),'RUN_ERROR');const renewed=await s.store.renew(admin,'grant',1,'v2',100);assert.equal(await run(issued.grant),'RUN_ERROR');assert.equal(await run(renewed.grant),'RUN_FINISHED');await s.store.revoke(admin,'grant',2);assert.equal(await run(renewed.grant),'RUN_ERROR');assert.equal(effects,2);
 }finally{definitions.close();close(s);}
});
