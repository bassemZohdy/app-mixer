import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {connect} from 'node:net';
import {once} from 'node:events';
import {CapabilityRegistry,createCapabilityServer,createCapabilityHttpsServer,createControlPlane,createDataPlane,ApplicationStore,limitServer,TLS_POLICY,DEFAULT_SERVER_LIMITS} from '../dist/index.js';

const limits=server=>({headers:server.headersTimeout,request:server.requestTimeout,keepAlive:server.keepAliveTimeout,idle:server.timeout});

test('limitServer validates and applies timeouts and returns the same server',()=>{
 const server=createServer();assert.equal(limitServer(server),server);
 assert.deepEqual(limits(server),{headers:DEFAULT_SERVER_LIMITS.headersTimeoutMs,request:DEFAULT_SERVER_LIMITS.requestTimeoutMs,keepAlive:DEFAULT_SERVER_LIMITS.keepAliveTimeoutMs,idle:30000});
 limitServer(server,{headersTimeoutMs:100,requestTimeoutMs:200,keepAliveTimeoutMs:50,idleTimeoutMs:25});assert.deepEqual(limits(server),{headers:100,request:200,keepAlive:50,idle:25});
 for(const bad of [{headersTimeoutMs:0},{requestTimeoutMs:5,headersTimeoutMs:10},{keepAliveTimeoutMs:1.5},{idleTimeoutMs:-1},{requestTimeoutMs:'1'}])assert.throws(()=>limitServer(createServer(),bad),/Invalid server limits/);
});

test('the servers core creates are limited and the TLS policy is TLS 1.2 or later with forward-secret AEAD suites',()=>{
 const registry=new CapabilityRegistry(()=>{}),store=new ApplicationStore({id:'demo',schemaVersion:1,revision:0,pages:[]});
 for(const server of [createCapabilityServer(registry,()=>undefined,()=>{}),createControlPlane(store,'t'.repeat(32)),createDataPlane(store)])assert.deepEqual(limits(server),{headers:10000,request:30000,keepAlive:5000,idle:30000});
 assert.equal(TLS_POLICY.minVersion,'TLSv1.2');assert.equal(TLS_POLICY.honorCipherOrder,true);
 for(const suite of TLS_POLICY.ciphers.split(':'))assert.match(suite,/^ECDHE-(ECDSA|RSA)-(AES(128|256)-GCM-SHA(256|384)|CHACHA20-POLY1305)$/);
 assert.equal(typeof createCapabilityHttpsServer,'function');
});

test('a client that stalls its request body is cut off by the request timeout',async()=>{
 const server=limitServer(createServer((incoming,response)=>{incoming.resume();incoming.on('end',()=>response.end('ok'));}),{headersTimeoutMs:200,requestTimeoutMs:400,keepAliveTimeoutMs:100,idleTimeoutMs:300});server.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  const socket=connect(server.address().port,'127.0.0.1'),chunks=[];socket.on('data',chunk=>chunks.push(chunk));
  // Complete headers announce a body that never arrives.
  socket.write('POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\npartial');
  const started=Date.now();await once(socket,'close');
  assert.ok(Date.now()-started<5000,'the connection is closed long before the 300 s default');assert.doesNotMatch(Buffer.concat(chunks).toString(),/HTTP\/1\.1 200/,'the stalled request is never answered as a success');
  // Headers that never complete are cut off by the headers timeout.
  const slow=connect(server.address().port,'127.0.0.1');slow.write('GET / HTTP/1.1\r\nHost: x\r\n');const begun=Date.now();await once(slow,'close');assert.ok(Date.now()-begun<5000);
  // Ordinary requests still succeed.
  const body=await new Promise((resolve,reject)=>request({port:server.address().port,host:'127.0.0.1'},response=>{let text='';response.on('data',chunk=>text+=chunk);response.on('end',()=>resolve(text));}).on('error',reject).end());assert.equal(body,'ok');
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
