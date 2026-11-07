import test from 'node:test';
import assert from 'node:assert/strict';
import {createSlackWebhookAdapter,createStandardWebhookAdapter} from '../dist/index.js';

// The Standard Webhooks specification's own test vector (standard-webhooks/standard-webhooks, "Verifying Webhooks"):
// a signature produced by the reference implementation, not by this repository.
const vendor={secret:'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',id:'msg_p5jXN8AQM9LWM0D4loKWxJek',timestamp:'1614265330',body:'{"test": 2432232314}',signature:'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE='};
const identity={tenantId:'tenant',principalId:'sender',sourceId:'standard'};
const request=(headers)=>({rawHeaders:Object.entries(headers).flat()});
const adapter=(clock=()=>Number(vendor.timestamp)*1000)=>createStandardWebhookAdapter({identity,agentId:'agent',secret:vendor.secret,clock});
const headers=(overrides={})=>request({'webhook-id':vendor.id,'webhook-timestamp':vendor.timestamp,'webhook-signature':vendor.signature,...overrides});

test('the Standard Webhooks specification vector authenticates through the adapter',()=>{
 assert.deepEqual(adapter().authenticateRaw(headers(),Buffer.from(vendor.body)),identity);
});

test('the specification vector is refused when any signed part, the secret or the clock differs',()=>{
 const body=Buffer.from(vendor.body);
 assert.equal(adapter().authenticateRaw(headers({'webhook-id':'msg_other'}),body),undefined);
 assert.equal(adapter().authenticateRaw(headers({'webhook-timestamp':'1614265331'}),body),undefined);
 assert.equal(adapter().authenticateRaw(headers(),Buffer.from('{"test": 2432232315}')),undefined);
 assert.equal(adapter().authenticateRaw(headers(),Buffer.from('{"test":2432232314}')),undefined,'whitespace is part of the signed bytes');
 assert.equal(createStandardWebhookAdapter({identity,agentId:'agent',secret:'whsec_'+Buffer.alloc(24,1).toString('base64'),clock:()=>Number(vendor.timestamp)*1000}).authenticateRaw(headers(),body),undefined);
 assert.equal(adapter(()=>(Number(vendor.timestamp)+301)*1000).authenticateRaw(headers(),body),undefined,'outside the five-minute tolerance');
 assert.deepEqual(adapter(()=>(Number(vendor.timestamp)+300)*1000).authenticateRaw(headers(),body),identity,'exactly at the tolerance');
});

// The request-signing example in Slack's documentation ("Verifying requests from Slack"): the signing secret, timestamp, raw
// slash-command body and resulting v0 signature are Slack's own. The adapter only authenticates the bytes, so the body need not be an event.
const slack={secret:'8f742231b10e8888abcd99yyyzzz85a5',timestamp:'1531420618',signature:'v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503',
 body:'token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c'};
const slackAdapter=(clock=()=>Number(slack.timestamp)*1000)=>createSlackWebhookAdapter({identity:{...identity,sourceId:'slack'},agentId:'agent',appId:'A1',teamId:'T1DC2JH3J',secret:slack.secret,clock});
const slackHeaders=(overrides={})=>request({'X-Slack-Request-Timestamp':slack.timestamp,'X-Slack-Signature':slack.signature,...overrides});

test("Slack's documented signing example authenticates through the adapter",()=>{
 assert.deepEqual(slackAdapter().authenticateRaw(slackHeaders(),Buffer.from(slack.body)),{...identity,sourceId:'slack'});
});

test("Slack's documented example is refused when the body, timestamp, secret or clock differs",()=>{
 const body=Buffer.from(slack.body);
 assert.equal(slackAdapter().authenticateRaw(slackHeaders(),Buffer.from(slack.body+'&x=1')),undefined);
 assert.equal(slackAdapter().authenticateRaw(slackHeaders({'X-Slack-Request-Timestamp':'1531420619'}),body),undefined);
 assert.equal(createSlackWebhookAdapter({identity:{...identity,sourceId:'slack'},agentId:'agent',appId:'A1',teamId:'T1DC2JH3J',secret:'8f742231b10e8888abcd99yyyzzz85a6',clock:()=>Number(slack.timestamp)*1000}).authenticateRaw(slackHeaders(),body),undefined);
 assert.equal(slackAdapter(()=>(Number(slack.timestamp)+301)*1000).authenticateRaw(slackHeaders(),body),undefined);
});
