import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {createHmac} from 'node:crypto';
import {SqliteAgentRuns,SqliteAgentTriggers,SqliteAgentDefinitions,createAgentEventIngress,createSentryWebhookAdapter} from '../dist/index.js';

const manifest={manifestVersion:1,tenantId:'tenant',agentId:'agent',name:'Agent',owner:{kind:'organization',id:'org'},administrators:['admin'],servicePrincipalId:'svc',model:{provider:'local',model:'test'},allowedCapabilities:[],lifecycle:{enabled:true,maxAttempts:2,runTimeoutMs:60000},quotas:{maxConcurrentRuns:1,maxTokensPerRun:100,maxRunsPerDay:10}};
const scope={tenantId:'tenant',agentId:'agent'},installation='11111111-2222-3333-4444-555555555555';
const base={identity:{tenantId:'tenant',principalId:'sender',sourceId:'sentry'},agentId:'agent',installationId:installation,secret:'sentry_client_secret_'+'a'.repeat(24)};
const sign=(key,data)=>createHmac('sha256',key).update(data).digest('hex');
const body=(extra={})=>JSON.stringify({action:'created',installation:{uuid:installation},data:{issue:{id:'42',title:'Boom'}},actor:{type:'application',id:'sentry'},...extra});

test('Sentry webhook verifies the signed body, pins the installation and derives the resource from signed data',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'app-mixer-sentry-')),path=join(dir,'runs.sqlite'),runs=new SqliteAgentRuns(path),triggers=new SqliteAgentTriggers(path),definitions=new SqliteAgentDefinitions(':memory:');definitions.save('tenant',manifest,0);
 const previous='sentry_client_secret_'+'b'.repeat(24),adapter=createSentryWebhookAdapter({...base,previousSecrets:[previous]});let seen=0;
 const ingress=createAgentEventIngress({triggers,definitions,maxPending:3,...adapter,authorize:(identity,event)=>{seen++;return identity.sourceId==='sentry'&&event.eventType==='sentry.issue.created'&&event.payload.data.issue.id==='42';}});ingress.listen(0,'127.0.0.1');await once(ingress,'listening');
 try{
  const url=`http://127.0.0.1:${ingress.address().port}/events`,post=(payload,signature,extra={})=>fetch(url,{method:'POST',headers:{'content-type':'application/json','sentry-hook-signature':signature,...extra},body:payload});
  const first=body();let response=await post(first,sign(previous,first),{'sentry-hook-resource':'comment','request-id':'one'});assert.equal(response.status,202);const accepted=await response.json();
  // Different unsigned metadata and the current secret still deduplicate on the body hash.
  response=await post(first,sign(base.secret,first),{'sentry-hook-resource':'installation','request-id':'two'});assert.equal(response.status,200);assert.equal((await response.json()).runId,accepted.runId);
  assert.equal((await post(first+' ',sign(base.secret,first))).status,401);
  assert.equal((await post(first,sign('sentry_client_secret_'+'c'.repeat(24),first))).status,401);
  // A validly signed body for another installation, or with no installation, is unauthenticated.
  for(const other of [body({installation:{uuid:'99999999-2222-3333-4444-555555555555'}}),body({installation:undefined}),body({installation:'x'})])assert.equal((await post(other,sign(base.secret,other))).status,401);
  const denied=body({data:{issue:{id:'43'}}});assert.equal((await post(denied,sign(base.secret,denied))).status,403);
  assert.equal((await post('[]',sign(base.secret,'[]'))).status,401);
  for(const malformed of [body({data:{}}),body({data:{issue:{},comment:{}}}),body({action:'Created'}),body({data:[]}),body({data:{'Bad Key':{}}})])assert.equal((await post(malformed,sign(base.secret,malformed))).status,400,malformed);
  assert.equal(seen,3);assert.equal(runs.list(scope).length,1);assert.match(triggers.get(scope,accepted.runId).eventId,/^sha256:[0-9a-f]{64}$/);
  const good=sign(base.secret,first);
  assert.equal(adapter.authenticateRaw({rawHeaders:['Sentry-Hook-Signature',good,'sentry-hook-signature',good]},Buffer.from(first)),undefined);
  assert.equal(adapter.authenticateRaw({rawHeaders:['sentry-hook-signature',good.toUpperCase()]},Buffer.from(first)),undefined);
  assert.equal(adapter.authenticateRaw({rawHeaders:['sentry-hook-signature',good.slice(1)]},Buffer.from(first)),undefined);
  assert.equal(adapter.authenticateRaw({rawHeaders:[]},Buffer.from(first)),undefined);
 }finally{await new Promise(r=>ingress.close(r));definitions.close();triggers.close();runs.close();rmSync(dir,{recursive:true,force:true});}
});

test('Sentry webhook adapter rejects invalid configuration',()=>{
 for(const bad of [{...base,secret:'short'},{...base,installationId:'bad id!'},{...base,identity:{...base.identity,sourceId:'schedule.fake'}},{...base,previousSecrets:[base.secret]},{...base,previousSecrets:['x'.repeat(20),'y'.repeat(20),'z'.repeat(20)]}])assert.throws(()=>createSentryWebhookAdapter(bad),/configuration/);
 const mapped=createSentryWebhookAdapter(base).mapAuthenticatedBody(Buffer.from(body({action:'resolved',data:{error:{id:'1'}}})));assert.equal(mapped.eventType,'sentry.error.resolved');
});
