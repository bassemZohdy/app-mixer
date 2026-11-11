import test from 'node:test';
import assert from 'node:assert/strict';
import {twilioSignature,validTwilioSignature} from '../dist/twilio-signature.js';

// Reference values produced by the official Twilio SDK (getExpectedTwilioSignature) before the dependency was removed.
const vectors=[
 ['12345','https://mycompany.com/myapp.php?foo=1&bar=2',{CallSid:'CA1234567890ABCDE',Caller:'+12349013030',Digits:'1234',From:'+12349013030',To:'+18005551212'},'0/KCTR6DLpKmkAf8muzZqo1nDgQ='],
 ['a'.repeat(32),'https://example.test/events?channel=sms',{Body:'hello + world',From:'+15551111111',MessageSid:'SM'+'b'.repeat(32)},'b6EpHCw0+hBUWNMVbPnaSYDrDso='],
 ['b'.repeat(32),'https://example.test:8443/e',{},'zH5gNuHIp3JXxqfLt1G4fMAOxgs='],
 ['c'.repeat(32),"https://example.test/it's?x=%27",{B:'é',A:'1 2'},'cLfh4pcKkRgEJiE5wCyXLfDkka4=']
];

test('signatures match the reference values and fields are signed in sorted order',()=>{
 for(const [token,url,params,expected] of vectors){assert.equal(twilioSignature(token,url,params),expected);assert.equal(validTwilioSignature(token,expected,url,params),true);}
 const [token,url,params]=vectors[0];assert.equal(twilioSignature(token,url,Object.fromEntries(Object.entries(params).reverse())),vectors[0][3]);
});

test('a signature must match the token, the fields and the URL; default ports are interchangeable',()=>{
 const [token,url,params,signature]=vectors[1];
 assert.equal(validTwilioSignature(token,signature,url,params),true);
 assert.equal(validTwilioSignature(token,signature,'https://example.test:443/events?channel=sms',params),true,'the signed URL had no port; the configured one names the default port');
 assert.equal(validTwilioSignature(token,twilioSignature(token,'https://example.test:443/events?channel=sms',params),url,params),true);
 for(const [wrongToken,wrongUrl,wrongParams,wrongSignature] of [['d'.repeat(32),url,params,signature],[token,'https://example.test/other?channel=sms',params,signature],[token,url,{...params,Body:'tampered'},signature],[token,url,{...params,Extra:'x'},signature],[token,url,params,signature.slice(0,-2)+'A='],[token,url,params,''],[token,url,params,'x'.repeat(200)]])assert.equal(validTwilioSignature(wrongToken,wrongSignature,wrongUrl,wrongParams),false);
 // As in the SDK, the configured URL is also tried without its port, so a signature over the portless URL is accepted for a configured port.
 assert.equal(validTwilioSignature(token,signature,'https://example.test:8443/events?channel=sms',params),true);
 assert.equal(validTwilioSignature(token,twilioSignature(token,'https://example.test:8443/events?channel=sms',params),'https://example.test:9000/events?channel=sms',params),false,'a signature over a different explicit port is not accepted');
});
