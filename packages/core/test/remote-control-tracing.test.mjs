import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {context,propagation,SpanKind,SpanStatusCode} from '@opentelemetry/api';
import {W3CTraceContextPropagator} from '@opentelemetry/core';
import {AsyncLocalStorageContextManager} from '@opentelemetry/context-async-hooks';
import {TracerProvider,SimpleSpanProcessor,InMemorySpanExporter} from '@opentelemetry/sdk-trace';
import {ApplicationStore,createControlPlane,createRemoteControlConnector} from '../dist/index.js';

const initial={id:'demo',schemaVersion:1,revision:0,pages:[]},token='source-secret-at-least-32-characters',actor={tenantId:'tenant',principalId:'admin'};
async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${server.address().port}`;}
async function close(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
function options(origin,repo,tracing){return {sourceOrigin:origin,sourceToken:token,sourceEnvironment:'development',targetEnvironment:'production',applicationId:'demo',repository:repo,allowLoopbackHttp:true,authorize:()=>true,audit:()=>{},discovery:{authorize:()=>true,audit:()=>{}},tracing};}

test('connector and Control Plane spans form a cross-service trace without sensitive request fields',async()=>{
 const manager=new AsyncLocalStorageContextManager().enable();context.setGlobalContextManager(manager);propagation.setGlobalPropagator(new W3CTraceContextPropagator());const exporter=new InMemorySpanExporter(),provider=new TracerProvider({spanProcessors:[new SimpleSpanProcessor({exporter})]}),tracer=provider.getTracer('test'),source=new ApplicationStore(initial),target=new ApplicationStore(initial);source.publish(0);
 const control=createControlPlane(source,token,undefined,undefined,undefined,undefined,undefined,{tracer,trustRemoteParent:true}),origin=await listen(control);
 try{const connector=createRemoteControlConnector(options(origin,target,{tracer,propagate:true}));assert.equal((await connector.discoverLatest(actor)).sourceVersion,1);assert.equal((await connector.importPublication({actor,sourceVersion:1,expectedVersion:0})).version,1);
  const spans=exporter.getFinishedSpans();for(const route of ['/publications/latest','/promotion/export']){const client=spans.find(s=>s.kind===SpanKind.CLIENT&&s.attributes['url.path']===route),server=spans.find(s=>s.kind===SpanKind.SERVER&&s.attributes['http.route']===route);assert.ok(client);assert.ok(server);assert.equal(server.spanContext().traceId,client.spanContext().traceId);assert.equal(server.parentSpanContext.spanId,client.spanContext().spanId);assert.equal(client.attributes['http.response.status_code'],200);}
  const exposed=JSON.stringify(spans.map(s=>({name:s.name,attributes:s.attributes})));for(const value of [token,'tenant','admin',origin])assert.equal(exposed.includes(value),false);
 }finally{await close(control);await provider.shutdown();context.disable();propagation.disable();manager.disable();}
});

test('propagation is disabled by default and client errors are sanitized',async()=>{
 const manager=new AsyncLocalStorageContextManager().enable();context.setGlobalContextManager(manager);propagation.setGlobalPropagator(new W3CTraceContextPropagator());const exporter=new InMemorySpanExporter(),provider=new TracerProvider({spanProcessors:[new SimpleSpanProcessor({exporter})]}),tracer=provider.getTracer('test'),source=new ApplicationStore(initial),target=new ApplicationStore(initial);source.publish(0);const control=createControlPlane(source,token,undefined,undefined,undefined,undefined,undefined,{tracer,trustRemoteParent:true}),origin=await listen(control);
 try{await createRemoteControlConnector(options(origin,target,{tracer})).discoverLatest(actor);const spans=exporter.getFinishedSpans(),client=spans.find(s=>s.kind===SpanKind.CLIENT),server=spans.find(s=>s.kind===SpanKind.SERVER);assert.ok(client);assert.ok(server);assert.equal(server.parentSpanContext,undefined);assert.notEqual(client.spanContext().traceId,server.spanContext().traceId);
  const denied=createRemoteControlConnector({...options(origin,target,{tracer,propagate:true}),sourceToken:'wrong-token-at-least-32-characters'});await assert.rejects(denied.discoverLatest(actor),/discovery failed/);const failed=exporter.getFinishedSpans().filter(s=>s.kind===SpanKind.CLIENT).at(-1);assert.equal(failed.status.code,SpanStatusCode.ERROR);assert.equal(failed.attributes['http.response.status_code'],401);assert.equal(failed.events.length,0);
 }finally{await close(control);await provider.shutdown();context.disable();propagation.disable();manager.disable();}
});

test('telemetry failures do not block an authorized discovery or import',async()=>{
 const source=new ApplicationStore(initial),target=new ApplicationStore(initial);source.publish(0);const broken={startSpan(){throw Error('telemetry unavailable');}},control=createControlPlane(source,token,undefined,undefined,undefined,undefined,undefined,{tracer:broken}),origin=await listen(control);
 try{const connector=createRemoteControlConnector(options(origin,target,{tracer:broken,propagate:true}));assert.equal((await connector.discoverLatest(actor)).sourceVersion,1);assert.equal((await connector.importPublication({actor,sourceVersion:1,expectedVersion:0})).version,1);}finally{await close(control);}
});
