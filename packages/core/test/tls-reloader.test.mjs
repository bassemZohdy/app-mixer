import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {request} from 'node:https';
import {once} from 'node:events';
import {ApplicationStore,createDataPlaneHttps,createTlsCredentialReloader,validateTlsCredentials} from '../dist/index.js';

const fixture=name=>readFileSync(new URL(`./fixtures/capability-tls/${name}`,import.meta.url));
const server={cert:fixture('server-cert.pem'),key:fixture('server-key.pem')},rogue={cert:fixture('rotated-server-cert.pem'),key:fixture('rotated-server-key.pem')},ca=fixture('ca-cert.pem');
const fetchWith=(port,trust)=>new Promise((resolve,reject)=>{const req=request({host:'127.0.0.1',port,path:'/application',ca:trust,servername:'localhost',checkServerIdentity:()=>undefined,agent:false},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();});

test('TLS credentials are validated before use',()=>{
 const info=validateTlsCredentials(server,Date.parse('2030-01-01'));assert.match(info.fingerprint,/^[a-f0-9]{64}$/);assert.match(info.subject,/Test server/);assert.ok(info.validTo>info.validFrom);
 assert.throws(()=>validateTlsCredentials({cert:server.cert,key:rogue.key}),/Invalid TLS credentials/);
 assert.throws(()=>validateTlsCredentials({cert:'not pem',key:server.key}),/Invalid TLS credentials/);
 assert.throws(()=>validateTlsCredentials({...server,extra:1}),/Invalid TLS credentials/);
 assert.throws(()=>validateTlsCredentials(server,Date.parse('2051-01-01')),/not currently valid/);
 assert.throws(()=>validateTlsCredentials(server,Date.parse('2000-01-01')),/not currently valid/);
 assert.notEqual(validateTlsCredentials({...server,clientCa:ca}).fingerprint,info.fingerprint);
});

test('a running HTTPS Data Plane reloads valid credentials and keeps serving on invalid ones',async()=>{
 const store=new ApplicationStore({id:'demo',schemaVersion:1,revision:0,pages:[]});store.publish(0);
 const plane=createDataPlaneHttps(store,server);plane.listen(0,'127.0.0.1');await once(plane,'listening');const port=plane.address().port;
 let next=server;const reloads=[],errors=[];const reloader=createTlsCredentialReloader(plane,{load:async()=>next,intervalMs:1000,clientCa:false,onReload:info=>reloads.push(info.subject),onError:error=>errors.push(error.message)});
 try{
  assert.equal(await fetchWith(port,ca),200);assert.equal(await reloader.reloadNow(),true);assert.equal(await reloader.reloadNow(),false);
  next={cert:server.cert,key:rogue.key};await assert.rejects(reloader.reloadNow(),/Invalid TLS credentials/);assert.equal(await fetchWith(port,ca),200);
  next={...server,clientCa:ca};await assert.rejects(reloader.reloadNow(),/client CA presence changed/);
  next=rogue;assert.equal(await reloader.reloadNow(),true);await assert.rejects(fetchWith(port,ca));assert.equal(await fetchWith(port,rogue.cert),200);
  next={cert:server.cert,key:rogue.key};await new Promise(resolve=>setTimeout(resolve,1200));assert.ok(errors.includes('Invalid TLS credentials'),'periodic failures are reported');assert.equal(await fetchWith(port,rogue.cert),200);
  assert.equal(reloads.length,2);assert.match(reloads[1],/Rotated test server/);
  for(const bad of [{load:()=>server,intervalMs:999,clientCa:false},{load:()=>server,intervalMs:1000},{intervalMs:1000,clientCa:false}])assert.throws(()=>createTlsCredentialReloader(plane,bad),/Invalid TLS reloader configuration/);
  assert.throws(()=>createTlsCredentialReloader({},{load:()=>server,intervalMs:1000,clientCa:false}),/Invalid TLS reloader configuration/);
 }finally{reloader.stop();assert.equal(await reloader.reloadNow(),false);plane.closeAllConnections();await new Promise(resolve=>plane.close(resolve));}
});
