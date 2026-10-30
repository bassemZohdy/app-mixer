import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:https';
import {readFileSync} from 'node:fs';
import {once} from 'node:events';
import {CapabilityRegistry,createCapabilityHttpsServer} from '../dist/index.js';

// Public test-only keys; never use these certificates outside this test.
const fixture=name=>readFileSync(new URL(`./fixtures/capability-tls/${name}.pem`,import.meta.url));
const ca=fixture('ca-cert'),cert=fixture('server-cert'),key=fixture('server-key'),clientCert=fixture('client-cert'),clientKey=fixture('client-key');
function call(port,options={}){return new Promise((resolve,reject)=>{const req=request({host:'127.0.0.1',port,path:'/capabilities/read/invoke',method:'POST',ca,headers:{'content-type':'application/json',authorization:'Bearer valid'},...options},res=>{const parts=[];res.on('data',chunk=>parts.push(chunk));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(parts))}));});req.on('error',reject);req.end(JSON.stringify({origin:'ui',input:{}}));});}

test('HTTPS verifies server trust, optional client certificates, and the normal authorization and audit path',async()=>{
 let authentications=0,calls=0;const events=[],failures=[],registry=new CapabilityRegistry(event=>events.push(event));registry.register({operationId:'read',method:'POST',path:'/read'},{authorize:actor=>actor.tenantId==='tenant',validate:()=>true,execute:()=>++calls});
 const server=createCapabilityHttpsServer(registry,req=>{authentications++;return req.headers.authorization==='Bearer valid'?{tenantId:'tenant',principalId:'alice'}:undefined},event=>failures.push(event),{cert,key,clientCa:ca});server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;
 try{
  await assert.rejects(call(port,{ca:fixture('rogue-cert'),cert:clientCert,key:clientKey}));
  await assert.rejects(call(port));
  await assert.rejects(call(port,{cert:fixture('rogue-cert'),key:fixture('rogue-key')}));
  assert.equal(authentications,0);
  const credentials={cert:clientCert,key:clientKey};assert.equal((await call(port,{...credentials,headers:{'content-type':'application/json',authorization:'Bearer bad'}})).status,401);assert.equal(failures.length,1);
  const response=await call(port,credentials);assert.equal(response.status,200);assert.equal(response.body.result,1);assert.equal(calls,1);assert.deepEqual(events.map(event=>event.outcome),['attempt','succeeded']);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('HTTPS rejects missing TLS settings and accepts server-only TLS when explicitly configured',async()=>{
 const registry=new CapabilityRegistry(()=>{}),auth=()=>({tenantId:'tenant',principalId:'alice'}),audit=()=>{};
 for(const config of [undefined,{}, {cert,key:''},{cert,key,clientCa:''},{cert,key,clientCA:ca}])assert.throws(()=>createCapabilityHttpsServer(registry,auth,audit,config),/TLS configuration/);
 const server=createCapabilityHttpsServer(registry,auth,audit,{cert,key});server.listen(0,'127.0.0.1');await once(server,'listening');try{assert.equal((await call(server.address().port)).status,404);}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
