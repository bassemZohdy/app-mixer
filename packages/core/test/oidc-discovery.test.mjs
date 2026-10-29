import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {generateKeyPairSync} from 'node:crypto';
import {SignJWT} from 'jose';
import {discoverOidcJwks,createOidcJwtJwksManager,createJwtCapabilityAuthenticator} from '../dist/index.js';

test('OIDC discovery verifies issuer, key origin, response and request bounds',async()=>{
 let status=200,type='application/json',body='',requests=[];
 const server=createServer((req,res)=>{requests.push(req.url);res.writeHead(status,{'content-type':type,location:'/elsewhere'});res.end(body);});server.listen(0,'127.0.0.1');await once(server,'listening');
 const base=`http://127.0.0.1:${server.address().port}`,issuer=base+'/tenant/',opts={issuer,timeoutMs:500,allowLoopbackHttp:true};
 try{
  body=JSON.stringify({issuer,jwks_uri:base+'/keys'});assert.deepEqual(await discoverOidcJwks(opts),{issuer,jwksUrl:base+'/keys'});assert.equal(requests[0],'/tenant/.well-known/openid-configuration');
  for(const metadata of [{issuer:base+'/other',jwks_uri:base+'/keys'},{issuer,jwks_uri:'https://other.example/keys'},{issuer,jwks_uri:base+'/keys?x=1'},{issuer,jwks_uri:'http://other.example/keys'}]){body=JSON.stringify(metadata);await assert.rejects(discoverOidcJwks(opts),/discovery failed/);}
  body=JSON.stringify({issuer,jwks_uri:'https://other.example/keys'});assert.equal((await discoverOidcJwks({...opts,allowedJwksOrigins:['https://other.example']})).jwksUrl,'https://other.example/keys');
  status=302;await assert.rejects(discoverOidcJwks(opts),/discovery failed/);assert.equal(requests.includes('/elsewhere'),false);status=200;type='text/plain';await assert.rejects(discoverOidcJwks(opts),/discovery failed/);type='application/json';body=' '.repeat(140000);await assert.rejects(discoverOidcJwks(opts),/discovery failed/);
  for(const invalid of [{...opts,issuer:'http://example.com'}, {...opts,allowedJwksOrigins:['https://other.example/path']}, {...opts,timeoutMs:0}, {...opts,allowLoopbackHttp:false}])await assert.rejects(discoverOidcJwks(invalid),/configuration/);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('manager discovery requires the exact configured authenticator issuer',async()=>{
 const key=generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({format:'jwk'}),authenticator=createJwtCapabilityAuthenticator({issuer:'https://issuer.example',audience:'api',jwks:{keys:[{...key,kid:'a'}]},maxTokenAgeSeconds:60,resolveActor:()=>undefined});
 const options={authenticator,issuer:'https://other.example',pollMs:100,maxStaleMs:1000,timeoutMs:500,onError:()=>{}};
 await assert.rejects(createOidcJwtJwksManager(options),/issuer mismatch/);authenticator.close();
});

test('discovered manager refreshes its trusted key set before authenticating',async()=>{
 const pair=generateKeyPairSync('rsa',{modulusLength:2048}),key={...pair.publicKey.export({format:'jwk'}),kid:'key'},issuer='https://issuer.example',now=Math.floor(Date.now()/1000);
 const server=createServer((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({keys:[key]}));});server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
 const authenticator=createJwtCapabilityAuthenticator({issuer,audience:'api',jwks:{keys:[key]},maxTokenAgeSeconds:60,resolveActor:()=>({tenantId:'t',principalId:'u'})}),originalFetch=globalThis.fetch;
 globalThis.fetch=(url,options)=>url===issuer+'/.well-known/openid-configuration'?Promise.resolve(new Response(JSON.stringify({issuer,jwks_uri:base+'/keys'}),{headers:{'content-type':'application/json'}})):originalFetch(url,options);
 let manager;try{manager=await createOidcJwtJwksManager({authenticator,issuer,allowedJwksOrigins:[base],allowLoopbackHttp:true,pollMs:100,maxStaleMs:1000,timeoutMs:500,onError:()=>{}});const token=await new SignJWT({iss:issuer,aud:'api',sub:'u',client_id:'c',jti:'id',iat:now,exp:now+60}).setProtectedHeader({alg:'RS256',kid:'key',typ:'at+jwt'}).sign(pair.privateKey),req={rawHeaders:['Authorization','Bearer '+token]};assert.equal(await manager.authenticate(req),undefined);await manager.refresh();assert.deepEqual(await manager.authenticate(req),{tenantId:'t',principalId:'u'});}finally{globalThis.fetch=originalFetch;await manager?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
