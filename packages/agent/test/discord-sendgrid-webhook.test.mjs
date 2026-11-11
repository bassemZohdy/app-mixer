// SendGrid Event Webhook (ECDSA P-256) through the real ingress.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {generateKeyPairSync,sign} from 'node:crypto';
import {SqliteAgentRuns,SqliteAgentTriggers,SqliteAgentDefinitions,createAgentEventIngress,createSendGridWebhookAdapter} from '../dist/index.js';

const manifest={manifestVersion:1,tenantId:'tenant',agentId:'agent',name:'Agent',owner:{kind:'organization',id:'org'},administrators:['admin'],servicePrincipalId:'svc',model:{provider:'local',model:'test'},allowedCapabilities:[],lifecycle:{enabled:true,maxAttempts:2,runTimeoutMs:60000},quotas:{maxConcurrentRuns:1,maxTokensPerRun:100,maxRunsPerDay:10}};
const scope={tenantId:'tenant',agentId:'agent'},now=1_700_000_000_000,stamp=String(now/1000);
async function serve(adapter,authorize){
 const dir=mkdtempSync(join(tmpdir(),'app-mixer-webhook-')),path=join(dir,'runs.sqlite'),runs=new SqliteAgentRuns(path),triggers=new SqliteAgentTriggers(path),definitions=new SqliteAgentDefinitions(':memory:');definitions.save('tenant',manifest,0);
 const ingress=createAgentEventIngress({triggers,definitions,maxPending:5,...adapter,authorize});ingress.listen(0,'127.0.0.1');await once(ingress,'listening');
 return {runs,triggers,url:`http://127.0.0.1:${ingress.address().port}/events`,close:async()=>{await new Promise(resolve=>ingress.close(resolve));definitions.close();triggers.close();runs.close();rmSync(dir,{recursive:true,force:true});}};
}

const sendgridKeys=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),sendgridNext=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),sendgridOther=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const spki=pair=>pair.publicKey.export({type:'spki',format:'der'}).toString('base64');
const sendgrid={identity:{tenantId:'tenant',principalId:'sendgrid',sourceId:'sendgrid'},agentId:'agent',verificationKey:spki(sendgridNext),previousVerificationKeys:[spki(sendgridKeys)],clock:()=>now};
const batch=(extra=[])=>JSON.stringify([{email:'a@example.test',event:'delivered',sg_event_id:'evt-1',timestamp:now/1000},{email:'b@example.test',event:'bounce',sg_event_id:'evt-2',timestamp:now/1000},...extra]);
const sendgridSign=(body,keys=sendgridNext,timestamp=stamp)=>sign('sha256',Buffer.from(timestamp+body),keys.privateKey).toString('base64');

test('SendGrid event batches verify the ECDSA signature, timestamp and key rotation',async()=>{
 const adapter=createSendGridWebhookAdapter(sendgrid),server=await serve(adapter,(identity,event)=>identity.sourceId==='sendgrid'&&event.eventType==='sendgrid.events'&&event.payload.events.length>=2);
 try{
  const post=(body,signature,timestamp=stamp)=>fetch(server.url,{method:'POST',headers:{'content-type':'application/json','x-twilio-email-event-webhook-signature':signature,'x-twilio-email-event-webhook-timestamp':timestamp},body});
  const body=batch();let response=await post(body,sendgridSign(body,sendgridKeys));assert.equal(response.status,202,'the previous key still verifies during rotation');const first=await response.json();
  response=await post(body,sendgridSign(body));assert.equal(response.status,200);assert.equal((await response.json()).runId,first.runId,'a redelivered batch is the same event');
  assert.match(server.triggers.get(scope,first.runId).eventId,/^sha256:[0-9a-f]{64}$/);
  assert.equal((await post(body.replace('bounce','open'),sendgridSign(body))).status,401,'the body is signed');
  assert.equal((await post(body,sendgridSign(body,sendgridOther))).status,401,'an unknown key');
  const late=String(now/1000-301);assert.equal((await post(body,sendgridSign(body,sendgridNext,late),late)).status,401);
  assert.equal((await post('{"event":"x"}',sendgridSign('{"event":"x"}'))).status,401,'a batch must be an array of events');
  const denied=JSON.stringify([{email:'c@example.test',event:'open',sg_event_id:'evt-3'}]);assert.equal((await post(denied,sendgridSign(denied))).status,403);
  assert.equal(server.runs.list(scope).length,1);
  assert.deepEqual(adapter.mapAuthenticatedBody(Buffer.from(body)).payload.events.map(event=>event.event),['delivered','bounce']);
 }finally{await server.close();}
 for(const bad of [{...sendgrid,verificationKey:'not-a-key'},{...sendgrid,verificationKey:spki(generateKeyPairSync('ed25519'))},{...sendgrid,previousVerificationKeys:[sendgrid.verificationKey]},{...sendgrid,toleranceSeconds:3601}])assert.throws(()=>createSendGridWebhookAdapter(bad),/configuration/);
});
