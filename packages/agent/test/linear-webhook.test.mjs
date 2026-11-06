import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {createHmac} from 'node:crypto';
import {SqliteAgentRuns,SqliteAgentTriggers,SqliteAgentDefinitions,createAgentEventIngress,createLinearWebhookAdapter} from '../dist/index.js';

const manifest={manifestVersion:1,tenantId:'tenant',agentId:'agent',name:'Agent',owner:{kind:'organization',id:'org'},administrators:['admin'],servicePrincipalId:'svc',model:{provider:'local',model:'test'},allowedCapabilities:[],lifecycle:{enabled:true,maxAttempts:2,runTimeoutMs:60000},quotas:{maxConcurrentRuns:1,maxTokensPerRun:100,maxRunsPerDay:10}};
const scope={tenantId:'tenant',agentId:'agent'},org='11111111-2222-3333-4444-555555555555',now=1_700_000_000_000;
const base={identity:{tenantId:'tenant',principalId:'sender',sourceId:'linear'},agentId:'agent',organizationId:org,secret:'lin_wh_'+'a'.repeat(32),clock:()=>now};
const sign=(key,data)=>createHmac('sha256',key).update(data).digest('hex');
const payload=(extra={})=>JSON.stringify({action:'create',type:'Issue',organizationId:org,webhookTimestamp:now,data:{id:'issue-1'},...extra});

test('Linear webhook verifies the signed body, rotation, replay window and workspace',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'app-mixer-linear-')),path=join(dir,'runs.sqlite'),runs=new SqliteAgentRuns(path),triggers=new SqliteAgentTriggers(path),definitions=new SqliteAgentDefinitions(':memory:');definitions.save('tenant',manifest,0);
 const previous='lin_wh_'+'b'.repeat(32),adapter=createLinearWebhookAdapter({...base,previousSecrets:[previous]});let seen=0;
 const ingress=createAgentEventIngress({triggers,definitions,maxPending:3,...adapter,authorize:(identity,event)=>{seen++;return identity.sourceId==='linear'&&event.eventType==='linear.Issue.create'&&event.payload.data.id==='issue-1';}});ingress.listen(0,'127.0.0.1');await once(ingress,'listening');
 try{
  const url=`http://127.0.0.1:${ingress.address().port}/events`,post=(body,signature,extra={})=>fetch(url,{method:'POST',headers:{'content-type':'application/json','linear-signature':signature,...extra},body});
  const body=payload();let response=await post(body,sign(previous,body),{'linear-delivery':'one'});assert.equal(response.status,202);const first=await response.json();
  response=await post(body,sign(base.secret,body),{'linear-delivery':'retry'});assert.equal(response.status,200);assert.equal((await response.json()).runId,first.runId);
  assert.equal((await post(body+' ',sign(base.secret,body))).status,401);
  assert.equal((await post(body,sign('lin_wh_'+'c'.repeat(32),body))).status,401);
  const stale=payload({webhookTimestamp:now-61_000}),future=payload({webhookTimestamp:now+61_000}),other=payload({organizationId:'99999999-2222-3333-4444-555555555555'}),missing=payload({webhookTimestamp:undefined});
  for(const bad of [stale,future,other,missing])assert.equal((await post(bad,sign(base.secret,bad))).status,401);
  const denied=payload({data:{id:'issue-2'}});assert.equal((await post(denied,sign(base.secret,denied))).status,403);
  assert.equal(seen,3);assert.equal(runs.list(scope).length,1);assert.match(triggers.get(scope,first.runId).eventId,/^sha256:[0-9a-f]{64}$/);
  const signature=sign(base.secret,body);
  assert.equal(adapter.authenticateRaw({rawHeaders:['Linear-Signature',signature,'linear-signature',signature]},Buffer.from(body)),undefined);
  assert.equal(adapter.authenticateRaw({rawHeaders:['linear-signature',signature.toUpperCase()]},Buffer.from(body)),undefined);
  assert.equal(adapter.authenticateRaw({rawHeaders:[]},Buffer.from(body)),undefined);
  // Boundary: exactly at the tolerance is accepted.
  const edge=payload({webhookTimestamp:now-60_000});assert.ok(adapter.authenticateRaw({rawHeaders:['linear-signature',sign(base.secret,edge)]},Buffer.from(edge)));
 }finally{await new Promise(r=>ingress.close(r));definitions.close();triggers.close();runs.close();rmSync(dir,{recursive:true,force:true});}
});

test('Linear webhook adapter rejects invalid configuration and payloads',()=>{
 for(const bad of [{...base,secret:'short'},{...base,organizationId:'bad id!'},{...base,identity:{...base.identity,sourceId:'schedule.fake'}},{...base,previousSecrets:[base.secret]},{...base,previousSecrets:['x'.repeat(20),'y'.repeat(20),'z'.repeat(20)]},{...base,toleranceSeconds:0},{...base,toleranceSeconds:3601},{...base,clock:1}])assert.throws(()=>createLinearWebhookAdapter(bad),/configuration/);
 const adapter=createLinearWebhookAdapter(base);
 for(const bad of [Buffer.from([255]),Buffer.from('null'),Buffer.from('[]'),Buffer.from('{"type":"Issue"}'),Buffer.from('{"type":"Bad Type","action":"create"}'),Buffer.from('{"type":"Issue","action":"Create"}')])assert.throws(()=>adapter.mapAuthenticatedBody(bad));
 const mapped=adapter.mapAuthenticatedBody(Buffer.from(payload({type:'IssueLabel',action:'remove'})));assert.equal(mapped.eventType,'linear.IssueLabel.remove');assert.equal(mapped.agentId,'agent');
 assert.equal(adapter.authenticateRaw({rawHeaders:['linear-signature','x']},Buffer.from('{}')),undefined);
});
