import test from 'node:test';
import assert from 'node:assert/strict';
import {createTwilioMessageWebhookAdapter} from '../dist/index.js';
import {twilioSignature} from '../dist/twilio-signature.js';

// Reference signatures produced by the official Twilio SDK (getExpectedTwilioSignature) before the dependency was removed.
const vectors=[
 ['12345','https://mycompany.com/myapp.php?foo=1&bar=2',{CallSid:'CA1234567890ABCDE',Caller:'+12349013030',Digits:'1234',From:'+12349013030',To:'+18005551212'},'0/KCTR6DLpKmkAf8muzZqo1nDgQ='],
 ['a'.repeat(32),'https://example.test/events?channel=sms',{Body:'hello + world',From:'+15551111111',MessageSid:'SM'+'b'.repeat(32)},'b6EpHCw0+hBUWNMVbPnaSYDrDso='],
 ['c'.repeat(32),"https://example.test/it's?x=%27",{B:'é',A:'1 2'},'cLfh4pcKkRgEJiE5wCyXLfDkka4=']
];
const token='d'.repeat(32),url='https://example.test/twilio/messages',accountSid='AC'+'e'.repeat(32);
const fields={AccountSid:accountSid,MessageSid:'SM'+'f'.repeat(32),From:'+15551111111',To:'+15552222222',Body:'hello + world'};
const encode=values=>Object.entries(values).map(([key,value])=>encodeURIComponent(key).replaceAll('%20','+')+'='+encodeURIComponent(value).replaceAll('%20','+')).join('&');
const request=signature=>({rawHeaders:signature===undefined?['Host','example.test']:['Host','example.test','X-Twilio-Signature',signature]});
const adapter=(extra={})=>createTwilioMessageWebhookAdapter({identity:{tenantId:'tenant',principalId:'twilio',sourceId:'twilio'},agentId:'agent',accountSid,url,authToken:token,...extra});

test('signatures from the Twilio SDK reference values are reproduced and refused when the URL or a field changes',()=>{
 for(const [key,address,params,expected] of vectors){
  assert.equal(twilioSignature(key,address,params),expected,address);
  assert.notEqual(twilioSignature(key,address+'x',params),expected,'a changed URL');
  assert.notEqual(twilioSignature(key,address,{...params,Extra:'1'}),expected,'an added field');
 }
});

test('the adapter accepts a validly signed message and maps it, and refuses a tampered body, URL or token',()=>{
 const sub=adapter(),body=Buffer.from(encode(fields)),good=twilioSignature(token,url,fields),req=request(good);
 const identity=sub.authenticateRaw(req,body);assert.deepEqual(identity,{tenantId:'tenant',principalId:'twilio',sourceId:'twilio'});
 const event=sub.mapAuthenticatedBody(body,identity,req);assert.equal(event.eventType,'twilio.message');assert.equal(event.eventId,fields.MessageSid);assert.equal(event.payload.Body,'hello + world');
 // A changed body, a changed signed URL, another token, a repeated or malformed signature header, and no header are all unauthenticated.
 assert.equal(sub.authenticateRaw(request(good),Buffer.from(encode({...fields,Body:'hello'}))),undefined,'a tampered body');
 assert.equal(adapter({url:'https://example.test/twilio/other'}).authenticateRaw(request(good),body),undefined,'a different URL');
 assert.equal(adapter({authToken:'0'.repeat(32)}).authenticateRaw(request(good),body),undefined,'another token');
 assert.equal(sub.authenticateRaw({rawHeaders:['X-Twilio-Signature',good,'x-twilio-signature',good]},body),undefined,'a repeated header');
 assert.equal(sub.authenticateRaw(request('not-a-signature'),body),undefined,'a malformed signature');
 assert.equal(sub.authenticateRaw(request(undefined),body),undefined,'no signature');
});

test('a message mapped from a verified body must be the verified body, and previous tokens still verify during rotation',()=>{
 const previous='9'.repeat(32),sub=adapter({previousAuthTokens:[previous]}),body=Buffer.from(encode(fields)),req=request(twilioSignature(previous,url,fields));
 const identity=sub.authenticateRaw(req,body);assert.ok(identity,'the previous token verifies');
 assert.throws(()=>sub.mapAuthenticatedBody(Buffer.from(encode({...fields,Body:'swapped'})),identity,req),/Invalid Twilio event/,'a body that was not the verified one');
 assert.throws(()=>sub.mapAuthenticatedBody(body,identity,request(undefined)),/Invalid Twilio event/,'a request that was never verified');
 assert.throws(()=>adapter({previousAuthTokens:[token]}),/Invalid Twilio webhook configuration/,'a repeated token is a configuration error');
});
