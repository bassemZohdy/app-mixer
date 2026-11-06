// Operational behaviour of the shared extension approval store: revocation latency while two nodes check approvals
// under concurrent load, and fail-closed behaviour while one node loses its database connection.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import pg from 'pg';
import {PostgresExtensionApprovals} from '../dist/index.js';

const url=process.env.APP_MIXER_TEST_POSTGRES_URL;
const scope={tenantId:'tenant',applicationId:'demo'},admin={tenantId:'tenant',principalId:'admin'},service={tenantId:'tenant',principalId:'service'};
const reference={id:'example.report',version:'1.0.0',scope:'application'},operation={extensionId:'example.report',kind:'tool',name:'lookup'};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const percentile=(values,p)=>{const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.min(sorted.length-1,Math.floor(p*sorted.length))];};

/** A TCP proxy in front of PostgreSQL that can be cut (open connections dropped, new ones refused) and restored. */
async function outageProxy(target){
 const sockets=new Set();let down=false;
 const server=net.createServer(client=>{
  if(down){client.destroy();return;}
  const upstream=net.connect(Number(target.port||5432),target.hostname);
  for(const socket of [client,upstream]){sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));}
  client.pipe(upstream).pipe(client);client.on('close',()=>upstream.destroy());upstream.on('close',()=>client.destroy());
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 return {port:server.address().port,cut(){down=true;for(const socket of sockets)socket.destroy();},restore(){down=false;},close(){for(const socket of sockets)socket.destroy();return new Promise(resolve=>server.close(resolve));}};
}

/** `concurrency` loops checking the approval through one node's runtime hook; every call is recorded. */
function load(node,name,concurrency,calls){
 let running=true;const check=node.forRuntime(scope);
 const loops=Array.from({length:concurrency},async()=>{while(running){const start=performance.now();let result;try{result=await check(service,reference,operation);}catch{result='error';}calls.push({node:name,start,end:performance.now(),result});}});
 return async()=>{running=false;await Promise.all(loops);};
}

test('shared extension approvals revoke within one read under load and fail closed during a database outage',{skip:!url&&'set APP_MIXER_TEST_POSTGRES_URL to run against PostgreSQL',timeout:90000},async t=>{
 const schema='ext_ops_'+randomUUID().replaceAll('-',''),target=new URL(url),proxy=await outageProxy(target);
 const proxied=new URL(url);proxied.hostname='127.0.0.1';proxied.port=String(proxy.port);
 const adminPool=new pg.Pool({connectionString:url}),options=`-c search_path=${schema}`;
 const pools={a:new pg.Pool({connectionString:url,options,max:16}),b:new pg.Pool({connectionString:proxied.href,options,max:16,connectionTimeoutMillis:1000}),admin:new pg.Pool({connectionString:url,options,max:2})};
 for(const pool of Object.values(pools))pool.on('error',()=>{});
 const make=pool=>new PostgresExtensionApprovals({query:(sql,args)=>pool.query(sql,args),authorize:(actor,action)=>action==='invoke'?actor.principalId==='service':actor.principalId==='admin'});
 try{
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const nodeA=make(pools.a),nodeB=make(pools.b),control=make(pools.admin);await control.initialize();
  const grant=revision=>control.decide(admin,scope,reference,operation,{allowed:true,expiresAt:Date.now()+3600000,expectedRevision:revision});
  const revoke=revision=>control.decide(admin,scope,reference,operation,{allowed:false,expiresAt:0,expectedRevision:revision});

  // Phase 1: both nodes check continuously with 16 concurrent invocations each; an administrator revokes mid-load.
  await grant(0);const calls=[],stops=[load(nodeA,'a',16,calls),load(nodeB,'b',16,calls)];
  await sleep(2000);const revokeStart=performance.now();await revoke(1);const committed=performance.now();await sleep(1500);
  for(const stop of stops)await stop();
  const reads=calls.filter(call=>call.result!=='error').map(call=>call.end-call.start);
  assert.equal(calls.filter(call=>call.result==='error').length,0,'no failed checks under load');
  const after=calls.filter(call=>call.start>committed);
  assert.ok(after.length>100,'checks kept running after the revocation: '+after.length);
  assert.equal(after.filter(call=>call.result===true).length,0,'no check that started after the revocation committed was allowed');
  const stale=calls.filter(call=>call.result===true&&call.end>committed);
  const lastStale=stale.length?Math.max(...stale.map(call=>call.end))-committed:0;
  const firstDenied=Object.fromEntries(['a','b'].map(name=>[name,Math.min(...calls.filter(call=>call.node===name&&call.result===false).map(call=>call.end))-committed]));
  assert.ok(lastStale<=Math.max(...reads),'an allowed result after the commit came only from a check already in flight');
  const before=calls.filter(call=>call.end<revokeStart).length/2;
  t.diagnostic(`load: ${calls.length} checks across 2 nodes x 16 concurrent (${Math.round(before)} checks/s before revoking); read latency p50 ${percentile(reads,0.5).toFixed(1)} ms, p99 ${percentile(reads,0.99).toFixed(1)} ms, max ${Math.max(...reads).toFixed(1)} ms`);
  t.diagnostic(`revocation: committed in ${(committed-revokeStart).toFixed(1)} ms; 0 of ${after.length} later checks allowed; ${stale.length} in-flight checks returned allowed up to ${lastStale.toFixed(1)} ms after the commit; first denial seen ${firstDenied.a.toFixed(1)} ms (node a) and ${firstDenied.b.toFixed(1)} ms (node b) after the commit`);

  // Phase 2: node b loses its database. It must fail closed, and a revocation made meanwhile is seen on recovery.
  await grant(2);const outage=[],stopB=load(nodeB,'b',8,outage);await sleep(500);
  const cutAt=performance.now();proxy.cut();
  await assert.rejects(nodeB.decide(admin,scope,reference,operation,{allowed:false,expiresAt:0,expectedRevision:3}),'a decision through the lost connection fails');
  await sleep(300);await revoke(3);await sleep(1200);
  const restoredAt=performance.now();proxy.restore();
  for(const deadline=Date.now()+15000;!outage.some(call=>call.start>restoredAt&&call.result!=='error');await sleep(50))assert.ok(Date.now()<deadline,'node b recovers after the outage');
  await sleep(500);await stopB();
  const during=outage.filter(call=>call.start>=cutAt&&call.start<restoredAt),recovered=outage.filter(call=>call.start>restoredAt&&call.result!=='error');
  assert.ok(during.length>0);assert.equal(during.filter(call=>call.result===true).length,0,'no check during the outage was allowed');
  assert.ok(during.every(call=>call.result==='error'||call.result===false));
  assert.equal(recovered.filter(call=>call.result===true).length,0,'the revocation made during the outage holds after recovery');
  const recovery=Math.min(...recovered.map(call=>call.end))-restoredAt;
  assert.deepEqual(await control.inspect(admin,scope,reference,operation).then(state=>[state.revision,state.allowed]),[4,false],'the failed decision wrote nothing');
  assert.deepEqual((await control.history(admin,scope,reference,operation)).items.map(event=>[event.revision,event.allowed]),[[1,true],[2,false],[3,true],[4,false]]);
  t.diagnostic(`outage: ${during.length} checks on node b during a ${(restoredAt-cutAt).toFixed(0)} ms outage, ${during.filter(call=>call.result==='error').length} rejected and none allowed; first successful check ${recovery.toFixed(0)} ms after the database returned, denied by the revocation made during the outage`);
 }finally{await Promise.allSettled(Object.values(pools).map(pool=>pool.end()));await proxy.close();await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(()=>{});await adminPool.end();}
});
