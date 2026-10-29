import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {createHmac} from 'node:crypto';
import {SqliteAgentRuns,SqliteAgentTriggers,SqliteAgentDefinitions,DurableAgentWorker,createAgentEventIngress,createSignedWebhookAuthenticator,createGithubWebhookAdapter} from '../dist/index.js';
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


test('HTTP ingress reserves internal schedule source identifiers',async()=>{
 const s=setup(),definitions=new SqliteAgentDefinitions(':memory:');definitions.save('tenant',manifest,0);const ingress=createAgentEventIngress({triggers:s.triggers,definitions,maxPending:1,authenticate:()=>({tenantId:'tenant',principalId:'sender',sourceId:'schedule.forged'}),authorize:()=>true});ingress.listen(0,'127.0.0.1');await once(ingress,'listening');
 try{const response=await fetch(`http://127.0.0.1:${ingress.address().port}/events`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({agentId:'agent',eventId:'event',eventType:'order.created',payload:{}})});assert.equal(response.status,401);assert.equal(s.runs.list(scope).length,0);}finally{await new Promise(r=>ingress.close(r));definitions.close();close(s);}
});


test('signed webhooks bind exact bytes, source and time, and deduplicate accepted deliveries',async()=>{
 const s=setup(),definitions=new SqliteAgentDefinitions(':memory:');definitions.save('tenant',manifest,0);const key=Buffer.alloc(32,42),original=Buffer.from(key),now=1700000000000,auth=createSignedWebhookAuthenticator({sources:[{tenantId:'tenant',principalId:'sender',sourceId:'provider',secret:key}],clock:()=>now});key.fill(0);
 let authorizations=0;const ingress=createAgentEventIngress({triggers:s.triggers,definitions,maxPending:2,authenticateRaw:auth,authorize:(identity)=>{authorizations++;return identity.sourceId==='provider';},clock:()=>now});ingress.listen(0,'127.0.0.1');await once(ingress,'listening');
 try{const url=`http://127.0.0.1:${ingress.address().port}/events`,body=JSON.stringify({agentId:'agent',eventId:'evt',eventType:'order.created',payload:{order:'one'}}),signed=(data=body,timestamp='1700000000',source='provider')=>{const signature=createHmac('sha256',original).update(`v1\n${timestamp}\n${source}\n`).update(data).digest('hex');return {'content-type':'application/json','x-app-mixer-source':source,'x-app-mixer-timestamp':timestamp,'x-app-mixer-signature':`v1=${signature}`};},post=(data,headers)=>fetch(url,{method:'POST',headers,body:data});
  assert.equal((await post(body,signed())).status,202);assert.equal((await post(body,signed())).status,200);assert.equal((await post(body+' ',signed())).status,401);assert.equal((await post(body,signed(body,'1699999699'))).status,401);assert.equal((await post(body,signed(body,'1700000301'))).status,401);assert.equal((await post(body,signed(body,'1700000000','unknown'))).status,401);assert.equal((await post(body,{...signed(),'x-app-mixer-signature':'v1='+'0'.repeat(64)})).status,401);assert.equal(authorizations,2);assert.equal(s.runs.list(scope).length,1);
 }finally{await new Promise(r=>ingress.close(r));definitions.close();close(s);}
});

test('signed webhook configuration rejects weak keys, reserved and duplicate sources',()=>{
 const source={tenantId:'tenant',principalId:'sender',sourceId:'provider',secret:Buffer.alloc(32)};
 assert.throws(()=>createSignedWebhookAuthenticator({sources:[{...source,secret:Buffer.alloc(31)}]}),/configuration/);assert.throws(()=>createSignedWebhookAuthenticator({sources:[source,source]}),/configuration/);assert.throws(()=>createSignedWebhookAuthenticator({sources:[{...source,sourceId:'schedule.foo'}]}),/configuration/);
});


test('webhook key rotation accepts an overlap and rejects retired keys without losing deduplication',async()=>{
 const s=setup(),definitions=new SqliteAgentDefinitions(':memory:');definitions.save('tenant',manifest,0);const old=Buffer.alloc(32,42),next=Buffer.alloc(32,43),other=Buffer.alloc(32,44),now=1700000000000,source={tenantId:'tenant',principalId:'sender',sourceId:'provider'},body=JSON.stringify({agentId:'agent',eventId:'evt',eventType:'order.created',payload:{order:'one'}});let ingress;
 const launch=async auth=>{ingress=createAgentEventIngress({triggers:s.triggers,definitions,maxPending:2,authenticateRaw:auth,authorize:()=>true,clock:()=>now});ingress.listen(0,'127.0.0.1');await once(ingress,'listening');};
 const post=key=>fetch(`http://127.0.0.1:${ingress.address().port}/events`,{method:'POST',headers:{'content-type':'application/json','x-app-mixer-source':'provider','x-app-mixer-timestamp':'1700000000','x-app-mixer-signature':'v1='+createHmac('sha256',key).update('v1\n1700000000\nprovider\n').update(body).digest('hex')},body});
 try{const mutableOld=Buffer.from(old),mutableNext=Buffer.from(next),previous=[mutableOld],auth=createSignedWebhookAuthenticator({sources:[{...source,secret:mutableNext,previousSecrets:previous},{...source,sourceId:'other',secret:other}],clock:()=>now});mutableOld.fill(0);mutableNext.fill(0);previous.length=0;await launch(auth);assert.equal((await post(old)).status,202);assert.equal((await post(next)).status,200);assert.equal((await post(other)).status,401);await new Promise(r=>ingress.close(r));ingress=null;await launch(createSignedWebhookAuthenticator({sources:[{...source,secret:next}],clock:()=>now}));assert.equal((await post(old)).status,401);assert.equal((await post(next)).status,200);assert.equal(s.runs.list(scope).length,1);}finally{if(ingress)await new Promise(r=>ingress.close(r));definitions.close();close(s);}
});

test('webhook rotation rejects invalid or duplicate previous keys',()=>{
 const source={tenantId:'tenant',principalId:'sender',sourceId:'provider',secret:Buffer.alloc(32,1)},k=Buffer.alloc(32,2);for(const previousSecrets of [null,'bad',[Buffer.alloc(31)],[k,k],[Buffer.alloc(32,1)],[k,Buffer.alloc(32,3),Buffer.alloc(32,4)]])assert.throws(()=>createSignedWebhookAuthenticator({sources:[{...source,previousSecrets}]}),/configuration/);
});


test('GitHub webhook adapter verifies raw body and ignores unsigned delivery headers',async()=>{
 const s=setup(),definitions=new SqliteAgentDefinitions(':memory:');definitions.save('tenant',manifest,0);const secret=Buffer.alloc(32,9),prior=Buffer.alloc(32,8),adapter=createGithubWebhookAdapter({identity:{tenantId:'tenant',principalId:'sender',sourceId:'github'},agentId:'agent',eventType:'github.webhook',secret,previousSecrets:[prior]}),original=Buffer.from(secret);secret.fill(0);let seen=0;const ingress=createAgentEventIngress({triggers:s.triggers,definitions,maxPending:3,...adapter,authorize:(identity,event)=>{seen++;return identity.sourceId==='github'&&event.eventType==='github.webhook'&&event.payload.repository?.id===42;}});ingress.listen(0,'127.0.0.1');await once(ingress,'listening');
 try{const url=`http://127.0.0.1:${ingress.address().port}/events`,body=JSON.stringify({action:'opened',repository:{id:42},issue:{number:4}}),sign=(key,data)=>'sha256='+createHmac('sha256',key).update(data).digest('hex'),post=(payload,signature,extra={})=>fetch(url,{method:'POST',headers:{'content-type':'application/json','x-hub-signature-256':signature,...extra},body:payload});let response=await post(body,sign(prior,body),{'x-github-event':'issues','x-github-delivery':'one'});assert.equal(response.status,202);const first=await response.json();response=await post(body,sign(original,body),{'x-github-event':'push','x-github-delivery':'different'});assert.equal(response.status,200);assert.equal((await response.json()).runId,first.runId);assert.equal((await post(body+' ',sign(original,body))).status,401);assert.equal((await post(body,'sha256='+'0'.repeat(64))).status,401);const denied=JSON.stringify({repository:{id:99}});assert.equal((await post(denied,sign(original,denied))).status,403);assert.equal((await post('[]',sign(original,'[]'))).status,400);assert.equal(seen,3);const record=s.triggers.get(scope,first.runId);assert.equal(record.eventType,'github.webhook');assert.deepEqual(record.payload,JSON.parse(body));assert.match(record.eventId,/^sha256:[0-9a-f]{64}$/);assert.equal(adapter.authenticateRaw({rawHeaders:['X-Hub-Signature-256',sign(original,body),'x-hub-signature-256',sign(original,body)]},Buffer.from(body)),undefined);assert.equal(s.runs.list(scope).length,1);}finally{await new Promise(r=>ingress.close(r));definitions.close();close(s);}
});

test('GitHub webhook adapter validates configuration and ingress mapping',()=>{
 const base={identity:{tenantId:'tenant',principalId:'sender',sourceId:'github'},agentId:'agent',eventType:'github.webhook',secret:Buffer.alloc(32,3)};for(const bad of [{...base,secret:Buffer.alloc(31)},{...base,identity:{...base.identity,sourceId:'schedule.fake'}},{...base,previousSecrets:[Buffer.alloc(32,3)]},{...base,previousSecrets:[Buffer.alloc(32,4),Buffer.alloc(32,5),Buffer.alloc(32,6)]}])assert.throws(()=>createGithubWebhookAdapter(bad),/configuration/);
 const adapter=createGithubWebhookAdapter(base);assert.throws(()=>adapter.mapAuthenticatedBody(Buffer.from([0xff])),/encoded data/);const s=setup(),definitions=new SqliteAgentDefinitions(':memory:');try{assert.throws(()=>createAgentEventIngress({triggers:s.triggers,definitions,maxPending:1,authenticate:()=>undefined,authorize:()=>true,mapAuthenticatedBody:adapter.mapAuthenticatedBody}),/Invalid event ingress/);}finally{definitions.close();close(s);}
});


test('mapped event data is snapshotted before asynchronous authorization',async()=>{
 const s=setup(),definitions=new SqliteAgentDefinitions(':memory:');definitions.save('tenant',manifest,0);let started,resume;const ready=new Promise(r=>started=r),gate=new Promise(r=>resume=r),mapped={agentId:'agent',eventId:'event',eventType:'custom.event',payload:{value:'original'}};const ingress=createAgentEventIngress({triggers:s.triggers,definitions,maxPending:2,authenticateRaw:()=>({tenantId:'tenant',principalId:'sender',sourceId:'source'}),mapAuthenticatedBody:()=>mapped,authorize:async(_identity,event)=>{assert.equal(event.payload.value,'original');started();await gate;return true;}});ingress.listen(0,'127.0.0.1');await once(ingress,'listening');try{const pending=fetch(`http://127.0.0.1:${ingress.address().port}/events`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});await ready;mapped.payload.value='changed';mapped.eventId='changed';resume();const response=await pending;assert.equal(response.status,202);const result=await response.json(),stored=s.triggers.get(scope,result.runId);assert.equal(stored.eventId,'event');assert.equal(stored.payload.value,'original');}finally{resume();await new Promise(r=>ingress.close(r));definitions.close();close(s);}
});
