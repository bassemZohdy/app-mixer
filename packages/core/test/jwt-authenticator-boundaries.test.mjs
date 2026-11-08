// Boundary and rejection tests for createJwtCapabilityAuthenticator. A mutation run (scripts/mutate.mjs) showed that 66 of
// 177 small changes to the module went unnoticed: single bad options and keys, the Authorization header limits, the
// time boundaries and isIssuer were never tested one at a time. Each case below fails when its condition is removed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {SignJWT} from 'jose';
import {createJwtCapabilityAuthenticator} from '../dist/index.js';

const issuer='https://identity.example.test/',audience='https://api.example.test',time=1700000000000,now=time/1000;
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048}),jwk={...publicKey.export({format:'jwk'}),kid:'one',alg:'RS256',use:'sig'};
const small=generateKeyPairSync('rsa',{modulusLength:1024}).publicKey.export({format:'jwk'});
const ec=generateKeyPairSync('ec',{namedCurve:'P-256'}),ecJwk={...ec.publicKey.export({format:'jwk'}),kid:'ec',alg:'ES256',use:'sig'};
const config=overrides=>({issuer,audience,jwks:{keys:[jwk]},maxTokenAgeSeconds:600,clock:()=>time,resolveActor:claims=>({tenantId:'tenant-a',principalId:claims.sub}),...overrides});
const token=async(overrides={})=>new SignJWT({iss:issuer,aud:audience,sub:'alice',client_id:'client',jti:'token-1',iat:now,exp:now+300,...overrides}).setProtectedHeader({alg:'RS256',kid:'one',typ:'at+jwt'}).sign(privateKey);
const bearer=value=>({rawHeaders:['Authorization','Bearer '+value]});
const invalid=/Invalid JWT authentication configuration/;
const keys=key=>({keys:[key]});

test('options are validated one at a time',()=>{
 createJwtCapabilityAuthenticator(config({maxTokenAgeSeconds:1}));createJwtCapabilityAuthenticator(config({maxTokenAgeSeconds:86400}));
 createJwtCapabilityAuthenticator(config({clockToleranceSeconds:0}));createJwtCapabilityAuthenticator(config({clockToleranceSeconds:60}));
 createJwtCapabilityAuthenticator(config({audience:'a'.repeat(2048)}));createJwtCapabilityAuthenticator(config({isTokenActive:async()=>true}));
 const bad={
  'no options':undefined,'age 0':{maxTokenAgeSeconds:0},'age negative':{maxTokenAgeSeconds:-1},'age fractional':{maxTokenAgeSeconds:1.5},'age over a day':{maxTokenAgeSeconds:86401},'age as text':{maxTokenAgeSeconds:'600'},'age missing':{maxTokenAgeSeconds:undefined},
  'tolerance over a minute':{clockToleranceSeconds:61},'tolerance negative':{clockToleranceSeconds:-1},'tolerance fractional':{clockToleranceSeconds:1.5},
  'clock not a function':{clock:'now'},'resolveActor missing':{resolveActor:undefined},'resolveActor not a function':{resolveActor:'x'},'isTokenActive not a function':{isTokenActive:'yes'},
  'audience empty':{audience:''},'audience blank':{audience:'  '},'audience too long':{audience:'a'.repeat(2049)},'audience control character':{audience:'a\nb'},'audience missing':{audience:undefined},'issuer missing':{issuer:undefined},
  'issuer too long':{issuer:'https://example.test/'+'a'.repeat(2048)},'issuer not a URL':{issuer:'not a url'},'issuer over http':{issuer:'http://identity.example.test/'},
  'issuer with a user name':{issuer:'https://user@identity.example.test/'},'issuer with a password':{issuer:'https://user:secret@identity.example.test/'},'issuer with a query':{issuer:'https://identity.example.test/?x=1'},'issuer with a fragment':{issuer:'https://identity.example.test/#x'},
  'no keys':{jwks:undefined},'keys not an array':{jwks:{keys:'one'}},'empty key set':{jwks:{keys:[]}},
  'too many keys':{jwks:{keys:Array.from({length:101},(_,i)=>({...jwk,kid:'k'+i}))}}
 };
 assert.throws(()=>createJwtCapabilityAuthenticator(undefined),invalid);
 for(const [name,override] of Object.entries(bad)){if(override===undefined)continue;assert.throws(()=>createJwtCapabilityAuthenticator(config(override)),invalid,name);}
 // The limit on the number of keys is 100 inclusive.
 createJwtCapabilityAuthenticator(config({jwks:{keys:Array.from({length:100},(_,i)=>({...jwk,kid:'k'+i}))}}));
});

test('RSA keys are validated one at a time',()=>{
 const { d: _ignored, ...publicOnly }=jwk;
 createJwtCapabilityAuthenticator(config({jwks:keys({...publicOnly,key_ops:['verify']})}));
 createJwtCapabilityAuthenticator(config({jwks:keys({kid:'bare',kty:'RSA',n:jwk.n,e:jwk.e})}));
 const bad={
  'no key id':{...jwk,kid:undefined},'key id too long':{...jwk,kid:'k'.repeat(129)},'key id blank':{...jwk,kid:' '},
  'modulus with padding':{...jwk,n:jwk.n+'='},'modulus not a string':{...jwk,n:12345},'modulus too long':{...jwk,n:jwk.n+'A'.repeat(400)},'modulus too short (1024 bits)':{...small,kid:'one',alg:'RS256',use:'sig'},
  'modulus with leading zero byte':{...jwk,n:Buffer.concat([Buffer.from([0]),Buffer.from(jwk.n,'base64url')]).toString('base64url')},
  'other exponent':{...jwk,e:'AQAC'},'other algorithm':{...jwk,alg:'RS512'},'encryption key':{...jwk,use:'enc'},
  'key_ops empty':{...jwk,key_ops:[]},'key_ops sign':{...jwk,key_ops:['sign']},'key_ops two entries':{...jwk,key_ops:['verify','sign']},'key_ops not a list':{...jwk,key_ops:'verify'},
  'private exponent':{...jwk,d:jwk.n},'private prime':{...jwk,p:jwk.n},'unsupported key type':{kty:'oct',kid:'one',k:'AAAA'},'not an object':'key'
 };
 for(const [name,key] of Object.entries(bad))assert.throws(()=>createJwtCapabilityAuthenticator(config({jwks:keys(key)})),invalid,name);
 assert.throws(()=>createJwtCapabilityAuthenticator(config({jwks:{keys:[jwk,{...jwk}]}})),invalid,'duplicate key id');
});

test('EC keys are validated one at a time',()=>{
 createJwtCapabilityAuthenticator(config({jwks:keys(ecJwk)}));createJwtCapabilityAuthenticator(config({jwks:keys({...ecJwk,key_ops:['verify']})}));
 const bad={
  'other curve':{...ecJwk,crv:'P-384'},'no key id':{...ecJwk,kid:undefined},'x too short':{...ecJwk,x:ecJwk.x.slice(1)},'y with padding':{...ecJwk,y:ecJwk.y+'='},'x not a string':{...ecJwk,x:1},
  'other algorithm':{...ecJwk,alg:'ES384'},'encryption key':{...ecJwk,use:'enc'},'key_ops sign':{...ecJwk,key_ops:['sign']},'key_ops two entries':{...ecJwk,key_ops:['verify','sign']},'private scalar':{...ecJwk,d:ecJwk.x},
  'point off the curve':{...ecJwk,y:ecJwk.x}
 };
 for(const [name,key] of Object.entries(bad))assert.throws(()=>createJwtCapabilityAuthenticator(config({jwks:keys(key)})),invalid,name);
});

test('the Authorization header is read strictly',async()=>{
 const auth=createJwtCapabilityAuthenticator(config()),good=await token();
 assert.deepEqual(await auth(bearer(good)),{tenantId:'tenant-a',principalId:'alice'});
 assert.equal(await auth({rawHeaders:[]}),undefined,'no header');
 assert.equal(await auth({rawHeaders:['Authorization','Bearer '+good,'authorization','Bearer '+good]}),undefined,'two headers');
 assert.equal(await auth({rawHeaders:['Authorization','Basic '+good]}),undefined,'another scheme');
 assert.equal(await auth({rawHeaders:['Authorization','Bearer not.a-token']}),undefined,'not a token');
 assert.deepEqual(await auth({rawHeaders:['Content-Type','json','AUTHORIZATION','bearer '+good]}),{tenantId:'tenant-a',principalId:'alice'},'header name and scheme are case-insensitive');
 // The longest accepted header is 8192 characters; one more is refused although the token is otherwise valid. A base64
 // length is never 1 more than a multiple of 4, so a key id of a suitable length (and two padding claims) is searched for
 // that makes both 8192 and 8193 reachable.
 const sign=(kid,claims)=>new SignJWT({iss:issuer,aud:audience,sub:'alice',client_id:'client',jti:'token-1',iat:now,exp:now+300,...claims}).setProtectedHeader({alg:'RS256',kid,typ:'at+jwt'}).sign(privateKey);
 const find=async(kid,target)=>{const base=(await sign(kid,{padding:'',fine:''})).length+'Bearer '.length,estimate=Math.round((target-base)*3/4);for(let padding=estimate-8;padding<=estimate+8;padding++)for(let fine=0;fine<4;fine++){const value=await sign(kid,{padding:'x'.repeat(padding),fine:'y'.repeat(fine)});if(value.length+'Bearer '.length===target)return value;}return undefined;};
 let found;for(let length=1;length<=8&&!found;length++){const kid='k'.repeat(length),exact=await find(kid,8192),over=await find(kid,8193);if(exact&&over)found={kid,exact,over};}
 assert.ok(found,'tokens of exactly 8192 and 8193 header characters can be built');
 const long=createJwtCapabilityAuthenticator(config({jwks:keys({...jwk,kid:found.kid})}));
 assert.ok(await long(bearer(found.exact)),'8192 characters are accepted');
 assert.equal(await long(bearer(found.over)),undefined,'more than 8192 characters are refused');
});

test('token age, expiry and issue time are checked at their limits',async()=>{
 const strict=createJwtCapabilityAuthenticator(config({clockToleranceSeconds:0})),tolerant=createJwtCapabilityAuthenticator(config({clockToleranceSeconds:5}));
 const ok=async(auth,overrides)=>(await auth(bearer(await token(overrides))))!==undefined;
 // Age: allowed up to maxTokenAge (600 s) plus the tolerance.
 assert.equal(await ok(strict,{iat:now-600,exp:now+300}),true,'age equal to the limit');assert.equal(await ok(strict,{iat:now-601,exp:now+300}),false,'one second older');
 assert.equal(await ok(tolerant,{iat:now-605,exp:now+300}),true,'age equal to the limit plus the tolerance');assert.equal(await ok(tolerant,{iat:now-606,exp:now+300}),false);
 // Issue time: not later than now plus the tolerance.
 assert.equal(await ok(strict,{iat:now,exp:now+300}),true);assert.equal(await ok(strict,{iat:now+1,exp:now+300}),false,'issued one second from now');
 assert.equal(await ok(tolerant,{iat:now+5,exp:now+300}),true,'issued at the tolerance');assert.equal(await ok(tolerant,{iat:now+6,exp:now+300}),false);
 // Expiry: expired at the expiry second, plus the tolerance.
 assert.equal(await ok(strict,{iat:now-10,exp:now+1}),true);assert.equal(await ok(strict,{iat:now-10,exp:now}),false,'expires now');
 assert.equal(await ok(tolerant,{iat:now-10,exp:now-4}),true,'expired within the tolerance');assert.equal(await ok(tolerant,{iat:now-10,exp:now-5}),false);
 assert.equal(await ok(strict,{iat:now,exp:now}),false,'expiry equal to issue time');
});

test('isIssuer, replaceKeys and close behave as documented',async()=>{
 const auth=createJwtCapabilityAuthenticator(config());
 assert.equal(auth.isIssuer(issuer),true);assert.equal(auth.isIssuer('https://other.example.test/'),false);assert.equal(auth.isIssuer(issuer.slice(0,-1)),false);
 // An unknown key id is refused until the key set is replaced.
 const other=generateKeyPairSync('rsa',{modulusLength:2048}),otherJwk={...other.publicKey.export({format:'jwk'}),kid:'two',alg:'RS256',use:'sig'};
 const signed=await new SignJWT({iss:issuer,aud:audience,sub:'alice',client_id:'client',jti:'t2',iat:now,exp:now+300}).setProtectedHeader({alg:'RS256',kid:'two',typ:'at+jwt'}).sign(other.privateKey);
 assert.equal(await auth(bearer(signed)),undefined);
 assert.throws(()=>auth.replaceKeys({keys:[]}),invalid);assert.throws(()=>auth.replaceKeys({keys:[{...otherJwk,use:'enc'}]}),invalid);
 assert.equal(await auth(bearer(signed)),undefined,'a rejected replacement keeps the old keys');
 auth.replaceKeys({keys:[otherJwk]});assert.deepEqual(await auth(bearer(signed)),{tenantId:'tenant-a',principalId:'alice'});
 assert.equal(await auth(bearer(await token())),undefined,'the old key no longer verifies');
 auth.close();assert.equal(await auth(bearer(signed)),undefined,'a closed authenticator refuses');assert.throws(()=>auth.replaceKeys({keys:[otherJwk]}),/closed/);
});

test('an actor from the host policy must be well formed',async()=>{
 const authenticate=async actor=>createJwtCapabilityAuthenticator(config({resolveActor:()=>actor}))(bearer(await token()));
 assert.deepEqual(await authenticate({tenantId:'tenant-a',principalId:'alice'}),{tenantId:'tenant-a',principalId:'alice'});
 assert.deepEqual(await authenticate({tenantId:'t'.repeat(256),principalId:'p'.repeat(256)}),{tenantId:'t'.repeat(256),principalId:'p'.repeat(256)},'256 characters are allowed');
 for(const [name,actor] of Object.entries({'no actor':undefined,'null':null,'empty tenant':{tenantId:'',principalId:'alice'},'missing tenant':{principalId:'alice'},'blank tenant':{tenantId:' ',principalId:'alice'},'empty principal':{tenantId:'tenant-a',principalId:''},'missing principal':{tenantId:'tenant-a'},'tenant not text':{tenantId:7,principalId:'alice'},'tenant too long':{tenantId:'t'.repeat(257),principalId:'alice'},'principal too long':{tenantId:'tenant-a',principalId:'p'.repeat(257)},'control character':{tenantId:'tenant'+String.fromCharCode(10),principalId:'alice'}}))assert.equal(await authenticate(actor),undefined,name);
 // A policy that throws or rejects refuses the request.
 assert.equal(await createJwtCapabilityAuthenticator(config({resolveActor:()=>{throw Error('policy down');}}))(bearer(await token())),undefined,'a throwing policy');
 assert.equal(await createJwtCapabilityAuthenticator(config({resolveActor:async()=>{throw Error('policy down');}}))(bearer(await token())),undefined,'a rejecting policy');
 assert.equal(await createJwtCapabilityAuthenticator(config({isTokenActive:async()=>false}))(bearer(await token())),undefined,'a token that is not active');
 assert.equal(await createJwtCapabilityAuthenticator(config({isTokenActive:async()=>{throw Error('store down');}}))(bearer(await token())),undefined,'an unavailable revocation store');
});

test('a request is refused when the keys are replaced or the authenticator is closed while its policy is being consulted',async()=>{
 for(const change of ['replaceKeys','close']){
  let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
  const auth=createJwtCapabilityAuthenticator(config({resolveActor:async claims=>{entered();await gate;return {tenantId:'tenant-a',principalId:claims.sub};}}));
  const pending=auth(bearer(await token()));await started;
  if(change==='replaceKeys')auth.replaceKeys({keys:[jwk]});else auth.close();
  release();assert.equal(await pending,undefined,change);
 }
});
