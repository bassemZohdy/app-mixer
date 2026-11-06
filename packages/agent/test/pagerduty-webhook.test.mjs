import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {createHmac} from 'node:crypto';
import {SqliteAgentRuns,SqliteAgentTriggers,SqliteAgentDefinitions,createAgentEventIngress,createPagerDutyWebhookAdapter} from '../dist/index.js';

const manifest={manifestVersion:1,tenantId:'tenant',agentId:'agent',name:'Agent',owner:{kind:'organization',id:'org'},administrators:['admin'],servicePrincipalId:'svc',model:{provider:'local',model:'test'},allowedCapabilities:[],lifecycle:{enabled:true,maxAttempts:2,runTimeoutMs:60000},quotas:{maxConcurrentRuns:1,maxTokensPerRun:100,maxRunsPerDay:10}};
const scope={tenantId:'tenant',agentId:'agent'};
const base={identity:{tenantId:'tenant',principalId:'sender',sourceId:'pagerduty'},agentId:'agent',secret:'pd_whsec_'+'a'.repeat(32)};
const sign=(key,data)=>'v1='+createHmac('sha256',key).update(data).digest('hex');
const body=(extra={})=>JSON.stringify({event:{id:'01ABCDEF',event_type:'incident.triggered',resource_type:'incident',occurred_at:'2026-01-01T00:00:00Z',data:{id:'P1'},...extra}});

test('PagerDuty webhook verifies any listed signature, rotation and deduplicates by signed event id',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'app-mixer-pd-')),path=join(dir,'runs.sqlite'),runs=new SqliteAgentRuns(path),triggers=new SqliteAgentTriggers(path),definitions=new SqliteAgentDefinitions(':memory:');definitions.save('tenant',manifest,0);
 const previous='pd_whsec_'+'b'.repeat(32),adapter=createPagerDutyWebhookAdapter({...base,previousSecrets:[previous]});let seen=0;
 const ingress=createAgentEventIngress({triggers,definitions,maxPending:3,...adapter,authorize:(identity,event)=>{seen++;return identity.sourceId==='pagerduty'&&event.eventType==='pagerduty.incident.triggered'&&event.payload.event.data.id==='P1';}});ingress.listen(0,'127.0.0.1');await once(ingress,'listening');
 try{
  const url=`http://127.0.0.1:${ingress.address().port}/events`,post=(payload,signature,extra={})=>fetch(url,{method:'POST',headers:{'content-type':'application/json','x-pagerduty-signature':signature,...extra},body:payload});
  const first=body();let response=await post(first,sign(previous,first)+','+sign('unrelated-secret-unrelated',first),{'x-webhook-subscription':'one'});assert.equal(response.status,202);const accepted=await response.json();
  // A redelivery with different unsigned metadata and a different valid signature still deduplicates on the signed event id.
  response=await post(first,sign(base.secret,first),{'x-webhook-subscription':'two'});assert.equal(response.status,200);assert.equal((await response.json()).runId,accepted.runId);
  assert.equal((await post(first+' ',sign(base.secret,first))).status,401);
  assert.equal((await post(first,sign('pd_whsec_'+'c'.repeat(32),first))).status,401);
  const denied=body({data:{id:'P2'},id:'01ZZZ'});assert.equal((await post(denied,sign(base.secret,denied))).status,403);
  assert.equal((await post('[]',sign(base.secret,'[]'))).status,400);
  assert.equal(seen,3);assert.equal(runs.list(scope).length,1);assert.equal(triggers.get(scope,accepted.runId).eventId,'pagerduty:01ABCDEF');
  const good=sign(base.secret,first);
  assert.equal(adapter.authenticateRaw({rawHeaders:['X-PagerDuty-Signature',good,'x-pagerduty-signature',good]},Buffer.from(first)),undefined);
  assert.equal(adapter.authenticateRaw({rawHeaders:['x-pagerduty-signature',good.toUpperCase()]},Buffer.from(first)),undefined);
  assert.equal(adapter.authenticateRaw({rawHeaders:['x-pagerduty-signature',[good,good,good,good,good].join(',')]},Buffer.from(first)),undefined);
  assert.equal(adapter.authenticateRaw({rawHeaders:['x-pagerduty-signature',good+',']},Buffer.from(first)),undefined);
  assert.equal(adapter.authenticateRaw({rawHeaders:[]},Buffer.from(first)),undefined);
 }finally{await new Promise(r=>ingress.close(r));definitions.close();triggers.close();runs.close();rmSync(dir,{recursive:true,force:true});}
});

test('PagerDuty webhook adapter rejects invalid configuration and payloads',()=>{
 for(const bad of [{...base,secret:'short'},{...base,identity:{...base.identity,sourceId:'schedule.fake'}},{...base,previousSecrets:[base.secret]},{...base,previousSecrets:['x'.repeat(20),'y'.repeat(20),'z'.repeat(20)]}])assert.throws(()=>createPagerDutyWebhookAdapter(bad),/configuration/);
 const adapter=createPagerDutyWebhookAdapter(base);
 for(const bad of [Buffer.from([255]),Buffer.from('null'),Buffer.from('{}'),Buffer.from('{"event":[]}'),Buffer.from(body({id:'bad id'})),Buffer.from(body({event_type:'Incident.Triggered'})),Buffer.from(body({event_type:5}))])assert.throws(()=>adapter.mapAuthenticatedBody(bad));
 const mapped=adapter.mapAuthenticatedBody(Buffer.from(body({event_type:'service.updated'})));assert.equal(mapped.eventType,'pagerduty.service.updated');assert.equal(mapped.eventId,'pagerduty:01ABCDEF');
});
