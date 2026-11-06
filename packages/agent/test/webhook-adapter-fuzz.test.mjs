import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createLinearWebhookAdapter,createPagerDutyWebhookAdapter,createPaddleWebhookAdapter,createSentryWebhookAdapter,createShopifyWebhookAdapter,createSlackWebhookAdapter,createGithubWebhookAdapter,createGitlabWebhookAdapter,createStripeWebhookAdapter,createStandardWebhookAdapter,createTwilioMessageWebhookAdapter} from '../dist/index.js';

const identity={tenantId:'tenant',principalId:'sender',sourceId:'source'},secret='s'.repeat(32),now=1_700_000_000_000;
const adapters={
 linear:{adapter:createLinearWebhookAdapter({identity,agentId:'agent',organizationId:'11111111-2222-3333-4444-555555555555',secret,clock:()=>now}),header:'linear-signature'},
 pagerduty:{adapter:createPagerDutyWebhookAdapter({identity,agentId:'agent',secret}),header:'x-pagerduty-signature'},
 paddle:{adapter:createPaddleWebhookAdapter({identity,agentId:'agent',secret,clock:()=>now}),header:'paddle-signature'},
 sentry:{adapter:createSentryWebhookAdapter({identity,agentId:'agent',installationId:'11111111-2222-3333-4444-555555555555',secret}),header:'sentry-hook-signature'},
 shopify:{adapter:createShopifyWebhookAdapter({identity,agentId:'agent',eventType:'shopify.webhook',secret:Buffer.from(secret)}),header:'x-shopify-hmac-sha256'},
 slack:{adapter:createSlackWebhookAdapter({identity,agentId:'agent',appId:'A123',teamId:'T123',secret,clock:()=>now}),header:'x-slack-signature',extra:[['x-slack-request-timestamp',String(now/1000)]]},
 github:{adapter:createGithubWebhookAdapter({identity,agentId:'agent',eventType:'github.webhook',secret:Buffer.alloc(32,7)}),header:'x-hub-signature-256'},
 gitlab:{adapter:createGitlabWebhookAdapter({identity,agentId:'agent',eventType:'gitlab.push',signingToken:'whsec_'+Buffer.alloc(32,5).toString('base64'),clock:()=>now}),header:'webhook-signature',extra:[['webhook-id','msg_1'],['webhook-timestamp',String(now/1000)]]},
 stripe:{adapter:createStripeWebhookAdapter({identity,agentId:'agent',secret:'whsec_'+'a'.repeat(32),clock:()=>now}),header:'stripe-signature'},
 standard:{adapter:createStandardWebhookAdapter({identity,agentId:'agent',secret:'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',clock:()=>now}),header:'webhook-signature',extra:[['webhook-id','msg_1'],['webhook-timestamp',String(now/1000)]]},
 twilio:{adapter:createTwilioMessageWebhookAdapter({identity,agentId:'agent',accountSid:'AC'+'a'.repeat(32),url:'https://example.test/events',authToken:'b'.repeat(32)}),header:'x-twilio-signature'}
};
function rng(seed){return()=>{seed=(seed*1664525+1013904223)>>>0;return seed/2**32;};}
const text=(random,max)=>Array.from({length:Math.floor(random()*max)},()=>String.fromCharCode(Math.floor(random()*256))).join('');
const pick=(random,list)=>list[Math.floor(random()*list.length)];

test('no webhook adapter ever throws from authenticateRaw on hostile headers and bodies',()=>{
 const random=rng(424242);let checked=0;
 const bodies=[Buffer.alloc(0),Buffer.from('{}'),Buffer.from('[]'),Buffer.from('null'),Buffer.from([255,254,0]),Buffer.from('{"installation":'),Buffer.from('{"webhookTimestamp":1e999}'),Buffer.from(JSON.stringify({a:'x'.repeat(100000)}))];
 for(const [name,{adapter,header,extra}] of Object.entries(adapters)){
  for(let i=0;i<1500;i++){
   const body=random()<0.5?pick(random,bodies):Buffer.from(text(random,200),'latin1');
   const good=createHmac('sha256',secret).update(body).digest(random()<0.5?'hex':'base64');
   const value=pick(random,[text(random,120),good,good.toUpperCase(),'v0='+good,`ts=${now/1000};h1=${good}`,good+','+good,'',' ',good.slice(1),'sha256='+good,`ts=${now/1000};h1=${'0'.repeat(64)}`]);
   const raw=[];const copies=random()<0.2?2:1;for(let c=0;c<copies;c++)raw.push(random()<0.3?header.toUpperCase():header,value);
   for(const pair of extra??[])if(random()<0.8)raw.push(pair[0],random()<0.7?pair[1]:text(random,20));
   if(random()<0.1)raw.push('authorization',text(random,50));
   let result;
   assert.doesNotThrow(()=>{result=adapter.authenticateRaw({rawHeaders:raw},body);},`${name} threw for headers ${JSON.stringify(raw).slice(0,200)}`);
   assert.ok(result===undefined||(result&&result.tenantId==='tenant'&&result.sourceId==='source'),`${name} returned an unexpected value`);
   checked++;
  }
 }
 assert.equal(checked,Object.keys(adapters).length*1500);
});

test('mapAuthenticatedBody throws an Error (never another value) for hostile bodies',()=>{
 const random=rng(99);
 for(const [name,{adapter}] of Object.entries(adapters)){
  if(typeof adapter.mapAuthenticatedBody!=='function')continue;
  for(let i=0;i<500;i++){
   const body=Buffer.from(random()<0.5?text(random,150):JSON.stringify({[text(random,6)]:text(random,12),type:text(random,5),action:text(random,5),event:{id:text(random,4),event_type:text(random,6)},event_id:text(random,6),event_type:text(random,6),data:random()<0.5?[]:{[text(random,4)]:{}}}),'latin1');
   try{const mapped=adapter.mapAuthenticatedBody(body);assert.equal(typeof mapped.eventType,'string');assert.equal(typeof mapped.eventId,'string');assert.equal(mapped.agentId,'agent');}
   catch(error){assert.ok(error instanceof Error,`${name} threw a non-Error`);}
  }
 }
});
