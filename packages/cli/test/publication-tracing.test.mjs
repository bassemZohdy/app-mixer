import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {context,propagation,SpanKind} from '@opentelemetry/api';
import {W3CTraceContextPropagator} from '@opentelemetry/core';
import {AsyncLocalStorageContextManager} from '@opentelemetry/context-async-hooks';
import {TracerProvider,SimpleSpanProcessor,InMemorySpanExporter} from '@opentelemetry/sdk-trace';
import {createProject} from '../dist/index.js';
import {ApplicationStore,createDataPlane} from '../../core/dist/index.js';

const bootstrap=`import {context,propagation,trace} from '@opentelemetry/api';
import {W3CTraceContextPropagator} from '@opentelemetry/core';
import {AsyncLocalStorageContextManager} from '@opentelemetry/context-async-hooks';
import {TracerProvider,SimpleSpanProcessor} from '@opentelemetry/sdk-trace';
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());propagation.setGlobalPropagator(new W3CTraceContextPropagator());
const exporter={export(spans,callback){for(const s of spans)process.stdout.write('SPAN '+JSON.stringify({name:s.name,kind:s.kind,context:s.spanContext(),parent:s.parentSpanContext,attributes:s.attributes})+'\\n');callback({code:0});},shutdown:async()=>{}};
trace.setGlobalTracerProvider(new TracerProvider({spanProcessors:[new SimpleSpanProcessor({exporter})]}));`;
const wait=async predicate=>{for(let i=0;i<200;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Timed out waiting for workspace');};

test('generated workspace traces publication request across the Data Plane', {timeout:15000},async()=>{
 const manager=new AsyncLocalStorageContextManager().enable();context.setGlobalContextManager(manager);propagation.setGlobalPropagator(new W3CTraceContextPropagator());const exporter=new InMemorySpanExporter(),provider=new TracerProvider({spanProcessors:[new SimpleSpanProcessor({exporter})]}),store=new ApplicationStore({id:'demo-app',schemaVersion:1,revision:0,pages:[]});store.publish(0);const plane=createDataPlane(store,{tracing:{tracer:provider.getTracer('data'),trustRemoteParent:true}});plane.listen(0,'127.0.0.1');await once(plane,'listening');const dir=await mkdtemp(join(tmpdir(),'workspace-trace-'));let child;
 try{
  const target=await createProject('demo-app',dir);await symlink(fileURLToPath(new URL('../../../node_modules',import.meta.url)),join(target,'node_modules'),'junction');await writeFile(join(target,'trace-bootstrap.mjs'),bootstrap);
  const env={...process.env,PORT:'0',DATA_PLANE_URL:`http://127.0.0.1:${plane.address().port}/application`,WORKSPACE_TRACING_ENABLED:'true',WORKSPACE_TRACING_TRUST_INCOMING:'true',WORKSPACE_TRACING_PROPAGATE:'true'};child=spawn(process.execPath,['--import',pathToFileURL(join(target,'trace-bootstrap.mjs')).href,'server.mjs'],{cwd:target,env,stdio:['ignore','pipe','pipe']});let output='',errors='';child.stdout.on('data',part=>output+=part);child.stderr.on('data',part=>errors+=part);await wait(()=>/http:\/\/127\.0\.0\.1:\d+/.test(output)||child.exitCode!==null);assert.equal(child.exitCode,null,errors);const url=output.match(/http:\/\/127\.0\.0\.1:\d+/)[0],parent='00-0123456789abcdef0123456789abcdef-0123456789abcdef-01';
  const response=await fetch(url+'/api/publication',{headers:{traceparent:parent,authorization:'Bearer private-secret'}});assert.equal(response.status,200);const etag=response.headers.get('etag');await response.text();assert.equal((await fetch(url+'/api/publication',{headers:{'if-none-match':etag}})).status,304);await wait(()=>output.split('\n').filter(line=>line.startsWith('SPAN ')).length>=4&&exporter.getFinishedSpans().length>=2);
  const spans=output.split('\n').filter(line=>line.startsWith('SPAN ')).map(line=>JSON.parse(line.slice(5))),server=spans.find(s=>s.kind===SpanKind.SERVER&&s.parent?.spanId==='0123456789abcdef'),client=spans.find(s=>s.kind===SpanKind.CLIENT&&s.parent?.spanId===server?.context.spanId),data=exporter.getFinishedSpans().find(s=>s.kind===SpanKind.SERVER&&s.parentSpanContext?.spanId===client?.context.spanId);assert.ok(server);assert.ok(client);assert.ok(data);assert.equal(data.spanContext().traceId,'0123456789abcdef0123456789abcdef');assert.ok(spans.some(s=>s.kind===SpanKind.CLIENT&&s.attributes['http.response.status_code']===304));assert.equal(JSON.stringify(spans).includes('private-secret'),false);
 }finally{if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}plane.closeAllConnections();await new Promise(resolve=>plane.close(resolve));await provider.shutdown();context.disable();propagation.disable();manager.disable();await rm(dir,{recursive:true,force:true});}
});

test('generated workspace does not propagate incoming traces by default', {timeout:15000},async()=>{
 propagation.setGlobalPropagator(new W3CTraceContextPropagator());const exporter=new InMemorySpanExporter(),provider=new TracerProvider({spanProcessors:[new SimpleSpanProcessor({exporter})]}),store=new ApplicationStore({id:'demo-app',schemaVersion:1,revision:0,pages:[]});store.publish(0);const plane=createDataPlane(store,{tracing:{tracer:provider.getTracer('data'),trustRemoteParent:true}});plane.listen(0,'127.0.0.1');await once(plane,'listening');const dir=await mkdtemp(join(tmpdir(),'workspace-no-trace-'));let child;
 try{const target=await createProject('demo-app',dir),env={...process.env,PORT:'0',DATA_PLANE_URL:`http://127.0.0.1:${plane.address().port}/application`,WORKSPACE_TRACING_ENABLED:'false',WORKSPACE_TRACING_TRUST_INCOMING:'false',WORKSPACE_TRACING_PROPAGATE:'false'};child=spawn(process.execPath,['server.mjs'],{cwd:target,env,stdio:['ignore','pipe','pipe']});let output='',errors='';child.stdout.on('data',part=>output+=part);child.stderr.on('data',part=>errors+=part);await wait(()=>/http:\/\/127\.0\.0\.1:\d+/.test(output)||child.exitCode!==null);assert.equal(child.exitCode,null,errors);const url=output.match(/http:\/\/127\.0\.0\.1:\d+/)[0];assert.equal((await fetch(url+'/api/publication',{headers:{traceparent:'00-0123456789abcdef0123456789abcdef-0123456789abcdef-01'}})).status,200);await wait(()=>exporter.getFinishedSpans().length>0);assert.equal(exporter.getFinishedSpans()[0].parentSpanContext,undefined);}finally{if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}plane.closeAllConnections();await new Promise(resolve=>plane.close(resolve));await provider.shutdown();propagation.disable();await rm(dir,{recursive:true,force:true});}
});
