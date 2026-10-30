import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {ApplicationStore,createDataPlane} from '../dist/index.js';

const initial={id:'demo',schemaVersion:1,revision:0,pages:[]};
async function start(server){server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${server.address().port}`;}
async function stop(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}

test('health probes reflect local readiness independently of the control plane',async()=>{
 const store=new ApplicationStore(initial),server=createDataPlane(store,{health:{timeoutMs:100}}),base=await start(server);
 try{assert.equal((await fetch(base+'/health/live')).status,200);assert.equal((await fetch(base+'/health/ready')).status,503);store.publish(0);const ready=await fetch(base+'/health/ready');assert.equal(ready.status,200);assert.equal(ready.headers.get('cache-control'),'no-store');assert.deepEqual(await ready.json(),{status:'ready'});assert.equal((await fetch(base+'/application')).status,200);assert.equal((await fetch(base+'/health/live',{method:'POST'})).status,404);}finally{await stop(server);}
});

test('failed and timed-out dependency checks fail closed without multiplying stuck calls',async()=>{
 const store=new ApplicationStore(initial);store.publish(0);let calls=0,finish;const blocked=new Promise(resolve=>finish=resolve),server=createDataPlane(store,{health:{timeoutMs:100,check:async signal=>{calls++;assert.equal(signal.aborted,false);return blocked;}}}),base=await start(server);
 try{const responses=await Promise.all([fetch(base+'/health/ready'),fetch(base+'/health/ready')]);assert.deepEqual(responses.map(x=>x.status),[503,503]);assert.equal(calls,1);assert.equal((await fetch(base+'/health/live')).status,200);assert.equal((await fetch(base+'/health/ready')).status,503);assert.equal(calls,1);finish(true);await new Promise(resolve=>setImmediate(resolve));assert.equal((await fetch(base+'/health/ready')).status,200);assert.equal(calls,2);}finally{finish(true);await stop(server);}
});

test('health routes are opt-in and reject invalid options',async()=>{
 const store=new ApplicationStore(initial);assert.throws(()=>createDataPlane(store,{health:{timeoutMs:0}}),/configuration/);assert.throws(()=>createDataPlane(store,{health:{timeoutMs:100,check:'bad'}}),/configuration/);const server=createDataPlane(store),base=await start(server);try{assert.equal((await fetch(base+'/health/live')).status,404);}finally{await stop(server);}
});

test('dependency errors are sanitized and do not break liveness',async()=>{
 const store=new ApplicationStore(initial);store.publish(0);const server=createDataPlane(store,{health:{timeoutMs:100,check:()=>{throw Error('secret dependency error');}}}),base=await start(server);
 try{const response=await fetch(base+'/health/ready');assert.equal(response.status,503);assert.deepEqual(await response.json(),{status:'unavailable'});assert.equal((await fetch(base+'/health/live')).status,200);}finally{await stop(server);}
});
