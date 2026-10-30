import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {ApplicationStore,createDataPlane,DataPlaneRequestMetrics} from '../dist/index.js';

test('bounded metrics produce cumulative histograms in seconds',()=>{
 const metrics=new DataPlaneRequestMetrics(),event={route:'application',outcome:'completed',statusClass:'2xx',durationMs:5};metrics.observe(event);metrics.observe({...event,durationMs:50});metrics.observe({route:'other',outcome:'aborted',statusClass:'none',durationMs:20000});const value=metrics.render(),labels='route="application",outcome="completed",status_class="2xx"';
 assert.ok(value.includes(`app_mixer_data_plane_requests_total{${labels}} 2\n`));assert.ok(value.includes(`app_mixer_data_plane_request_duration_seconds_bucket{${labels},le="0.005"} 1\n`));assert.ok(value.includes(`app_mixer_data_plane_request_duration_seconds_bucket{${labels},le="0.05"} 2\n`));assert.ok(value.includes(`app_mixer_data_plane_request_duration_seconds_bucket{${labels},le="+Inf"} 2\n`));assert.ok(value.includes(`app_mixer_data_plane_request_duration_seconds_sum{${labels}} 0.055\n`));assert.ok(value.includes('outcome="aborted",status_class="none"'));
});

test('invalid observations cannot create dynamic labels or corrupt the snapshot',()=>{
 const metrics=new DataPlaneRequestMetrics(),before=metrics.render(),valid={route:'other',outcome:'completed',statusClass:'4xx',durationMs:1};
 for(const bad of [{...valid,route:'user-id'},{...valid,statusClass:'private'},{...valid,outcome:'aborted'},{...valid,durationMs:NaN},{...valid,durationMs:-1}])assert.throws(()=>metrics.observe(bad),/observation/);assert.equal(metrics.render(),before);
});

test('Data Plane observations feed a metrics instance without including request data',async()=>{
 const metrics=new DataPlaneRequestMetrics(),store=new ApplicationStore({id:'demo',schemaVersion:1,revision:0,pages:[]});store.publish(0);const server=createDataPlane(store,{observe:metrics.observe});server.listen(0,'127.0.0.1');await once(server,'listening');
 try{const base=`http://127.0.0.1:${server.address().port}`;assert.equal((await fetch(base+'/application',{headers:{authorization:'Bearer secret'}})).status,200);assert.equal((await fetch(base+'/secret-path')).status,404);const value=metrics.render();assert.ok(value.includes('route="application",outcome="completed",status_class="2xx"'));assert.ok(value.includes('route="other",outcome="completed",status_class="4xx"'));assert.equal(value.includes('secret'),false);}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
