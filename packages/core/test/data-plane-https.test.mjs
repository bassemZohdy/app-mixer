import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:https';
import {readFileSync} from 'node:fs';
import {once} from 'node:events';
import {ApplicationStore,createDataPlaneHttps} from '../dist/index.js';
const fixture=name=>readFileSync(new URL(`./fixtures/capability-tls/${name}.pem`,import.meta.url));
const ca=fixture('ca-cert'),cert=fixture('server-cert'),key=fixture('server-key'),clientCert=fixture('client-cert'),clientKey=fixture('client-key');
const get=(port,path,options={})=>new Promise((resolve,reject)=>{const req=request({host:'127.0.0.1',port,path,ca,...options},res=>{const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString(),etag:res.headers.etag}));});req.on('error',reject);req.end();});
test('TLS Data Plane enforces server trust, client certificates and read authorization',async()=>{
 const store=new ApplicationStore({id:'demo',schemaVersion:1,revision:0,pages:[]});store.publish(0);const server=createDataPlaneHttps(store,{cert,key,clientCa:ca},{health:{timeoutMs:100},authorizePublication:req=>req.headers.authorization==='Bearer allowed'});server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port,credentials={cert:clientCert,key:clientKey};
 try{await assert.rejects(get(port,'/application'));await assert.rejects(get(port,'/application',{cert:fixture('rogue-cert'),key:fixture('rogue-key')}));await assert.rejects(get(port,'/application',{...credentials,ca:fixture('rogue-cert')}));assert.equal((await get(port,'/health/ready',credentials)).status,200);assert.equal((await get(port,'/application',credentials)).status,403);const read=await get(port,'/application',{...credentials,headers:{authorization:'Bearer allowed'}});assert.equal(read.status,200);assert.equal(JSON.parse(read.body).version,1);server.beginDrain();assert.equal((await get(port,'/health/ready',credentials)).status,503);assert.equal((await get(port,'/health/live',credentials)).status,200);}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
test('TLS Data Plane rejects missing or ambiguous settings',()=>{const store=new ApplicationStore({id:'demo',schemaVersion:1,revision:0,pages:[]});for(const tls of [undefined,{}, {cert,key:''},{cert,key,clientCA:ca},{cert,key,clientCa:''}])assert.throws(()=>createDataPlaneHttps(store,tls),/TLS configuration/);});
