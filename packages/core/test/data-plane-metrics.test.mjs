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

test('state gauges expose start time, draining and served publication version only',()=>{
 const metrics=new DataPlaneRequestMetrics(()=>1700000123456);let text=metrics.render();
 assert.match(text,/^app_mixer_data_plane_start_time_seconds 1700000123$/m);assert.match(text,/^app_mixer_data_plane_draining 0$/m);assert.doesNotMatch(text,/publication_version [0-9]/);
 metrics.setPublicationVersion(7);metrics.setDraining(true);text=metrics.render();assert.match(text,/^app_mixer_data_plane_publication_version 7$/m);assert.match(text,/^app_mixer_data_plane_draining 1$/m);
 for(const bad of [0,1.5,'2',NaN])assert.throws(()=>metrics.setPublicationVersion(bad),/Invalid publication version/);assert.throws(()=>metrics.setDraining(1),/Invalid draining state/);
 for(const bad of [()=>-1,()=>NaN,'x'])assert.throws(()=>new DataPlaneRequestMetrics(bad),/Invalid metrics clock/);
});

test('readiness gauges track only completed readiness responses and retain their observation time',()=>{
 let now=1700000000000;const metrics=new DataPlaneRequestMetrics(()=>now),base={route:'ready',outcome:'completed',statusClass:'2xx',durationMs:5};assert.doesNotMatch(metrics.render(),/^app_mixer_data_plane_last_readiness /m);
 now+=1000;metrics.observe(base);assert.match(metrics.render(),/^app_mixer_data_plane_last_readiness 1$/m);assert.match(metrics.render(),/^app_mixer_data_plane_last_readiness_time_seconds 1700000001$/m);
 now+=1000;metrics.observe({...base,outcome:'aborted',statusClass:'none'});metrics.observe({...base,route:'application',statusClass:'5xx'});assert.match(metrics.render(),/^app_mixer_data_plane_last_readiness 1$/m);assert.match(metrics.render(),/^app_mixer_data_plane_last_readiness_time_seconds 1700000001$/m);
 now+=1000;metrics.observe({...base,statusClass:'5xx'});assert.match(metrics.render(),/^app_mixer_data_plane_last_readiness 0$/m);assert.match(metrics.render(),/^app_mixer_data_plane_last_readiness_time_seconds 1700000003$/m);const before=metrics.render();now=NaN;assert.throws(()=>metrics.observe(base),/Invalid metrics clock/);assert.equal(metrics.render(),before);
});

test('readiness gauges reflect Data Plane dependency failures and shutdown draining',async()=>{
 let now=1700000000000,healthy=true;const metrics=new DataPlaneRequestMetrics(()=>now),store=new ApplicationStore({id:'demo',schemaVersion:1,revision:0,pages:[]});store.publish(0);const server=createDataPlane(store,{health:{timeoutMs:500,check:()=>healthy},observe:metrics.observe});server.listen(0,'127.0.0.1');await once(server,'listening');
 try{const url=`http://127.0.0.1:${server.address().port}/health/ready`;assert.equal((await fetch(url)).status,200);assert.match(metrics.render(),/^app_mixer_data_plane_last_readiness 1$/m);healthy=false;now+=1000;assert.equal((await fetch(url)).status,503);assert.match(metrics.render(),/^app_mixer_data_plane_last_readiness 0$/m);assert.match(metrics.render(),/^app_mixer_data_plane_last_readiness_time_seconds 1700000001$/m);healthy=true;now+=1000;server.beginDrain();assert.equal((await fetch(url)).status,503);assert.match(metrics.render(),/^app_mixer_data_plane_last_readiness_time_seconds 1700000002$/m);}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
