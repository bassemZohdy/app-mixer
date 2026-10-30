import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {DataPlaneRequestMetrics,createMetricsServer} from '../dist/index.js';

async function start(server){server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${server.address().port}`;}
async function stop(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}

test('metrics scraping requires host authorization and emits Prometheus text',async()=>{
 const metrics=new DataPlaneRequestMetrics();metrics.observe({route:'application',outcome:'completed',statusClass:'2xx',durationMs:8});const server=createMetricsServer({metrics,authorize:req=>req.headers.authorization==='Bearer trusted',timeoutMs:500,maxPending:2}),base=await start(server);
 try{assert.equal((await fetch(base+'/metrics')).status,401);assert.equal((await fetch(base+'/other')).status,404);assert.equal((await fetch(base+'/metrics',{method:'POST'})).status,404);const response=await fetch(base+'/metrics',{headers:{authorization:'Bearer trusted'}});assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/^text\/plain; version=0\.0\.4/);assert.equal(response.headers.get('cache-control'),'no-store');assert.match(await response.text(),/app_mixer_data_plane_requests_total/);}finally{await stop(server);}
});

test('stuck authorization times out, aborts and is bounded until it settles',async()=>{
 const metrics=new DataPlaneRequestMetrics();let finish,calls=0,signal;const blocked=new Promise(resolve=>finish=resolve),server=createMetricsServer({metrics,timeoutMs:100,maxPending:1,authorize:(_req,s)=>{calls++;signal=s;return blocked;}}),base=await start(server);
 try{assert.equal((await fetch(base+'/metrics')).status,503);assert.equal(signal.aborted,true);assert.equal((await fetch(base+'/metrics')).status,503);assert.equal(calls,1);finish(true);await new Promise(resolve=>setImmediate(resolve));assert.equal((await fetch(base+'/metrics')).status,200);assert.equal(calls,2);}finally{finish(true);await stop(server);}
});

test('invalid or failing authorization does not reveal exception details',async()=>{
 const metrics=new DataPlaneRequestMetrics();assert.throws(()=>createMetricsServer({metrics,timeoutMs:0,maxPending:1,authorize:()=>true}),/configuration/);const server=createMetricsServer({metrics,timeoutMs:100,maxPending:1,authorize:()=>{throw Error('private credential');}}),base=await start(server);
 try{const response=await fetch(base+'/metrics');assert.equal(response.status,401);assert.equal((await response.text()).includes('private'),false);}finally{await stop(server);}
});
