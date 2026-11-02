import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {ApplicationStore,createDataPlane} from '../dist/index.js';
const initial={id:'demo',schemaVersion:1,revision:0,pages:[]};
async function start(server){server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${server.address().port}`;}
async function stop(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}

test('bounded publication reads time out, retain capacity and discard late results',async()=>{
 const store=new ApplicationStore(initial);store.publish(0);let release,entered,signal,block=true,calls=0;const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>entered=resolve),repository={getPublished(){throw Error('legacy lookup not expected');},async getPublishedWithSignal(version,current){calls++;if(block){signal=current;entered();await gate;}return store.getPublished(version);}},server=createDataPlane(repository,{health:{timeoutMs:1000},publicationReadLimits:{timeoutMs:100,maxPending:1},authorizePublication:()=>true}),base=await start(server);try{const pending=fetch(base+'/application/versions/1');await ready;assert.equal((await pending).status,503);assert.equal(signal.aborted,true);assert.equal((await fetch(base+'/application')).status,503);assert.equal(calls,1);assert.equal((await fetch(base+'/health/live')).status,200);block=false;release();await new Promise(resolve=>setImmediate(resolve));let response;for(let i=0;i<100;i++){response=await fetch(base+'/application');if(response.status!==503)break;await new Promise(resolve=>setTimeout(resolve,10));}assert.equal(response.status,200);assert.equal((await response.json()).version,1);assert.equal(calls,2);
 }finally{release?.();await stop(server);}
});

test('disconnected publication reads abort the host signal and retain their slot until settled',async()=>{
 const store=new ApplicationStore(initial);store.publish(0);let release,entered,signal,block=true;const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>entered=resolve),repository={getPublished:version=>store.getPublished(version),async getPublishedWithSignal(version,current){if(block){signal=current;entered();await gate;}return store.getPublished(version);}},server=createDataPlane(repository,{publicationReadLimits:{timeoutMs:1000,maxPending:1}}),base=await start(server);try{const abort=new AbortController(),pending=fetch(base+'/application',{signal:abort.signal}).catch(error=>error);await ready;abort.abort();await pending;for(let i=0;i<100&&!signal.aborted;i++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(signal.aborted,true);assert.equal((await fetch(base+'/application')).status,503);block=false;release();await new Promise(resolve=>setImmediate(resolve));let result;for(let i=0;i<100;i++){result=await fetch(base+'/application');if(result.status!==503)break;await new Promise(resolve=>setTimeout(resolve,10));}assert.equal(result.status,200);
 }finally{release?.();await stop(server);}
});

test('readiness passes its timeout signal to the optional publication lookup',async()=>{
 let entered,observed,checks=0;const ready=new Promise(resolve=>entered=resolve),repository={getPublished:()=>{throw Error('legacy lookup not expected');},async getPublishedWithSignal(_version,signal){observed=signal;entered();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));return {version:1,definition:initial};}},server=createDataPlane(repository,{health:{timeoutMs:100,check:()=>{checks++;return true;}}}),base=await start(server);try{const pending=fetch(base+'/health/ready');await ready;assert.equal((await pending).status,503);assert.equal(observed.aborted,true);assert.equal(checks,0);}finally{await stop(server);}
});

test('publication read bounds validate configuration and preserve authorization order',async()=>{
 const store=new ApplicationStore(initial);store.publish(0);for(const publicationReadLimits of [{},{timeoutMs:100},{maxPending:1},{timeoutMs:99,maxPending:1},{timeoutMs:30001,maxPending:1},{timeoutMs:100,maxPending:0},{timeoutMs:100,maxPending:101},{timeoutMs:100,maxPending:1,extra:true}])assert.throws(()=>createDataPlane(store,{publicationReadLimits}),/read limits/);assert.throws(()=>createDataPlane({getPublished:()=>undefined,getPublishedWithSignal:1}),/repository/);let reads=0;const server=createDataPlane({getPublished(){reads++;throw Error('private');}},{publicationReadLimits:{timeoutMs:100,maxPending:1},authorizePublication:req=>req.headers.authorization==='yes'}),base=await start(server);try{assert.equal((await fetch(base+'/application')).status,403);assert.equal(reads,0);const result=await fetch(base+'/application',{headers:{authorization:'yes'}});assert.equal(result.status,503);assert.doesNotMatch(await result.text(),/private/);assert.equal(reads,1);}finally{await stop(server);}
});
