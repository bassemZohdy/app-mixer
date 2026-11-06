import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {createHmac} from 'node:crypto';
import {SqliteAgentRuns,SqliteAgentTriggers,SqliteAgentDefinitions,createAgentEventIngress,createPaddleWebhookAdapter} from '../dist/index.js';

const manifest={manifestVersion:1,tenantId:'tenant',agentId:'agent',name:'Agent',owner:{kind:'organization',id:'org'},administrators:['admin'],servicePrincipalId:'svc',model:{provider:'local',model:'test'},allowedCapabilities:[],lifecycle:{enabled:true,maxAttempts:2,runTimeoutMs:60000},quotas:{maxConcurrentRuns:1,maxTokensPerRun:100,maxRunsPerDay:10}};
const scope={tenantId:'tenant',agentId:'agent'},now=1_700_000_000_000,seconds=now/1000;
const base={identity:{tenantId:'tenant',principalId:'sender',sourceId:'paddle'},agentId:'agent',secret:'pdl_ntfset_'+'a'.repeat(32),clock:()=>now};
const sign=(key,ts,data)=>createHmac('sha256',key).update(`${ts}:${data}`).digest('hex');
const header=(ts,...signatures)=>`ts=${ts};`+signatures.map(signature=>`h1=${signature}`).join(';');
const body=(extra={})=>JSON.stringify({event_id:'evt_01hv8x',event_type:'subscription.created',occurred_at:'2026-01-01T00:00:00Z',notification_id:'ntf_1',data:{id:'sub_1'},...extra});

test('Paddle webhook verifies ts-bound signatures, rotation and deduplicates by signed event id',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'app-mixer-paddle-')),path=join(dir,'runs.sqlite'),runs=new SqliteAgentRuns(path),triggers=new SqliteAgentTriggers(path),definitions=new SqliteAgentDefinitions(':memory:');definitions.save('tenant',manifest,0);
 const previous='pdl_ntfset_'+'b'.repeat(32),adapter=createPaddleWebhookAdapter({...base,previousSecrets:[previous]});let seen=0;
 const ingress=createAgentEventIngress({triggers,definitions,maxPending:3,...adapter,authorize:(identity,event)=>{seen++;return identity.sourceId==='paddle'&&event.eventType==='paddle.subscription.created'&&event.payload.data.id==='sub_1';}});ingress.listen(0,'127.0.0.1');await once(ingress,'listening');
 try{
  const url=`http://127.0.0.1:${ingress.address().port}/events`,post=(payload,signature)=>fetch(url,{method:'POST',headers:{'content-type':'application/json','paddle-signature':signature},body:payload});
  const first=body();let response=await post(first,header(seconds,sign(previous,seconds,first),sign('x'.repeat(24),seconds,first)));assert.equal(response.status,202);const accepted=await response.json();
  response=await post(first,header(seconds+3,sign(base.secret,seconds+3,first)));assert.equal(response.status,200);assert.equal((await response.json()).runId,accepted.runId);
  assert.equal((await post(first+' ',header(seconds,sign(base.secret,seconds,first)))).status,401);
  // The timestamp is part of the signed string: reusing a signature under another ts fails.
  assert.equal((await post(first,header(seconds+1,sign(base.secret,seconds,first)))).status,401);
  assert.equal((await post(first,header(seconds,sign('pdl_ntfset_'+'c'.repeat(32),seconds,first)))).status,401);
  for(const stamp of [seconds-6,seconds+6])assert.equal((await post(first,header(stamp,sign(base.secret,stamp,first)))).status,401);
  const denied=body({data:{id:'sub_2'},event_id:'evt_other'});assert.equal((await post(denied,header(seconds,sign(base.secret,seconds,denied)))).status,403);
  assert.equal((await post('[]',header(seconds,sign(base.secret,seconds,'[]')))).status,400);
  assert.equal(seen,3);assert.equal(runs.list(scope).length,1);assert.equal(triggers.get(scope,accepted.runId).eventId,'paddle:evt_01hv8x');
  const good=sign(base.secret,seconds,first),req=value=>({rawHeaders:value});
  for(const bad of [[],['Paddle-Signature',header(seconds,good),'paddle-signature',header(seconds,good)],['paddle-signature',`ts=${seconds};ts=${seconds};h1=${good}`],['paddle-signature',`ts=${seconds}`],['paddle-signature',`h1=${good}`],['paddle-signature',`ts=${seconds};h1=${good.toUpperCase()}`],['paddle-signature',`ts=${seconds};h1=${good};extra=1`],['paddle-signature',`ts=${seconds};h1=${good};`],['paddle-signature',`ts=-1;h1=${good}`],['paddle-signature',`ts=01;h1=${good}`],['paddle-signature',`ts=${seconds};`+[good,good,good,good].map(value=>`h1=${value}`).join(';')]])assert.equal(adapter.authenticateRaw(req(bad),Buffer.from(first)),undefined,JSON.stringify(bad).slice(0,80));
  // Exactly at the tolerance is accepted.
  assert.ok(adapter.authenticateRaw(req(['paddle-signature',header(seconds-5,sign(base.secret,seconds-5,first))]),Buffer.from(first)));
 }finally{await new Promise(r=>ingress.close(r));definitions.close();triggers.close();runs.close();rmSync(dir,{recursive:true,force:true});}
});

test('Paddle webhook adapter rejects invalid configuration and payloads',()=>{
 for(const bad of [{...base,secret:'short'},{...base,identity:{...base.identity,sourceId:'schedule.fake'}},{...base,previousSecrets:[base.secret]},{...base,previousSecrets:['x'.repeat(20),'y'.repeat(20),'z'.repeat(20)]},{...base,toleranceSeconds:0},{...base,toleranceSeconds:3601},{...base,clock:1}])assert.throws(()=>createPaddleWebhookAdapter(bad),/configuration/);
 const adapter=createPaddleWebhookAdapter(base);
 for(const bad of [Buffer.from([255]),Buffer.from('null'),Buffer.from('[]'),Buffer.from('{}'),Buffer.from(body({event_id:'bad id'})),Buffer.from(body({event_type:'Subscription.Created'})),Buffer.from(body({event_type:5})),Buffer.from(body({event_type:'a.b.c.d.e'}))])assert.throws(()=>adapter.mapAuthenticatedBody(bad));
 const mapped=adapter.mapAuthenticatedBody(Buffer.from(body({event_type:'transaction.payment_failed'})));assert.equal(mapped.eventType,'paddle.transaction.payment_failed');assert.equal(mapped.eventId,'paddle:evt_01hv8x');
});
