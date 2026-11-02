import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {AIMessage} from '@langchain/core/messages';
import {CapabilityRegistry} from '../../core/dist/index.js';
import {SqliteAgentRuns,SqliteAgentApprovals,SqliteAgentActionJournal,SqliteAgentDefinitions,createConfiguredAgentRun} from '../dist/index.js';
const scope={tenantId:'tenant',agentId:'agent'},service={tenantId:'tenant',principalId:'service'},human={tenantId:'tenant',principalId:'human'};
function setup(){const dir=mkdtempSync(join(tmpdir(),'app-mixer-approval-')),path=join(dir,'runs.sqlite'),runs=new SqliteAgentRuns(path);let now=10,run=runs.create(scope,'run',{definitionVersion:1,maxAttempts:3,deadline:1000},0);run=runs.claim(scope,'run',run.revision,'worker',100,now);
 const approvals=new SqliteAgentApprovals(path,{scope,runId:'run',clock:()=>now,authorize:(actor,action)=>actor.principalId==='service'?action==='request':actor.principalId==='human'});const journal=new SqliteAgentActionJournal(path,{scope,runId:'run',leaseToken:run.leaseToken,clock:()=>now});return {dir,path,runs,approvals,journal,get run(){return run;},set run(v){run=v;},get now(){return now;},set now(v){now=v;}};}
function close(s){s.journal.close();s.approvals.close();s.runs.close();rmSync(s.dir,{recursive:true,force:true});}

test('approval is durable, authorized, auditable and bound to exact action data',async()=>{
 const s=setup();let reopened,db;try{
  const req=await s.approvals.request(service,s.run.leaseToken,'action','pay',{amount:10},90);assert.equal(req.status,'pending');assert.equal((await s.approvals.list(human)).items.length,1);await assert.rejects(s.approvals.decide(service,'action','approved'),/access denied/);await assert.rejects(s.journal.invoke('action','pay',{amount:10},2,async()=>null,true),/Approval required/);
  assert.equal((await s.approvals.decide(human,'action','approved')).decidedBy,'human');assert.deepEqual((await s.approvals.history(human,'action')).map(e=>e.event),['requested','approved']);await assert.rejects(s.approvals.decide(human,'action','approved'),/already decided/);
  await assert.rejects(s.journal.invoke('action','pay',{amount:11},2,async()=>null,true),/Approval required/);let effects=0;assert.deepEqual(await s.journal.invoke('action','pay',{amount:10},2,async()=>{effects++;return {ok:true};},true),{ok:true});assert.equal(effects,1);
  reopened=new SqliteAgentApprovals(s.path,{scope,runId:'run',clock:()=>20,authorize:()=>true});assert.equal((await reopened.get(human,'action')).status,'approved');db=new DatabaseSync(s.path);assert.throws(()=>db.exec("UPDATE agent_approval_events SET event='tamper'"),/immutable/);assert.throws(()=>db.exec('DELETE FROM agent_approval_events'),/immutable/);assert.throws(()=>db.exec('INSERT OR REPLACE INTO agent_approval_events SELECT * FROM agent_approval_events'),/immutable/);
 }finally{db?.close();reopened?.close();close(s);}
});

test('rejection, revocation, expiration and scope mismatch prevent dispatch',async()=>{
 for(const mode of ['rejected','cancelled','expired']){const s=setup();try{
  await s.approvals.request(service,s.run.leaseToken,'action','pay',{amount:10},90);
  if(mode==='rejected')await s.approvals.decide(human,'action','rejected');if(mode==='cancelled'){await s.approvals.decide(human,'action','approved');await s.approvals.decide(human,'action','cancelled');}if(mode==='expired'){s.now=90;assert.equal((await s.approvals.get(human,'action')).status,'expired');await s.approvals.expire(human,'action');}
  let calls=0;await assert.rejects(s.journal.invoke('action','pay',{amount:10},2,async()=>{calls++;return null;},true),/Approval required/);assert.equal(calls,0);assert.equal((await s.approvals.history(human,'action')).at(-1).event,mode);
  await assert.rejects(s.approvals.get({tenantId:'other',principalId:'human'},'action'),/actor/);
 }finally{close(s);}}
});

test('configured agent pauses on approval and dispatches only after a human decision and recovery',async()=>{
 const s=setup(),definitions=new SqliteAgentDefinitions(':memory:');let next;try{
  definitions.save('tenant',{manifestVersion:1,tenantId:'tenant',agentId:'agent',name:'Agent',owner:{kind:'organization',id:'org'},administrators:['admin'],servicePrincipalId:'service',model:{provider:'local',model:'test'},allowedCapabilities:['pay'],lifecycle:{enabled:true,maxAttempts:3,runTimeoutMs:1000},quotas:{maxConcurrentRuns:1,maxTokensPerRun:100,maxRunsPerDay:10}},0);
  let effects=0;const registry=new CapabilityRegistry(()=>{});registry.register({operationId:'pay',method:'POST',path:'/pay'},{authorize:()=>true,validate:()=>true,execute:()=>{effects++;return {ok:true};}});
  const make=async(journal,leaseToken)=>createConfiguredAgentRun({definitions,tenantId:'tenant',agentId:'agent',expectedVersion:1,bindings:[{operationId:'pay',toolName:'pay',description:'Pay'}],registry,authorizeRun:()=>true,authorizeCapability:()=>true,actionJournal:{journal,maxAttempts:2,prepareInput:(_op,input,key)=>({...input,idempotencyKey:key})},approval:{store:s.approvals,leaseToken,expiresAt:90,required:()=>true},createModel:()=>{let turn=0;return {async invoke(){return ++turn===1?new AIMessage({content:'',tool_calls:[{id:'action',name:'pay',args:{query:{amount:10}}}]}):new AIMessage('Done');}};}});
  const collect=async iterable=>{const result=[];for await(const item of iterable)result.push(item);return result;},input={threadId:'thread',runId:'run',messages:[{role:'user',content:'Pay'}]};
  const first=await make(s.journal,s.run.leaseToken);assert.equal((await collect(first.run(input))).at(-1).type,'RUN_ERROR');assert.equal(effects,0);assert.equal((await s.approvals.get(human,'action')).status,'pending');
  s.run=s.runs.settle(scope,'run',s.run.revision,s.run.leaseToken,'uncertain',20);await s.approvals.decide(human,'action','approved');s.run=s.runs.reconcile(scope,'run',s.run.revision,'retry',21);s.run=s.runs.claim(scope,'run',s.run.revision,'worker2',100,22);s.now=23;next=new SqliteAgentActionJournal(s.path,{scope,runId:'run',leaseToken:s.run.leaseToken,clock:()=>s.now});
  const second=await make(next,s.run.leaseToken);assert.equal((await collect(second.run(input))).at(-1).type,'RUN_FINISHED');assert.equal(effects,1);
 }finally{next?.close();definitions.close();close(s);}
});


test('competing decisions admit exactly one',async()=>{
 const s=setup();try{await s.approvals.request(service,s.run.leaseToken,'action','pay',{amount:10},90);const results=await Promise.allSettled([s.approvals.decide(human,'action','approved'),s.approvals.decide(human,'action','rejected')]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal((await s.approvals.history(human,'action')).length,2);}
 finally{close(s);}
});

test('journal never reuses a cached action across different delegated authorities',async()=>{
 const s=setup();try{
  const authority=JSON.stringify(['service','user1']);let effects=0;
  assert.deepEqual(await s.journal.invoke('action','pay',{amount:10},2,async()=>{effects++;return {ok:true}},false,authority),{ok:true});
  await assert.rejects(s.journal.invoke('action','pay',{amount:10},2,async()=>{effects++;return null},false,JSON.stringify(['service','user2'])),/authority conflict/);
  await assert.rejects(s.journal.invoke('action','pay',{amount:10},2,async()=>null),/authority conflict/);
  assert.deepEqual(await s.journal.invoke('action','pay',{amount:10},2,async()=>null,false,authority),{ok:true});assert.equal(effects,1);
 }finally{close(s);}
});

test('approval remains bound to the reviewed delegated authority across retries',async()=>{
 const s=setup();try{const authority=JSON.stringify(['service','user1']);await s.approvals.request(service,s.run.leaseToken,'action','pay',{amount:10},90,authority);await assert.rejects(s.approvals.request(service,s.run.leaseToken,'action','pay',{amount:10},90,JSON.stringify(['service','user2'])),/authority conflict/);await s.approvals.decide(human,'action','approved');await assert.rejects(s.journal.invoke('action','pay',{amount:10},2,async()=>null,true,JSON.stringify(['service','user2'])),/authority conflict/);assert.equal(await s.journal.invoke('action','pay',{amount:10},2,async()=>true,true,authority),true);
 }finally{close(s);}
});

test('delegated approval review and recovery retain the user authority through dispatch',async()=>{
 const s=setup(),definitions=new SqliteAgentDefinitions(':memory:');let next;try{
  definitions.save('tenant',{manifestVersion:1,tenantId:'tenant',agentId:'agent',name:'Agent',owner:{kind:'organization',id:'org'},administrators:['admin'],servicePrincipalId:'service',model:{provider:'local',model:'test'},allowedCapabilities:['pay'],lifecycle:{enabled:true,maxAttempts:3,runTimeoutMs:1000},quotas:{maxConcurrentRuns:1,maxTokensPerRun:100,maxRunsPerDay:10}},0);
  let effects=0;const registry=new CapabilityRegistry(()=>{});registry.register({operationId:'pay',method:'POST',path:'/pay'},{authorize:actor=>actor.principalId==='user1',validate:()=>true,execute:()=>{effects++;return true;}});
  const make=(journal,leaseToken,principalId)=>createConfiguredAgentRun({definitions,tenantId:'tenant',agentId:'agent',expectedVersion:1,bindings:[{operationId:'pay',toolName:'pay',description:'Pay'}],registry,authorizeRun:()=>true,authorizeCapability:()=>true,delegation:{grant:{tenantId:'tenant',agentId:'agent',runId:'run',principalId,grantId:'grant',permissionVersion:'v1',expiresAt:90},authorize:()=>true,clock:()=>s.now},actionJournal:{journal,maxAttempts:2,prepareInput:(_op,data)=>data},approval:{store:s.approvals,leaseToken,expiresAt:90,required:()=>true},createModel:()=>{let turn=0;return {async invoke(){return ++turn===1?new AIMessage({content:'',tool_calls:[{id:'action',name:'pay',args:{query:{amount:10}}}]}):new AIMessage('Done');}};}});
  const collect=async iterable=>{const events=[];for await(const event of iterable)events.push(event);return events;},input={threadId:'thread',runId:'run',messages:[{role:'user',content:'Pay'}]};
  assert.equal((await collect((await make(s.journal,s.run.leaseToken,'user1')).run(input))).at(-1).type,'RUN_ERROR');assert.equal((await s.approvals.get(human,'action')).authority,JSON.stringify(['service','user1']));
  s.run=s.runs.settle(scope,'run',s.run.revision,s.run.leaseToken,'uncertain',20);await s.approvals.decide(human,'action','approved');s.run=s.runs.reconcile(scope,'run',s.run.revision,'retry',21);s.run=s.runs.claim(scope,'run',s.run.revision,'worker2',100,22);s.now=23;next=new SqliteAgentActionJournal(s.path,{scope,runId:'run',leaseToken:s.run.leaseToken,clock:()=>s.now});
  assert.equal((await collect((await make(next,s.run.leaseToken,'user2')).run(input))).at(-1).type,'RUN_ERROR');assert.equal(effects,0);assert.equal((await collect((await make(next,s.run.leaseToken,'user1')).run(input))).at(-1).type,'RUN_FINISHED');assert.equal(effects,1);
 }finally{next?.close();definitions.close();close(s);}
});

test('approval listing snapshots page options and rechecks scope and item permission',async()=>{
 const s=setup();let restricted,release,entered,phase='page',listAllowed=true,readAllowed=true,blocked=true;const gates=()=>{let open,ready;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);return {gate,started};};try{await s.approvals.request(service,s.run.leaseToken,'a','pay',{n:1},90);await s.approvals.request(service,s.run.leaseToken,'b','pay',{n:2},90);let {gate,started}=gates();restricted=new SqliteAgentApprovals(s.path,{scope,runId:'run',clock:()=>10,authorize:async(_actor,action)=>{if(action==='list'){if(phase==='page'&&blocked){blocked=false;entered();await gate;}return listAllowed;}return readAllowed;}});const options={limit:1},pending=restricted.list(human,options);await started;options.limit=100;options.after='b';release();const page=await pending;assert.deepEqual(page.items.map(item=>item.actionId),['a']);assert.equal(page.nextAfter,'a');phase='scope';blocked=true;({gate,started}=gates());restricted.close();restricted=new SqliteAgentApprovals(s.path,{scope,runId:'run',clock:()=>10,authorize:async(_actor,action)=>{if(action==='read'&&blocked){blocked=false;entered();await gate;return true;}return action==='list'?listAllowed:readAllowed;}});const pendingScope=restricted.list(human);await started;listAllowed=false;release();await assert.rejects(pendingScope,/access denied/);listAllowed=true;blocked=true;({gate,started}=gates());const pendingRead=restricted.list(human);await started;readAllowed=false;release();await assert.rejects(pendingRead,/access denied/);for(const after of ['',null])await assert.rejects(restricted.list(human,{after}),/Invalid approval listing/);
 }finally{release?.();restricted?.close();close(s);}
});

test('approval lookup does not reveal a record inserted while authorization was pending',async()=>{
 const s=setup();let restricted,entered,release;const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);try{restricted=new SqliteAgentApprovals(s.path,{scope,runId:'run',clock:()=>10,authorize:async(_actor,action,approval)=>{if(action==='read'&&approval.operationId==='unknown'){entered();await gate;}return true;}});const pending=restricted.get(human,'later');await ready;await s.approvals.request(service,s.run.leaseToken,'later','pay',{private:'value'},90);release();await assert.rejects(pending,/Approval changed/);assert.equal((await restricted.get(human,'later')).operationId,'pay');}finally{release();restricted?.close();close(s);}
});

test('approval listing returns current decision after final scope authorization',async()=>{
 const s=setup();let restricted,entered,release,checks=0;const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);try{await s.approvals.request(service,s.run.leaseToken,'action','pay',{amount:10},90);restricted=new SqliteAgentApprovals(s.path,{scope,runId:'run',clock:()=>10,authorize:async(_actor,action)=>{if(action==='list'&&++checks===2){entered();await gate;}return true;}});const pending=restricted.list(human);await ready;await s.approvals.decide(human,'action','approved');release();assert.equal((await pending).items[0].status,'approved');}finally{release();restricted?.close();close(s);}
});
