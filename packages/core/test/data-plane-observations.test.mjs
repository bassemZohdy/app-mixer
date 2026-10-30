import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {get} from 'node:http';
import {ApplicationStore,createDataPlane} from '../dist/index.js';

const initial={id:'demo',schemaVersion:1,revision:0,pages:[]};
async function start(server){server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${server.address().port}`;}
async function stop(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}

test('observations classify bounded routes and response classes without exposing paths or headers',async()=>{
 const store=new ApplicationStore(initial);store.publish(0);const events=[],server=createDataPlane(store,{health:{timeoutMs:100},observe:event=>events.push(event)}),base=await start(server);
 try{const response=await fetch(base+'/application',{headers:{authorization:'Bearer secret'}});assert.equal(response.status,200);const etag=response.headers.get('etag');assert.equal((await fetch(base+'/application',{headers:{'if-none-match':etag}})).status,304);assert.equal((await fetch(base+'/application/versions/999')).status,404);assert.equal((await fetch(base+'/health/ready')).status,200);assert.equal((await fetch(base+'/private-secret')).status,404);assert.deepEqual(events.map(({route,statusClass,outcome})=>({route,statusClass,outcome})),[{route:'application',statusClass:'2xx',outcome:'completed'},{route:'application',statusClass:'3xx',outcome:'completed'},{route:'version',statusClass:'4xx',outcome:'completed'},{route:'ready',statusClass:'2xx',outcome:'completed'},{route:'other',statusClass:'4xx',outcome:'completed'}]);assert.ok(events.every(event=>Number.isFinite(event.durationMs)&&event.durationMs>=0));assert.equal(JSON.stringify(events).includes('secret'),false);}finally{await stop(server);}
});

test('observer failures cannot affect serving or leak rejection',async()=>{
 const store=new ApplicationStore(initial);store.publish(0);assert.throws(()=>createDataPlane(store,{observe:'invalid'}),/observer/);let calls=0;const server=createDataPlane(store,{observe:()=>{calls++;return Promise.reject(Error('unavailable'));}}),base=await start(server);
 try{assert.equal((await fetch(base+'/application')).status,200);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);}finally{await stop(server);}
});

test('client disconnect records one aborted observation',async()=>{
 const store=new ApplicationStore(initial);store.publish(0);let started,release,observed;const ready=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve),event=new Promise(resolve=>observed=resolve),events=[],server=createDataPlane(store,{health:{timeoutMs:1000,check:async()=>{started();await gate;return true;}},observe:item=>{events.push(item);observed();}}),base=await start(server);
 try{const request=get(base+'/health/ready');request.on('error',()=>{});await ready;request.destroy();await event;assert.equal(events.length,1);assert.deepEqual({route:events[0].route,outcome:events[0].outcome,statusClass:events[0].statusClass},{route:'ready',outcome:'aborted',statusClass:'none'});release();await new Promise(resolve=>setImmediate(resolve));assert.equal(events.length,1);}finally{release();await stop(server);}
});
