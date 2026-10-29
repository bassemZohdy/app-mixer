import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {SqliteAgentRuns,SqliteAgentTriggers,SqliteAgentDefinitions,DurableAgentWorker,createAgentEventIngress} from '../dist/index.js';
const scope={tenantId:'tenant',agentId:'agent'},event={sourceId:'source',principalId:'sender',eventId:'evt',eventType:'order.created',payload:{order:'one'}};
const manifest={manifestVersion:1,tenantId:'tenant',agentId:'agent',name:'Agent',owner:{kind:'organization',id:'org'},administrators:['admin'],servicePrincipalId:'svc',model:{provider:'local',model:'test'},allowedCapabilities:[],lifecycle:{enabled:true,maxAttempts:2,runTimeoutMs:60000},quotas:{maxConcurrentRuns:1,maxTokensPerRun:100,maxRunsPerDay:10}};
const settings={definitionVersion:1,maxAttempts:2,deadline:10000,maxPending:2};
function setup(){const dir=mkdtempSync(join(tmpdir(),'app-mixer-events-')),path=join(dir,'runs.sqlite'),runs=new SqliteAgentRuns(path),triggers=new SqliteAgentTriggers(path);return {dir,path,runs,triggers};}
function close(s){s.triggers.close();s.runs.close();rmSync(s.dir,{recursive:true,force:true});}

test('event deduplication, tenant isolation and bounded backlog survive restart',()=>{
 const s=setup();let second;try{
  const first=s.triggers.enqueue(scope,event,settings,1);assert.equal(first.duplicate,false);second=new SqliteAgentTriggers(s.path);
  assert.deepEqual(second.enqueue(scope,{...event,payload:{order:'one'}},settings,2),{runId:first.runId,duplicate:true});assert.equal(s.runs.get(scope,first.runId).status,'queued');assert.deepEqual(second.get(scope,first.runId).payload,{order:'one'});
  assert.throws(()=>second.enqueue(scope,{...event,payload:{order:'two'}},settings,2),/identity conflict/);assert.throws(()=>second.enqueue(scope,{...event,principalId:'other'},settings,2),/identity conflict/);assert.equal(second.get({...scope,tenantId:'other'},first.runId),undefined);
  second.enqueue(scope,{...event,eventId:'evt2'},settings,2);assert.throws(()=>second.enqueue(scope,{...event,eventId:'evt3'},settings,2),/backlog full/);assert.equal(second.enqueue(scope,event,settings,2).duplicate,true);
  const other=second.enqueue({...scope,tenantId:'other'},event,settings,2);assert.notEqual(other.runId,first.runId);
 }finally{second?.close();close(s);}
});

test('inbox failure rolls back the queued run atomically',()=>{
 const s=setup();let db;try{db=new DatabaseSync(s.path);db.exec("CREATE TRIGGER fail_inbox BEFORE INSERT ON agent_trigger_inbox BEGIN SELECT RAISE(ABORT,'test failure'); END;");assert.throws(()=>s.triggers.enqueue(scope,event,settings,1),/test failure/);assert.equal(s.runs.list(scope).length,0);}finally{db?.close();close(s);}
});

test('ingress authenticates and authorizes event source before enqueueing a worker run',async()=>{
 const s=setup(),definitions=new SqliteAgentDefinitions(':memory:');definitions.save('tenant',manifest,0);let allow=true;
 const ingress=createAgentEventIngress({triggers:s.triggers,definitions,maxPending:1,authenticate:req=>req.headers.authorization==='Bearer trusted'?{tenantId:'tenant',principalId:'sender',sourceId:'source'}:undefined,authorize:(identity,request)=>allow&&identity.sourceId==='source'&&request.eventType==='order.created'});ingress.listen(0,'127.0.0.1');await once(ingress,'listening');
 try{const url=`http://127.0.0.1:${ingress.address().port}/events`,payload={agentId:'agent',eventId:'evt',eventType:'order.created',payload:{order:'one'}},post=(value,token='trusted')=>({method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(value)});
  assert.equal((await fetch(url,post(payload,'bad'))).status,401);assert.equal((await fetch(url,post({...payload,tenantId:'other'}))).status,400);allow=false;assert.equal((await fetch(url,post(payload))).status,403);assert.equal(s.runs.list(scope).length,0);allow=true;
  const created=await fetch(url,post(payload));assert.equal(created.status,202);const {runId}=await created.json();assert.equal((await fetch(url,post(payload))).status,200);assert.equal((await fetch(url,post({...payload,payload:{order:'two'}}))).status,409);assert.equal((await fetch(url,post({...payload,eventId:'another'}))).status,429);
  let observed;const worker=new DurableAgentWorker({runs:s.runs,definitions,workerId:'worker',leaseMs:1000,pollMs:100,authorizeStart:()=>true,execute:async run=>{observed=s.triggers.get(scope,run.runId);return 'succeeded';}});assert.equal((await worker.runOnce(scope,runId)).status,'succeeded');assert.equal(observed.payload.order,'one');assert.equal(observed.principalId,'sender');
  assert.equal((await fetch(url,post({...payload,eventId:'another'}))).status,202);
 }finally{await new Promise(r=>ingress.close(r));definitions.close();close(s);}
});

test('definition changes during authorization deny event creation',async()=>{
 const s=setup(),definitions=new SqliteAgentDefinitions(':memory:');definitions.save('tenant',manifest,0);let ready,proceed;const started=new Promise(r=>ready=r),gate=new Promise(r=>proceed=r);
 const ingress=createAgentEventIngress({triggers:s.triggers,definitions,maxPending:2,authenticate:()=>({tenantId:'tenant',principalId:'sender',sourceId:'source'}),authorize:async()=>{ready();await gate;return true;}});ingress.listen(0,'127.0.0.1');await once(ingress,'listening');
 try{const pending=fetch(`http://127.0.0.1:${ingress.address().port}/events`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({agentId:'agent',eventId:'evt',eventType:'order.created',payload:{}})});await started;definitions.save('tenant',{...manifest,lifecycle:{...manifest.lifecycle,enabled:false}},1);proceed();assert.equal((await pending).status,403);assert.equal(s.runs.list(scope).length,0);}
 finally{await new Promise(r=>ingress.close(r));definitions.close();close(s);}
});


test('concurrency limit is atomic across connections and released after settlement',()=>{
 const s=setup();let other;try{other=new SqliteAgentRuns(s.path);s.runs.create(scope,'one',{definitionVersion:1,maxAttempts:1,deadline:1000},0);other.create(scope,'two',{definitionVersion:1,maxAttempts:1,deadline:1000},0);let first=s.runs.claim(scope,'one',1,'worker-a',100,10,1);assert.throws(()=>other.claim(scope,'two',1,'worker-b',100,10,1),/concurrency limit/);first=s.runs.settle(scope,'one',first.revision,first.leaseToken,'succeeded',11);assert.equal(first.status,'succeeded');assert.equal(other.claim(scope,'two',1,'worker-b',100,12,1).status,'running');}
 finally{other?.close();close(s);}
});
