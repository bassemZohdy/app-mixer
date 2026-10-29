import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {SignJWT} from 'jose';
import {JwtJwksManager,createJwtCapabilityAuthenticator,createCapabilityServer,CapabilityRegistry} from '../dist/index.js';
const issuer='https://issuer.example/',audience='api',time=1700000000000,a=generateKeyPairSync('rsa',{modulusLength:2048}),b=generateKeyPairSync('rsa',{modulusLength:2048}),jwk=(pair,kid)=>({...pair.publicKey.export({format:'jwk'}),kid,alg:'RS256',use:'sig'}),aKey=jwk(a,'a'),bKey=jwk(b,'b');
const makeAuth=(extra={})=>createJwtCapabilityAuthenticator({issuer,audience,jwks:{keys:[aKey]},maxTokenAgeSeconds:600,clock:()=>time,resolveActor:()=>({tenantId:'tenant',principalId:'user'}),...extra});
const token=(pair,kid)=>new SignJWT({iss:issuer,aud:audience,sub:'user',client_id:'client',jti:'id',iat:time/1000,exp:time/1000+600}).setProtectedHeader({alg:'RS256',kid,typ:'at+jwt'}).sign(pair.privateKey);
const req=t=>({rawHeaders:['Authorization','Bearer '+t]});
const listen=async server=>{server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${server.address().port}`;};
const manager=(auth,url,extra={})=>new JwtJwksManager({authenticator:auth,jwksUrl:url+'/keys',allowLoopbackHttp:true,pollMs:100,maxStaleMs:1000,timeoutMs:500,onError:()=>{},...extra});

test('JWKS manager refreshes keys, rejects stale cache and fails closed on bad responses',async()=>{
 let now=time,document=JSON.stringify({keys:[aKey]}),status=200,type='application/json';const endpoint=createServer((_req,res)=>{res.writeHead(status,{'content-type':type});res.end(document);}),url=await listen(endpoint),auth=makeAuth(),m=manager(auth,url,{clock:()=>now}),old=await token(a,'a'),fresh=await token(b,'b');try{assert.equal(await m.authenticate(req(old)),undefined);await m.refresh();assert.deepEqual(await m.authenticate(req(old)),{tenantId:'tenant',principalId:'user'});assert.equal(await m.authenticate(req(fresh)),undefined);document=JSON.stringify({keys:[bKey]});await m.refresh();assert.equal(await m.authenticate(req(old)),undefined);assert.deepEqual(await m.authenticate(req(fresh)),{tenantId:'tenant',principalId:'user'});document=JSON.stringify({keys:[{...bKey,d:'private'}]});await assert.rejects(m.refresh(),/JWKS refresh failed/);assert.deepEqual(await m.authenticate(req(fresh)),{tenantId:'tenant',principalId:'user'});now+=1000;assert.equal(await m.authenticate(req(fresh)),undefined);status=302;type='text/html';await assert.rejects(m.refresh(),/JWKS refresh failed/);assert.equal(await m.authenticate(req(fresh)),undefined);document=JSON.stringify({keys:[bKey]});status=200;type='application/jwk-set+json';await m.refresh();assert.deepEqual(await m.authenticate(req(fresh)),{tenantId:'tenant',principalId:'user'});await m.close();assert.equal(await m.authenticate(req(fresh)),undefined);}finally{await m.close();endpoint.closeAllConnections();await new Promise(resolve=>endpoint.close(resolve));}
});

test('key rotation and stale deadlines fence requests still mapping identities',async()=>{
 let now=time,document=JSON.stringify({keys:[aKey]}),started,resume;const ready=new Promise(r=>started=r),gate=new Promise(r=>resume=r),endpoint=createServer((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(document);}),url=await listen(endpoint),auth=makeAuth({resolveActor:async()=>{started();await gate;return {tenantId:'tenant',principalId:'user'};}}),m=manager(auth,url,{clock:()=>now});try{await m.refresh();const pending=m.authenticate(req(await token(a,'a')));await ready;document=JSON.stringify({keys:[bKey]});await m.refresh();resume();assert.equal(await pending,undefined);}finally{resume();await m.close();endpoint.closeAllConnections();await new Promise(resolve=>endpoint.close(resolve));}
});

test('stopping an in-flight refresh prevents it from installing keys',async()=>{
 let received;const ready=new Promise(resolve=>received=resolve),endpoint=createServer((_req,_res)=>received()),url=await listen(endpoint),auth=makeAuth(),m=manager(auth,url);try{m.start();await ready;await m.stop();assert.equal(await m.authenticate(req(await token(a,'a'))),undefined);}finally{await m.close();endpoint.closeAllConnections();await new Promise(resolve=>endpoint.close(resolve));}
});

test('JWKS endpoint restrictions, body limits and server integration',async()=>{
 const endpoint=createServer((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(' '.repeat(140000));}),url=await listen(endpoint),auth=makeAuth(),m=manager(auth,url);try{for(const bad of ['http://example.com/keys','https://user:pass@example.com/keys','https://example.com/keys?token=x','file:///keys'])assert.throws(()=>manager(auth,url,{jwksUrl:bad}),/configuration/);await assert.rejects(m.refresh(),/JWKS refresh failed/);const registry=new CapabilityRegistry(()=>{});registry.register({operationId:'read',method:'GET',path:'/read'},{authorize:()=>true,validate:()=>true,execute:()=>true});const server=createCapabilityServer(registry,m.authenticate,()=>{}),base=await listen(server);try{const response=await fetch(base+'/capabilities/read/invoke',{method:'POST',headers:{authorization:'Bearer '+await token(a,'a'),'content-type':'application/json'},body:JSON.stringify({origin:'ui',input:{}})});assert.equal(response.status,401);}finally{await new Promise(resolve=>server.close(resolve));}}finally{await m.close();endpoint.closeAllConnections();await new Promise(resolve=>endpoint.close(resolve));}
});


test('an in-flight authentication cannot bridge a stale period even after identical refresh',async()=>{
 let now=time,started,resume;const ready=new Promise(r=>started=r),gate=new Promise(r=>resume=r),endpoint=createServer((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({keys:[aKey]}));}),url=await listen(endpoint),auth=makeAuth({resolveActor:async()=>{started();await gate;return {tenantId:'tenant',principalId:'user'};}}),m=manager(auth,url,{clock:()=>now});try{await m.refresh();const pending=m.authenticate(req(await token(a,'a')));await ready;now+=1000;await m.refresh();resume();assert.equal(await pending,undefined);}finally{resume();await m.close();endpoint.closeAllConnections();await new Promise(resolve=>endpoint.close(resolve));}
});

test('JWKS refresh does not follow redirects',async()=>{
 let forwarded=0;const target=createServer((_req,res)=>{forwarded++;res.end(JSON.stringify({keys:[aKey]}));}),targetUrl=await listen(target),endpoint=createServer((_req,res)=>{res.writeHead(302,{location:targetUrl+'/keys'});res.end();}),url=await listen(endpoint),m=manager(makeAuth(),url);try{await assert.rejects(m.refresh(),/JWKS refresh failed/);assert.equal(forwarded,0);}finally{await m.close();endpoint.closeAllConnections();target.closeAllConnections();await Promise.all([new Promise(resolve=>endpoint.close(resolve)),new Promise(resolve=>target.close(resolve))]);}
});


test('explicit polling picks up a rotated key and stops cleanly',async()=>{
 let document=JSON.stringify({keys:[aKey]}),requests=0;const endpoint=createServer((_req,res)=>{requests++;res.writeHead(200,{'content-type':'application/json'});res.end(document);}),url=await listen(endpoint),m=manager(makeAuth(),url,{clock:()=>time}),old=await token(a,'a'),fresh=await token(b,'b'),wait=async predicate=>{for(let i=0;i<100;i++){if(await predicate())return;await new Promise(r=>setTimeout(r,20));}assert.fail('Timed out waiting for key refresh');};try{m.start();await wait(async()=>!!await m.authenticate(req(old)));document=JSON.stringify({keys:[bKey]});await wait(async()=>!!await m.authenticate(req(fresh)));assert.equal(await m.authenticate(req(old)),undefined);await m.stop();const count=requests;await new Promise(r=>setTimeout(r,250));assert.equal(requests,count);}finally{await m.close();endpoint.closeAllConnections();await new Promise(resolve=>endpoint.close(resolve));}
});


test('heterogeneous public JWKS selects only compatible RS256 signing keys',async()=>{
 const ec=generateKeyPairSync('ec',{namedCurve:'P-256'}).publicKey.export({format:'jwk'}),otherRsa={...bKey,kid:'encrypted',use:'enc',alg:'RSA-OAEP-256',key_ops:['encrypt']};let document=JSON.stringify({keys:[{...ec,kid:'ec',use:'sig',alg:'ES256'},otherRsa,aKey]}),now=time;const endpoint=createServer((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(document);}),url=await listen(endpoint),m=manager(makeAuth(),url,{clock:()=>now}),valid=await token(a,'a');try{await m.refresh();assert.deepEqual(await m.authenticate(req(valid)),{tenantId:'tenant',principalId:'user'});for(const bad of [{keys:[{...ec,kid:'ec',alg:'ES256'}]},{keys:[aKey,{...ec,kid:'ec',d:'private'}]},{keys:[aKey,{...otherRsa,d:'private'}]},{keys:[aKey,{...aKey,kid:'candidate',n:'bad'}]},{keys:[aKey,{...ec,key_ops:'verify'}]},{keys:[aKey,{kty:'oct',k:'secret'}]}]){document=JSON.stringify(bad);await assert.rejects(m.refresh(),/JWKS refresh failed/);assert.deepEqual(await m.authenticate(req(valid)),{tenantId:'tenant',principalId:'user'});}now+=1000;assert.equal(await m.authenticate(req(valid)),undefined);}finally{await m.close();endpoint.closeAllConnections();await new Promise(resolve=>endpoint.close(resolve));}
});
