import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {request} from 'node:http';
import {context,propagation,SpanKind,SpanStatusCode} from '@opentelemetry/api';
import {W3CTraceContextPropagator} from '@opentelemetry/core';
import {AsyncLocalStorageContextManager} from '@opentelemetry/context-async-hooks';
import {TracerProvider,SimpleSpanProcessor,InMemorySpanExporter} from '@opentelemetry/sdk-trace';
import {ApplicationStore,createDataPlane} from '../dist/index.js';

const initial={id:'demo',schemaVersion:1,revision:0,pages:[]},parent='00-0123456789abcdef0123456789abcdef-0123456789abcdef-01';
async function start(server){server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${server.address().port}`;}
async function stop(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
function duplicate(base){return new Promise((resolve,reject)=>{const req=request(base+'/application',{headers:['host',new URL(base).host,'traceparent',parent,'traceparent',parent]},res=>{res.resume();res.on('end',resolve);});req.on('error',reject);req.end();});}

test('tracing propagates trusted parents and active context without recording request data',async()=>{
 const manager=new AsyncLocalStorageContextManager().enable();context.setGlobalContextManager(manager);propagation.setGlobalPropagator(new W3CTraceContextPropagator());const exporter=new InMemorySpanExporter(),provider=new TracerProvider({spanProcessors:[new SimpleSpanProcessor({exporter})]}),tracer=provider.getTracer('test'),store=new ApplicationStore(initial);store.publish(0);
 const repository={getPublished(version){const child=tracer.startSpan('repository',undefined,context.active());child.end();return store.getPublished(version);}},server=createDataPlane(repository,{tracing:{tracer,trustRemoteParent:true},health:{timeoutMs:100}}),base=await start(server);
 try{
  assert.equal((await fetch(base+'/application',{headers:{traceparent:parent,authorization:'Bearer secret'}})).status,200);
  assert.equal((await fetch(base+'/application/versions/1',{headers:{traceparent:parent}})).status,200);
  assert.equal((await fetch(base+'/private-path?token=secret',{headers:{traceparent:parent}})).status,404);await duplicate(base);
  const spans=exporter.getFinishedSpans(),requests=spans.filter(s=>s.kind===SpanKind.SERVER),first=requests.find(s=>s.name==='GET /application'&&s.parentSpanContext?.spanId==='0123456789abcdef');assert.ok(first);assert.equal(first.spanContext().traceId,'0123456789abcdef0123456789abcdef');assert.equal(first.attributes['http.response.status_code'],200);
  assert.ok(spans.some(s=>s.name==='repository'&&s.parentSpanContext?.spanId===first.spanContext().spanId));assert.ok(requests.some(s=>s.name==='GET /application/versions/{version}'));assert.ok(requests.some(s=>s.name==='GET'&&s.attributes['http.response.status_code']===404));assert.ok(requests.some(s=>s.name==='GET /application'&&!s.parentSpanContext));assert.equal(JSON.stringify(requests.map(s=>({name:s.name,attributes:s.attributes}))).includes('secret'),false);assert.equal(JSON.stringify(requests.map(s=>({name:s.name,attributes:s.attributes}))).includes('private-path'),false);
 }finally{await stop(server);await provider.shutdown();context.disable();propagation.disable();manager.disable();}
});

test('remote parents are ignored by default and instrumentation failure does not break requests',async()=>{
 const exporter=new InMemorySpanExporter(),provider=new TracerProvider({spanProcessors:[new SimpleSpanProcessor({exporter})]}),tracer=provider.getTracer('test'),store=new ApplicationStore(initial);store.publish(0);propagation.setGlobalPropagator(new W3CTraceContextPropagator());const server=createDataPlane(store,{tracing:{tracer}}),base=await start(server);
 try{assert.equal((await fetch(base+'/application',{headers:{traceparent:parent}})).status,200);assert.equal(exporter.getFinishedSpans()[0].parentSpanContext,undefined);}finally{await stop(server);await provider.shutdown();propagation.disable();}
 const broken=createDataPlane(store,{tracing:{tracer:{startSpan(){throw Error('export failed');}}}}),url=await start(broken);try{assert.equal((await fetch(url+'/application')).status,200);}finally{await stop(broken);}
 assert.throws(()=>createDataPlane(store,{tracing:{tracer,trustRemoteParent:'yes'}}),/configuration/);
});

test('failed dependencies and disconnected clients end server spans',async()=>{
 const exporter=new InMemorySpanExporter(),provider=new TracerProvider({spanProcessors:[new SimpleSpanProcessor({exporter})]}),tracer=provider.getTracer('test');let finish,entered;const gate=new Promise(resolve=>finish=resolve),ready=new Promise(resolve=>entered=resolve),server=createDataPlane({getPublished(){return {version:1,definition:initial};}},{tracing:{tracer},health:{timeoutMs:1000,check:async()=>{entered();await gate;return true;}}}),base=await start(server),abort=new AbortController();
 try{const pending=fetch(base+'/health/ready',{signal:abort.signal}).catch(()=>{});await ready;abort.abort();await pending;for(let i=0;i<100&&!exporter.getFinishedSpans().length;i++)await new Promise(resolve=>setTimeout(resolve,10));const span=exporter.getFinishedSpans()[0];assert.equal(span.status.code,SpanStatusCode.ERROR);assert.equal(span.attributes['error.type'],'client_disconnect');}finally{finish();await stop(server);await provider.shutdown();}
});

test('server errors are marked without recording exception details',async()=>{
 const exporter=new InMemorySpanExporter(),provider=new TracerProvider({spanProcessors:[new SimpleSpanProcessor({exporter})]}),server=createDataPlane({getPublished(){throw Error('private failure');}},{tracing:{tracer:provider.getTracer('test')}}),base=await start(server);
 try{assert.equal((await fetch(base+'/application')).status,500);const span=exporter.getFinishedSpans()[0];assert.equal(span.status.code,SpanStatusCode.ERROR);assert.equal(span.attributes['http.response.status_code'],500);assert.equal(span.events.length,0);}finally{await stop(server);await provider.shutdown();}
});
