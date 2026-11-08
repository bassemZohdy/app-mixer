// Boundary and rejection tests for the webhook signature adapters (generic signed, GitHub, Stripe, Slack, Standard Webhooks).
// A mutation run (scripts/mutate.mjs) changed one operator at a time in each adapter: between 22% and 40% of the changes went
// unnoticed, among them the exact edge of the replay window, single malformed headers, single bad options and the strict
// decoding of the body. Every case below fails when its condition is removed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createSignedWebhookAuthenticator,createGithubWebhookAdapter,createStripeWebhookAdapter,createSlackWebhookAdapter,createStandardWebhookAdapter} from '../dist/index.js';

const NOW=1_700_000_000;                                  // seconds
const clock=(seconds=NOW)=>()=>seconds*1000;
const identity={tenantId:'tenant',principalId:'sender',sourceId:'source'};
const headers=(entries)=>({rawHeaders:entries.flat()});
const hmac=(key,...parts)=>{const h=createHmac('sha256',key);for(const part of parts)h.update(part);return h.digest();};
const SECRET='s'.repeat(40),STRIPE='whsec_'+'k'.repeat(40),STANDARD='whsec_'+Buffer.alloc(32,7).toString('base64');
const body=Buffer.from('{"hello":"world"}');
const invalidUtf8=Buffer.from([0x7b,0x22,0x61,0x22,0x3a,0x22,0xff,0xfe,0x22,0x7d]);        // {"a":"\xff\xfe"}

// Each scheme: how to build an adapter, how to sign a body at a time, and how to ask it to authenticate.
const schemes={
 signed:{
  create:(o={})=>createSignedWebhookAuthenticator({sources:[{sourceId:'source',tenantId:'tenant',principalId:'sender',secret:Buffer.from(SECRET)}],clock:clock(),...o}),
  authenticate:(adapter,req,b)=>adapter(req,b),
  sign:(ts,b=body)=>({req:headers([['X-App-Mixer-Source','source'],['X-App-Mixer-Timestamp',String(ts)],['X-App-Mixer-Signature','v1='+hmac(Buffer.from(SECRET),`v1\n${ts}\nsource\n`,b).toString('hex')]]),body:b}),
  tolerance:'maxAgeSeconds'
 },
 github:{
  create:(o={})=>createGithubWebhookAdapter({identity,agentId:'agent',eventType:'github.webhook',secret:Buffer.from(SECRET),...o}),
  authenticate:(adapter,req,b)=>adapter.authenticateRaw(req,b),
  sign:(_ts,b=body)=>({req:headers([['X-Hub-Signature-256','sha256='+hmac(Buffer.from(SECRET),b).toString('hex')]]),body:b}),
  noClock:true
 },
 stripe:{
  create:(o={})=>createStripeWebhookAdapter({identity,agentId:'agent',secret:STRIPE,clock:clock(),...o}),
  authenticate:(adapter,req,b)=>adapter.authenticateRaw(req,b),
  sign:(ts,b=body)=>({req:headers([['Stripe-Signature',`t=${ts},v1=${hmac(STRIPE,`${ts}.`,b).toString('hex')}`]]),body:b}),
  tolerance:'toleranceSeconds'
 },
 slack:{
  create:(o={})=>createSlackWebhookAdapter({identity,agentId:'agent',appId:'A1',teamId:'T1',secret:'x'.repeat(32),clock:clock(),...o}),
  authenticate:(adapter,req,b)=>adapter.authenticateRaw(req,b),
  sign:(ts,b=body)=>({req:headers([['X-Slack-Request-Timestamp',String(ts)],['X-Slack-Signature','v0='+hmac('x'.repeat(32),`v0:${ts}:`,b).toString('hex')]]),body:b}),
  tolerance:'toleranceSeconds'
 },
 standard:{
  create:(o={})=>createStandardWebhookAdapter({identity,agentId:'agent',secret:STANDARD,clock:clock(),...o}),
  authenticate:(adapter,req,b)=>adapter.authenticateRaw(req,b),
  sign:(ts,b=body)=>({req:headers([['webhook-id','msg_1'],['webhook-timestamp',String(ts)],['webhook-signature','v1,'+hmac(Buffer.from(STANDARD.slice(6),'base64'),`msg_1.${ts}.`,b).toString('base64')]]),body:b}),
  tolerance:'toleranceSeconds'
 }
};
const withHeader=(request,name,value)=>{const entries=[];for(let i=0;i<request.req.rawHeaders.length;i+=2){if(request.req.rawHeaders[i].toLowerCase()===name.toLowerCase()){if(value!==undefined)entries.push([request.req.rawHeaders[i],value]);}else entries.push([request.req.rawHeaders[i],request.req.rawHeaders[i+1]]);}return {...request,req:headers(entries)};};
const accepted=(scheme,adapter,request)=>scheme.authenticate(adapter,request.req,request.body)!==undefined;

for(const [name,scheme] of Object.entries(schemes)){
 test(`${name}: a correctly signed request is accepted, and a changed body is not`,()=>{
  const adapter=scheme.create(),request=scheme.sign(NOW);
  assert.ok(accepted(scheme,adapter,request));
  assert.equal(scheme.authenticate(adapter,request.req,Buffer.from('{"hello":"w0rld"}')),undefined);
 });
}

for(const [name,scheme] of Object.entries(schemes)){
 if(scheme.noClock)continue;
 test(`${name}: the replay window is exact on both sides`,()=>{
  for(const tolerance of [undefined,30,1]){
   const limit=tolerance??300,adapter=scheme.create(tolerance===undefined?{}:{[scheme.tolerance]:tolerance});
   assert.ok(accepted(scheme,adapter,scheme.sign(NOW-limit)),`${limit} s old`);assert.ok(accepted(scheme,adapter,scheme.sign(NOW+limit)),`${limit} s ahead`);
   assert.ok(accepted(scheme,adapter,scheme.sign(NOW)),'now');
   assert.equal(accepted(scheme,adapter,scheme.sign(NOW-limit-1)),false,`${limit+1} s old`);assert.equal(accepted(scheme,adapter,scheme.sign(NOW+limit+1)),false,`${limit+1} s ahead`);
  }
  // The clock must give a non-negative whole number of milliseconds.
  for(const bad of [()=>-1,()=>1.5,()=>NaN,()=>'now',()=>Infinity])assert.equal(accepted(scheme,scheme.create({clock:bad}),scheme.sign(NOW)),false,String(bad()));
  assert.ok(accepted(scheme,scheme.create({clock:()=>0}),scheme.sign(0)),'time zero is a valid time');
 });
}

test('signed: header strictness, sources and secrets',()=>{
 const scheme=schemes.signed,adapter=scheme.create(),request=scheme.sign(NOW);
 for(const header of ['X-App-Mixer-Source','X-App-Mixer-Timestamp','X-App-Mixer-Signature'])assert.equal(accepted(scheme,adapter,withHeader(request,header,undefined)),false,'missing '+header);
 for(const [header,value] of [['X-App-Mixer-Source','other'],['X-App-Mixer-Timestamp','0'+NOW],['X-App-Mixer-Timestamp','-'+NOW],['X-App-Mixer-Timestamp',NOW+'.0'],['X-App-Mixer-Timestamp',' '+NOW],['X-App-Mixer-Timestamp','1'.repeat(14)],['X-App-Mixer-Signature','V1='+'a'.repeat(64)],['X-App-Mixer-Signature','v1='+'A'.repeat(64)],['X-App-Mixer-Signature','v1='+'a'.repeat(63)],['X-App-Mixer-Signature','v1='+'a'.repeat(65)],['X-App-Mixer-Signature','v2='+'a'.repeat(64)]])assert.equal(accepted(scheme,adapter,withHeader(request,header,value)),false,header+' '+value);
 const twice=headers([...request.req.rawHeaders.reduce((a,v,i)=>{if(i%2===0)a.push([v]);else a.at(-1).push(v);return a;},[]),['X-App-Mixer-Timestamp',String(NOW)]]);
 assert.equal(adapter(twice,body),undefined,'a repeated header');
 // A previous secret still works for the same source; a source with a different id does not share secrets.
 const rotated=createSignedWebhookAuthenticator({sources:[{sourceId:'source',tenantId:'tenant',principalId:'sender',secret:Buffer.from('n'.repeat(40)),previousSecrets:[Buffer.from(SECRET)]},{sourceId:'second',tenantId:'t2',principalId:'p2',secret:Buffer.from('m'.repeat(40))}],clock:clock()});
 assert.deepEqual(rotated(request.req,body),{tenantId:'tenant',principalId:'sender',sourceId:'source'});
 const base={sourceId:'source',tenantId:'tenant',principalId:'sender',secret:Buffer.from(SECRET)};
 const invalid=/Invalid webhook configuration/,make=(patch,more={})=>()=>createSignedWebhookAuthenticator({sources:[{...base,...patch}],clock:clock(),...more});
 createSignedWebhookAuthenticator({sources:[{...base,previousSecrets:[Buffer.from('a'.repeat(40)),Buffer.from('b'.repeat(40))]}],clock:clock(),maxAgeSeconds:1});createSignedWebhookAuthenticator({sources:[base],clock:clock(),maxAgeSeconds:3600});
 createSignedWebhookAuthenticator({sources:[{...base,secret:Buffer.alloc(32,1)}]});createSignedWebhookAuthenticator({sources:[{...base,secret:Buffer.alloc(1024,1)}]});
 for(const [label,fn] of Object.entries({
  'no sources':()=>createSignedWebhookAuthenticator({sources:[]}),'sources not an array':()=>createSignedWebhookAuthenticator({sources:'x'}),'no options':()=>createSignedWebhookAuthenticator(undefined),
  'over a thousand sources':()=>createSignedWebhookAuthenticator({sources:Array.from({length:1001},(_,i)=>({...base,sourceId:'s'+i}))}),'clock not a function':make({}, {clock:'now'}),
  'max age 0':make({}, {maxAgeSeconds:0}),'max age over an hour':make({}, {maxAgeSeconds:3601}),'max age fractional':make({}, {maxAgeSeconds:1.5}),
  'source missing':()=>createSignedWebhookAuthenticator({sources:[null]}),'source id invalid':make({sourceId:'a b'}),'source id of a schedule':make({sourceId:'schedule.nightly'}),'tenant invalid':make({tenantId:''}),'principal invalid':make({principalId:''}),
  'duplicate source':()=>createSignedWebhookAuthenticator({sources:[base,base]}),'previous secrets not an array':make({previousSecrets:'x'}),'three previous secrets':make({previousSecrets:['a','b','c'].map(c=>Buffer.from(c.repeat(40)))}),
  'secret not bytes':make({secret:'s'.repeat(40)}),'secret under 32 bytes':make({secret:Buffer.alloc(31,1)}),'secret over 1024 bytes':make({secret:Buffer.alloc(1025,1)}),
  'previous secret under 32 bytes':make({previousSecrets:[Buffer.alloc(31,1)]}),'repeated secret':make({previousSecrets:[Buffer.from(SECRET)]})
 }))assert.throws(fn,invalid,label);
});

test('github: header strictness, secrets and body mapping',()=>{
 const scheme=schemes.github,adapter=scheme.create(),request=scheme.sign(NOW);
 assert.equal(accepted(scheme,adapter,withHeader(request,'X-Hub-Signature-256',undefined)),false,'missing');
 for(const value of ['sha1='+'a'.repeat(64),'sha256='+'A'.repeat(64),'sha256='+'a'.repeat(63),'sha256='+'a'.repeat(65),' sha256='+'a'.repeat(64),'a'.repeat(64)])assert.equal(accepted(scheme,adapter,withHeader(request,'X-Hub-Signature-256',value)),false,value);
 assert.equal(adapter.authenticateRaw({rawHeaders:[...request.req.rawHeaders,...request.req.rawHeaders]},body),undefined,'a repeated header');
 // A previous secret is accepted while it overlaps.
 const rotated=createGithubWebhookAdapter({identity,agentId:'agent',eventType:'github.webhook',secret:Buffer.from('n'.repeat(40)),previousSecrets:[Buffer.from(SECRET)]});
 assert.deepEqual(rotated.authenticateRaw(request.req,body),identity);
 const base={identity,agentId:'agent',eventType:'github.webhook',secret:Buffer.from(SECRET)},invalid=/Invalid GitHub webhook configuration/;
 createGithubWebhookAdapter({...base,secret:Buffer.alloc(32,1)});createGithubWebhookAdapter({...base,secret:Buffer.alloc(1024,1)});createGithubWebhookAdapter({...base,previousSecrets:[Buffer.from('a'.repeat(40)),Buffer.from('b'.repeat(40))]});
 for(const [label,patch] of Object.entries({
  'no identity':{identity:undefined},'tenant invalid':{identity:{...identity,tenantId:''}},'principal invalid':{identity:{...identity,principalId:''}},'source invalid':{identity:{...identity,sourceId:''}},'source of a schedule':{identity:{...identity,sourceId:'schedule.x'}},
  'agent invalid':{agentId:''},'event type invalid':{eventType:''},'secret not bytes':{secret:'s'.repeat(40)},'secret under 32 bytes':{secret:Buffer.alloc(31,1)},'secret over 1024 bytes':{secret:Buffer.alloc(1025,1)},
  'previous secrets not an array':{previousSecrets:'x'},'three previous secrets':{previousSecrets:['a','b','c'].map(c=>Buffer.from(c.repeat(40)))},'previous secret under 32 bytes':{previousSecrets:[Buffer.alloc(31,1)]},'repeated secret':{previousSecrets:[Buffer.from(SECRET)]}
 }))assert.throws(()=>createGithubWebhookAdapter({...base,...patch}),invalid,label);
 assert.throws(()=>createGithubWebhookAdapter(undefined),invalid);
 // The body must be UTF-8 JSON and an object; the event id is the digest of the exact bytes.
 assert.equal(adapter.mapAuthenticatedBody(body).eventType,'github.webhook');assert.match(adapter.mapAuthenticatedBody(body).eventId,/^sha256:[a-f0-9]{64}$/);
 for(const [label,bad] of Object.entries({'invalid UTF-8':invalidUtf8,'an array':Buffer.from('[1]'),'null':Buffer.from('null'),'a number':Buffer.from('7'),'a string':Buffer.from('"x"'),'not JSON':Buffer.from('{')}))assert.throws(()=>adapter.mapAuthenticatedBody(bad),undefined,label);
});

test('stripe: header grammar, limits and event mapping',()=>{
 const scheme=schemes.stripe,adapter=scheme.create(),request=scheme.sign(NOW),good=hmac(STRIPE,`${NOW}.`,body).toString('hex');
 const stripe=value=>({...request,req:headers([['Stripe-Signature',value]])});
 assert.equal(accepted(scheme,adapter,withHeader(request,'Stripe-Signature',undefined)),false,'missing');
 assert.equal(accepted(scheme,adapter,{...request,req:headers([...request.req.rawHeaders.reduce((a,v,i)=>{if(i%2===0)a.push([v]);else a.at(-1).push(v);return a;},[]),['Stripe-Signature',`t=${NOW},v1=${good}`]])}),false,'a repeated header');
 for(const [label,value] of Object.entries({
  'no timestamp':`v1=${good}`,'no signature':`t=${NOW}`,'two timestamps':`t=${NOW},t=${NOW},v1=${good}`,'timestamp with a leading zero':`t=0${NOW},v1=${good}`,'timestamp too long':`t=${'1'.repeat(17)},v1=${good}`,'timestamp not digits':`t=abc,v1=${good}`,
  'uppercase signature':`t=${NOW},v1=${good.toUpperCase()}`,'short signature':`t=${NOW},v1=${good.slice(1)}`,'part without a value':`t=${NOW},v1=${good},x=`,'part without an equals sign':`t=${NOW},v1=${good},junk`,'empty':'','whitespace in a value':`t=${NOW},v1=${good} x`
 }))assert.equal(accepted(scheme,adapter,stripe(value)),false,label);
 assert.ok(accepted(scheme,adapter,stripe(` t=${NOW} , v1=${good} `)),'surrounding spaces are allowed');
 assert.ok(accepted(scheme,adapter,stripe(`t=${NOW},v0=${'0'.repeat(64)},v1=${good}`)),'other schemes are ignored');
 assert.ok(accepted(scheme,adapter,stripe(`t=${NOW},v1=${'0'.repeat(64)},v1=${good}`)),'any matching v1 signature');
 // Limits: 16 signatures, 32 parts and a 4096-character header.
 const filler=count=>Array.from({length:count},(_,i)=>`v1=${(i+1).toString(16).padStart(64,'0')}`);
 assert.ok(accepted(scheme,adapter,stripe(`t=${NOW},${filler(15).join(',')},v1=${good}`)),'16 signatures');assert.equal(accepted(scheme,adapter,stripe(`t=${NOW},${filler(16).join(',')},v1=${good}`)),false,'17 signatures');
 const extras=count=>Array.from({length:count},(_,i)=>`x${i}=1`).join(',');
 assert.ok(accepted(scheme,adapter,stripe(`t=${NOW},v1=${good},${extras(30)}`)),'32 parts');assert.equal(accepted(scheme,adapter,stripe(`t=${NOW},v1=${good},${extras(31)}`)),false,'33 parts');
 const pad=length=>{const prefix=`t=${NOW},v1=${good},p=`;return prefix+'a'.repeat(length-prefix.length);};
 assert.ok(accepted(scheme,adapter,stripe(pad(4096))),'4096 characters');assert.equal(accepted(scheme,adapter,stripe(pad(4097))),false,'4097 characters');
 // Secrets and options.
 const base={identity,agentId:'agent',secret:STRIPE},invalid=/Invalid Stripe webhook configuration/;
 createStripeWebhookAdapter({...base,toleranceSeconds:1});createStripeWebhookAdapter({...base,toleranceSeconds:3600});createStripeWebhookAdapter({...base,previousSecrets:['whsec_'+'a'.repeat(16),'whsec_'+'b'.repeat(1018)]});
 for(const [label,patch] of Object.entries({
  'no identity':{identity:undefined},'tenant invalid':{identity:{...identity,tenantId:''}},'principal invalid':{identity:{...identity,principalId:''}},'source invalid':{identity:{...identity,sourceId:''}},'source of a schedule':{identity:{...identity,sourceId:'schedule.x'}},'agent invalid':{agentId:''},
  'secret without the prefix':{secret:'k'.repeat(40)},'secret too short':{secret:'whsec_'+'k'.repeat(15)},'secret too long':{secret:'whsec_'+'k'.repeat(1019)},'secret with a space':{secret:'whsec_'+'k'.repeat(15)+' '},'secret not text':{secret:Buffer.from(STRIPE)},
  'previous secrets not an array':{previousSecrets:'x'},'three previous secrets':{previousSecrets:['a','b','c'].map(c=>'whsec_'+c.repeat(20))},'previous secret invalid':{previousSecrets:['bad']},'repeated secret':{previousSecrets:[STRIPE]},
  'tolerance 0':{toleranceSeconds:0},'tolerance 3601':{toleranceSeconds:3601},'tolerance fractional':{toleranceSeconds:1.5},'clock not a function':{clock:'now'}
 }))assert.throws(()=>createStripeWebhookAdapter({...base,...patch}),invalid,label);
 assert.throws(()=>createStripeWebhookAdapter(undefined),invalid);
 const event={object:'event',id:'evt_123',type:'charge.succeeded'},map=value=>adapter.mapAuthenticatedBody(Buffer.from(JSON.stringify(value)));
 assert.equal(map(event).eventId,'evt_123');assert.equal(map({...event,id:'evt_'+'a'.repeat(124)}).eventType,'charge.succeeded');
 for(const [label,bad] of Object.entries({'other object':{...event,object:'charge'},'id not text':{...event,id:7},'id without the prefix':{...event,id:'123'},'id too long':{...event,id:'evt_'+'a'.repeat(125)},'id empty after the prefix':{...event,id:'evt_'},'type invalid':{...event,type:''},'type missing':{object:'event',id:'evt_1'},'an array':[event],'null':null}))assert.throws(()=>map(bad),/Invalid Stripe event|Unexpected/,label);
 assert.throws(()=>adapter.mapAuthenticatedBody(invalidUtf8),undefined,'invalid UTF-8');
});

test('slack: header grammar, options, challenge and event mapping',()=>{
 const scheme=schemes.slack,adapter=scheme.create(),request=scheme.sign(NOW);
 for(const header of ['X-Slack-Request-Timestamp','X-Slack-Signature'])assert.equal(accepted(scheme,adapter,withHeader(request,header,undefined)),false,'missing '+header);
 for(const [header,value] of [['X-Slack-Request-Timestamp','0'+NOW],['X-Slack-Request-Timestamp','-1'],['X-Slack-Request-Timestamp','1'.repeat(14)],['X-Slack-Request-Timestamp',''],['X-Slack-Signature','v1='+'a'.repeat(64)],['X-Slack-Signature','v0='+'A'.repeat(64)],['X-Slack-Signature','v0='+'a'.repeat(63)],['X-Slack-Signature','']])assert.equal(accepted(scheme,adapter,withHeader(request,header,value)),false,header+' '+value);
 for(const header of ['X-Slack-Request-Timestamp','X-Slack-Signature']){const value=request.req.rawHeaders[request.req.rawHeaders.indexOf(header)+1];assert.equal(adapter.authenticateRaw({rawHeaders:[...request.req.rawHeaders,header,value]},body),undefined,'repeated '+header);}
 const base={identity,agentId:'agent',appId:'A1',teamId:'T1',secret:'x'.repeat(32)},invalid=/Invalid Slack webhook configuration/;
 createSlackWebhookAdapter({...base,toleranceSeconds:1});createSlackWebhookAdapter({...base,toleranceSeconds:3600});createSlackWebhookAdapter({...base,secret:'y'.repeat(1024)});createSlackWebhookAdapter({...base,appId:'A'+'1'.repeat(127),teamId:'T'+'1'.repeat(127)});
 for(const [label,patch] of Object.entries({
  'no identity':{identity:undefined},'tenant invalid':{identity:{...identity,tenantId:''}},'principal invalid':{identity:{...identity,principalId:''}},'source invalid':{identity:{...identity,sourceId:''}},'source of a schedule':{identity:{...identity,sourceId:'schedule.x'}},'agent invalid':{agentId:''},
  'app id without the prefix':{appId:'B1'},'app id lowercase':{appId:'Aa1'},'app id too long':{appId:'A'+'1'.repeat(128)},'team id invalid':{teamId:'X1'},'team id too long':{teamId:'T'+'1'.repeat(128)},
  'secret under 32 characters':{secret:'x'.repeat(31)},'secret over 1024 characters':{secret:'x'.repeat(1025)},'secret with a space':{secret:'x'.repeat(31)+' '},'previous secrets not an array':{previousSecrets:'x'},'three previous secrets':{previousSecrets:['a','b','c'].map(c=>c.repeat(32))},'repeated secret':{previousSecrets:['x'.repeat(32)]},
  'tolerance 0':{toleranceSeconds:0},'tolerance 3601':{toleranceSeconds:3601},'clock not a function':{clock:'now'}
 }))assert.throws(()=>createSlackWebhookAdapter({...base,...patch}),invalid,label);
 assert.throws(()=>createSlackWebhookAdapter(undefined),invalid);
 const challenge=value=>adapter.challengeAuthenticatedBody(Buffer.from(JSON.stringify(value)));
 assert.equal(challenge({type:'url_verification',challenge:'abc123'}),'abc123');assert.equal(challenge({type:'event_callback'}),undefined);assert.equal(challenge({type:'url_verification',challenge:'a'.repeat(512)}).length,512);
 for(const bad of [{type:'url_verification'},{type:'url_verification',challenge:''},{type:'url_verification',challenge:'a'.repeat(513)},{type:'url_verification',challenge:'a b'},{type:'url_verification',challenge:7}])assert.throws(()=>challenge(bad),/Invalid Slack challenge/);
 for(const bad of [invalidUtf8,Buffer.from('[1]'),Buffer.from('null')])assert.throws(()=>adapter.challengeAuthenticatedBody(bad),undefined);
 const event={type:'event_callback',api_app_id:'A1',team_id:'T1',event_id:'Ev123',token:'legacy',event:{type:'message'}},map=value=>adapter.mapAuthenticatedBody(Buffer.from(JSON.stringify(value)));
 assert.equal(map(event).eventId,'Ev123');assert.equal(map(event).payload.token,undefined,'the legacy token is dropped');assert.equal(map({...event,event_id:'Ev'+'a'.repeat(126)}).eventType,'message');
 for(const [label,bad] of Object.entries({'other type':{...event,type:'app_rate_limited'},'other app':{...event,api_app_id:'A2'},'other team':{...event,team_id:'T2'},'event id not text':{...event,event_id:7},'event id without the prefix':{...event,event_id:'123'},'event id too long':{...event,event_id:'Ev'+'a'.repeat(127)},'event id empty after the prefix':{...event,event_id:'Ev'},
  'no event':{...event,event:undefined},'event an array':{...event,event:[1]},'event null':{...event,event:null},'event type invalid':{...event,event:{type:''}},'an array':[event]}))assert.throws(()=>map(bad),/Invalid Slack event/,label);
 assert.throws(()=>adapter.mapAuthenticatedBody(invalidUtf8));
});

test('standard webhooks: header grammar, secret size and event mapping',()=>{
 const scheme=schemes.standard,adapter=scheme.create(),request=scheme.sign(NOW),signature=request.req.rawHeaders[request.req.rawHeaders.indexOf('webhook-signature')+1];
 for(const header of ['webhook-id','webhook-timestamp','webhook-signature'])assert.equal(accepted(scheme,adapter,withHeader(request,header,undefined)),false,'missing '+header);
 for(const [header,value] of [['webhook-id',''],['webhook-id','bad id'],['webhook-timestamp','0'+NOW],['webhook-timestamp','-1'],['webhook-timestamp','1'.repeat(17)],['webhook-signature',''],['webhook-signature','v1,'+'A'.repeat(43)],['webhook-signature','v2,'+signature.slice(3)],['webhook-signature','v1:'+signature.slice(3)],['webhook-signature','v1,'+signature.slice(3,-1)],['webhook-signature',',x'],['webhook-signature','x'.repeat(4097)]])assert.equal(accepted(scheme,adapter,withHeader(request,header,value)),false,header+' '+value);
 assert.ok(accepted(scheme,adapter,withHeader(request,'webhook-signature','v2,AAAA '+signature)),'unknown versions are skipped');assert.ok(accepted(scheme,adapter,withHeader(request,'webhook-signature',signature+' v1,'+'A'.repeat(43)+'=')),'any matching signature');
 const many=count=>Array.from({length:count},(_,i)=>`v2,${i}`).join(' ');
 assert.ok(accepted(scheme,adapter,withHeader(request,'webhook-signature',many(31)+' '+signature)),'32 entries');assert.equal(accepted(scheme,adapter,withHeader(request,'webhook-signature',many(32)+' '+signature)),false,'33 entries');
 const secret=bytes=>'whsec_'+Buffer.alloc(bytes,9).toString('base64'),base={identity,agentId:'agent',secret:STANDARD},invalid=/Invalid Standard Webhooks webhook configuration|Invalid.*configuration/;
 createStandardWebhookAdapter({...base,secret:secret(24)});createStandardWebhookAdapter({...base,secret:secret(64)});createStandardWebhookAdapter({...base,toleranceSeconds:1});createStandardWebhookAdapter({...base,toleranceSeconds:3600});createStandardWebhookAdapter({...base,previousSecrets:[secret(24),secret(25)]});
 for(const [label,patch] of Object.entries({
  'no identity':{identity:undefined},'tenant invalid':{identity:{...identity,tenantId:''}},'principal invalid':{identity:{...identity,principalId:''}},'source invalid':{identity:{...identity,sourceId:''}},'source of a schedule':{identity:{...identity,sourceId:'schedule.x'}},'agent invalid':{agentId:''},
  'secret without the prefix':{secret:STANDARD.slice(6)},'secret not base64':{secret:'whsec_!!!!'},'secret of 23 bytes':{secret:secret(23)},'secret of 65 bytes':{secret:secret(65)},'secret not text':{secret:Buffer.from(STANDARD)},
  'previous secrets not an array':{previousSecrets:'x'},'three previous secrets':{previousSecrets:[secret(24),secret(25),secret(26)]},'previous secret invalid':{previousSecrets:['bad']},'repeated secret':{previousSecrets:[STANDARD]},
  'tolerance 0':{toleranceSeconds:0},'tolerance 3601':{toleranceSeconds:3601},'tolerance fractional':{toleranceSeconds:1.5},'clock not a function':{clock:'now'}
 }))assert.throws(()=>createStandardWebhookAdapter({...base,...patch}),invalid,label);
 assert.throws(()=>createStandardWebhookAdapter(undefined),invalid);
 const map=(value,id='msg_1')=>adapter.mapAuthenticatedBody(Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value)),identity,headers([['webhook-id',id]]));
 assert.equal(map({type:'invoice.paid'}).eventId,'msg_1');assert.equal(map({type:'invoice.paid'}).eventType,'invoice.paid');
 for(const [label,bad] of Object.entries({'no type':{},'type invalid':{type:''},'type not text':{type:7},'an array':[{type:'x'}],'null':null}))assert.throws(()=>map(bad),/Invalid Standard Webhooks event/,label);
 assert.throws(()=>map({type:'x'},'bad id'),/Invalid Standard Webhooks event/,'event id');assert.throws(()=>map(invalidUtf8));
});

// Cases found by the second mutation run: limits at their exact edge, a negative clock, invalid UTF-8 inside an otherwise valid
// event, and the parts of the Standard Webhooks signature list.
test('a negative clock never authenticates, even for a timestamp inside the window',()=>{
 for(const [name,scheme] of Object.entries(schemes)){
  if(scheme.noClock)continue;
  assert.equal(accepted(scheme,scheme.create({clock:()=>-1000}),scheme.sign(0)),false,name);
 }
});

test('limits are inclusive at their exact edge',()=>{
 const source=index=>({sourceId:'s'+index,tenantId:'tenant',principalId:'sender',secret:Buffer.from(SECRET)});
 createSignedWebhookAuthenticator({sources:Array.from({length:1000},(_,i)=>source(i))});
 assert.throws(()=>createSignedWebhookAuthenticator({sources:Array.from({length:1001},(_,i)=>source(i))}),/Invalid webhook configuration/);
 const twoSlack=['a','b'].map(c=>c.repeat(32));
 createSlackWebhookAdapter({identity,agentId:'agent',appId:'A1',teamId:'T1',secret:'x'.repeat(32),previousSecrets:twoSlack});
 createStripeWebhookAdapter({identity,agentId:'agent',secret:STRIPE,previousSecrets:['whsec_'+'a'.repeat(20),'whsec_'+'b'.repeat(20)]});
 createStandardWebhookAdapter({identity,agentId:'agent',secret:STANDARD,previousSecrets:['whsec_'+Buffer.alloc(24,1).toString('base64'),'whsec_'+Buffer.alloc(24,2).toString('base64')]});
});

test('invalid UTF-8 inside an otherwise valid event is refused, not repaired',()=>{
 const wrap=(prefix,suffix)=>Buffer.concat([Buffer.from(prefix),Buffer.from([0xff,0xfe]),Buffer.from(suffix)]);
 const stripeEvent=wrap('{"object":"event","id":"evt_1","type":"charge.succeeded","note":"','"}'),standardEvent=wrap('{"type":"invoice.paid","note":"','"}');
 const slackEvent=wrap('{"type":"event_callback","api_app_id":"A1","team_id":"T1","event_id":"Ev1","event":{"type":"message"},"note":"','"}');
 assert.throws(()=>schemes.stripe.create().mapAuthenticatedBody(stripeEvent));
 assert.throws(()=>schemes.slack.create().mapAuthenticatedBody(slackEvent));
 assert.throws(()=>schemes.standard.create().mapAuthenticatedBody(standardEvent,identity,headers([['webhook-id','msg_1']])));
 // The same events with valid text are accepted, so the refusal is about the bytes.
 assert.ok(schemes.stripe.create().mapAuthenticatedBody(Buffer.from('{"object":"event","id":"evt_1","type":"charge.succeeded","note":"x"}')));
 assert.ok(schemes.standard.create().mapAuthenticatedBody(Buffer.from('{"type":"invoice.paid","note":"x"}'),identity,headers([['webhook-id','msg_1']])));
});

test('standard webhooks: the signature list is read strictly',()=>{
 const scheme=schemes.standard,adapter=scheme.create(),request=scheme.sign(NOW),signature=request.req.rawHeaders[request.req.rawHeaders.indexOf('webhook-signature')+1];
 const use=value=>accepted(scheme,adapter,withHeader(request,'webhook-signature',value));
 // A header of exactly 4096 characters is read; one more is refused.
 const padded=length=>{const prefix=signature+' v2,';return prefix+'a'.repeat(length-prefix.length);};
 assert.equal(use(padded(4096).length===4096?padded(4096):''),true,'4096 characters');assert.equal(use(padded(4097)),false,'4097 characters');
 // A version without a value part before the comma is skipped; an entry whose signature is the wrong length refuses the header.
 assert.equal(use('a,xyz '+signature),true,'a one-character unknown version is skipped');
 assert.equal(use('v1,AAAA '+signature),false,'a v1 entry of the wrong length refuses the header');
 assert.equal(use('v1,'+'!'.repeat(44)+' '+signature),false,'a v1 entry that is not base64 refuses the header');
 assert.equal(use(signature+' v1,'+'A'.repeat(43)),false,'a v1 entry one character short refuses the header');
 // The secret must be base64 after the prefix and have the prefix.
 assert.throws(()=>createStandardWebhookAdapter({identity,agentId:'agent',secret:'whsec_!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!'}));
 assert.throws(()=>createStandardWebhookAdapter({identity,agentId:'agent',secret:STANDARD.replace('whsec_','whsek_')}));
});
