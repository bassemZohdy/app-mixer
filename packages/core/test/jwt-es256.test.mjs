import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {SignJWT} from 'jose';
import {createJwtCapabilityAuthenticator} from '../dist/index.js';

const issuer='https://identity.example.test/',audience='https://api.example.test',time=1700000000000;
const ec=generateKeyPairSync('ec',{namedCurve:'P-256'}),otherEc=generateKeyPairSync('ec',{namedCurve:'P-256'}),rsa=generateKeyPairSync('rsa',{modulusLength:2048});
const ecJwk=(pair,kid,extra={})=>({...pair.publicKey.export({format:'jwk'}),kid,alg:'ES256',use:'sig',...extra});
const rsaJwk={...rsa.publicKey.export({format:'jwk'}),kid:'rsa',alg:'RS256',use:'sig'};
const config=overrides=>({issuer,audience,jwks:{keys:[ecJwk(ec,'ec')]},maxTokenAgeSeconds:600,clock:()=>time,resolveActor:claims=>({tenantId:'tenant-a',principalId:claims.sub}),...overrides});
const sign=(key,header={})=>new SignJWT({iss:issuer,aud:audience,sub:'alice',client_id:'client',jti:'t1',iat:time/1000,exp:time/1000+300}).setProtectedHeader({alg:'ES256',kid:'ec',typ:'at+jwt',...header}).sign(key);
const req=value=>({rawHeaders:['Authorization',value]});

test('ES256 access tokens authenticate and keys of the wrong type or identity are rejected',async()=>{
 const auth=createJwtCapabilityAuthenticator(config({jwks:{keys:[ecJwk(ec,'ec'),rsaJwk]}}));
 assert.deepEqual(await auth(req('Bearer '+await sign(ec.privateKey))),{tenantId:'tenant-a',principalId:'alice'});
 // Signed by a different EC key under the trusted key ID.
 assert.equal(await auth(req('Bearer '+await sign(otherEc.privateKey))),undefined);
 // An RS256 token cannot be verified with the EC key, nor an ES256 token with the RSA key ID.
 const rs=await new SignJWT({iss:issuer,aud:audience,sub:'alice',client_id:'client',jti:'t2',iat:time/1000,exp:time/1000+300}).setProtectedHeader({alg:'RS256',kid:'ec',typ:'at+jwt'}).sign(rsa.privateKey);
 assert.equal(await auth(req('Bearer '+rs)),undefined);
 assert.equal(await auth(req('Bearer '+await sign(ec.privateKey,{kid:'rsa'}))),undefined);
 // The RSA key in the same set still works for RS256.
 const good=await new SignJWT({iss:issuer,aud:audience,sub:'bob',client_id:'client',jti:'t3',iat:time/1000,exp:time/1000+300}).setProtectedHeader({alg:'RS256',kid:'rsa',typ:'at+jwt'}).sign(rsa.privateKey);
 assert.deepEqual(await auth(req('Bearer '+good)),{tenantId:'tenant-a',principalId:'bob'});
 // Claims are still enforced for ES256 tokens.
 const expired=await new SignJWT({iss:issuer,aud:audience,sub:'alice',client_id:'client',jti:'t4',iat:time/1000-1000,exp:time/1000-500}).setProtectedHeader({alg:'ES256',kid:'ec',typ:'at+jwt'}).sign(ec.privateKey);
 assert.equal(await auth(req('Bearer '+expired)),undefined);
});

test('EC key configuration is validated',()=>{
 const good=ecJwk(ec,'ec'),p384=generateKeyPairSync('ec',{namedCurve:'P-384'});
 const bad=[
  {...good,crv:'P-384'},{...good,crv:undefined},{...ecJwk(p384,'p384')},{...good,d:'AAAA'},{...good,x:good.x.slice(1)},{...good,y:'!'.repeat(43)},
  {...good,x:good.x,y:Buffer.alloc(32,1).toString('base64url')}, // not on the curve
  {...good,alg:'RS256'},{...good,use:'enc'},{...good,key_ops:['sign']},{...good,kid:''},{...good,n:'AQAB'}
 ];
 for(const key of bad)assert.throws(()=>createJwtCapabilityAuthenticator(config({jwks:{keys:[key]}})),/configuration/,JSON.stringify(key).slice(0,80));
 assert.throws(()=>createJwtCapabilityAuthenticator(config({jwks:{keys:[good,{...ecJwk(otherEc,'ec')}]}})),/configuration/);
 assert.doesNotThrow(()=>createJwtCapabilityAuthenticator(config({jwks:{keys:[{...good,alg:undefined,use:undefined,key_ops:['verify']}]}})));
});

test('JWKS manager selects P-256 keys from a mixed issuer key set and ignores other curves',async()=>{
 const {createServer}=await import('node:http'),{once}=await import('node:events'),{JwtJwksManager}=await import('../dist/index.js');
 const p384=generateKeyPairSync('ec',{namedCurve:'P-384'}),ed=generateKeyPairSync('ed25519');
 const document=JSON.stringify({keys:[{...ed.publicKey.export({format:'jwk'}),kid:'ed'},{...p384.publicKey.export({format:'jwk'}),kid:'p384'},{...rsa.publicKey.export({format:'jwk'}),kid:'enc',use:'enc'},ecJwk(ec,'ec',{alg:undefined})]});
 const endpoint=createServer((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(document);});endpoint.listen(0,'127.0.0.1');await once(endpoint,'listening');
 const auth=createJwtCapabilityAuthenticator(config()),m=new JwtJwksManager({authenticator:auth,jwksUrl:`http://127.0.0.1:${endpoint.address().port}/keys`,allowLoopbackHttp:true,pollMs:100,maxStaleMs:1000,timeoutMs:500,onError:()=>{},clock:()=>time});
 try{
  await m.refresh();
  assert.deepEqual(await m.authenticate(req('Bearer '+await sign(ec.privateKey))),{tenantId:'tenant-a',principalId:'alice'});
  assert.equal(await m.authenticate(req('Bearer '+await sign(otherEc.privateKey))),undefined);
 }finally{await m.close();endpoint.closeAllConnections();await new Promise(resolve=>endpoint.close(resolve));}
});
