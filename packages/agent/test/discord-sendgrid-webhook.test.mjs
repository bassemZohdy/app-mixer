// Discord interactions (Ed25519) and SendGrid Event Webhook (ECDSA P-256): the two asymmetric-signature providers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {generateKeyPairSync,sign} from 'node:crypto';
import {SqliteAgentRuns,SqliteAgentTriggers,SqliteAgentDefinitions,createAgentEventIngress,createDiscordWebhookAdapter,createSendGridWebhookAdapter} from '../dist/index.js';

const manifest={manifestVersion:1,tenantId:'tenant',agentId:'agent',name:'Agent',owner:{kind:'organization',id:'org'},administrators:['admin'],servicePrincipalId:'svc',model:{provider:'local',model:'test'},allowedCapabilities:[],lifecycle:{enabled:true,maxAttempts:2,runTimeoutMs:60000},quotas:{maxConcurrentRuns:1,maxTokensPerRun:100,maxRunsPerDay:10}};
const scope={tenantId:'tenant',agentId:'agent'},now=1_700_000_000_000,stamp=String(now/1000);
async function serve(adapter,authorize){
 const dir=mkdtempSync(join(tmpdir(),'app-mixer-webhook-')),path=join(dir,'runs.sqlite'),runs=new SqliteAgentRuns(path),triggers=new SqliteAgentTriggers(path),definitions=new SqliteAgentDefinitions(':memory:');definitions.save('tenant',manifest,0);
 const ingress=createAgentEventIngress({triggers,definitions,maxPending:5,...adapter,authorize});ingress.listen(0,'127.0.0.1');await once(ingress,'listening');
 return {runs,triggers,url:`http://127.0.0.1:${ingress.address().port}/events`,close:async()=>{await new Promise(resolve=>ingress.close(resolve));definitions.close();triggers.close();runs.close();rmSync(dir,{recursive:true,force:true});}};
}

const discordKeys=generateKeyPairSync('ed25519'),discordOther=generateKeyPairSync('ed25519');
const hexKey=pair=>Buffer.from(pair.publicKey.export({format:'jwk'}).x,'base64url').toString('hex');
const discord={identity:{tenantId:'tenant',principalId:'discord',sourceId:'discord'},agentId:'agent',applicationId:'123456789012345678',publicKey:hexKey(discordKeys),clock:()=>now};
const interaction=(extra={})=>JSON.stringify({id:'987654321098765432',application_id:discord.applicationId,type:2,data:{name:'triage'},...extra});
const discordSign=(body,keys=discordKeys,timestamp=stamp)=>sign(null,Buffer.from(timestamp+body),keys.privateKey).toString('hex');

test('Discord interactions verify the Ed25519 signature, timestamp and application',async()=>{
 const adapter=createDiscordWebhookAdapter(discord),server=await serve(adapter,(identity,event)=>identity.sourceId==='discord'&&event.eventType.startsWith('discord.'));
 try{
  const post=(body,signature,timestamp=stamp)=>fetch(server.url,{method:'POST',headers:{'content-type':'application/json','x-signature-ed25519':signature,'x-signature-timestamp':timestamp},body});
  const body=interaction();let response=await post(body,discordSign(body));assert.equal(response.status,202);const first=await response.json();
  response=await post(body,discordSign(body));assert.equal(response.status,200);assert.equal((await response.json()).runId,first.runId,'a redelivered interaction is the same event');
  assert.equal(server.triggers.get(scope,first.runId).eventId,'discord:987654321098765432');
  assert.equal((await post(body+' ',discordSign(body))).status,401,'the body is signed');
  assert.equal((await post(body,discordSign(body,discordOther))).status,401,'another application key');
  const late=String(now/1000-301);assert.equal((await post(body,discordSign(body,discordKeys,late),late)).status,401,'outside the replay window');
  assert.equal((await post(body,discordSign(body),String(now/1000+1))).status,401,'the timestamp is signed');
  const foreign=interaction({application_id:'223456789012345678'});assert.equal((await post(foreign,discordSign(foreign))).status,401,'another application');
  assert.equal(server.runs.list(scope).length,1);
  const ping=adapter.mapAuthenticatedBody(Buffer.from(interaction({type:1,data:undefined})));assert.equal(ping.eventType,'discord.ping');
  assert.equal(adapter.mapAuthenticatedBody(Buffer.from(interaction({type:3,data:{custom_id:'x'}}))).eventType,'discord.component');
  for(const bad of [interaction({type:9}),interaction({id:'abc'}),interaction({data:{name:'bad name'}}),'[]'])assert.throws(()=>adapter.mapAuthenticatedBody(Buffer.from(bad)));
  const signature=discordSign(body);
  assert.equal(adapter.authenticateRaw({rawHeaders:['x-signature-ed25519',signature,'X-Signature-Ed25519',signature,'x-signature-timestamp',stamp]},Buffer.from(body)),undefined,'duplicate headers');
  assert.equal(adapter.authenticateRaw({rawHeaders:['x-signature-ed25519',signature.toUpperCase(),'x-signature-timestamp',stamp]},Buffer.from(body)),undefined);
 }finally{await server.close();}
 for(const bad of [{...discord,publicKey:'zz'},{...discord,applicationId:'app'},{...discord,toleranceSeconds:0},{...discord,identity:{...discord.identity,sourceId:'schedule.x'}}])assert.throws(()=>createDiscordWebhookAdapter(bad),/configuration/);
});

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
 for(const bad of [{...sendgrid,verificationKey:'not-a-key'},{...sendgrid,verificationKey:spki(discordKeys)},{...sendgrid,previousVerificationKeys:[sendgrid.verificationKey]},{...sendgrid,toleranceSeconds:3601}])assert.throws(()=>createSendGridWebhookAdapter(bad),/configuration/);
});
