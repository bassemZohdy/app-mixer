// Exports one trace from five processes' worth of tracers to a real OpenTelemetry Collector and reads it back.
// Opt in with APP_MIXER_TEST_OTEL_COLLECTOR=docker (Docker must be running); the collector image is pinned below.
// Set APP_MIXER_TEST_OTEL_EXPORT to a file path to keep the collector's export as evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {once} from 'node:events';
import {copyFile,mkdtemp,mkdir,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {context,propagation,trace,SpanKind} from '@opentelemetry/api';
import {W3CTraceContextPropagator} from '@opentelemetry/core';
import {AsyncLocalStorageContextManager} from '@opentelemetry/context-async-hooks';
import {TracerProvider,SimpleSpanProcessor} from '@opentelemetry/sdk-trace';
import {resourceFromAttributes} from '@opentelemetry/resources';
import {OTLPTraceExporter} from '@opentelemetry/exporter-trace-otlp-http';
import {createProject} from '../dist/index.js';
import {ApplicationStore,createDataPlane,CapabilityRegistry,createCapabilityServer,createControlPlane,createRemoteControlConnector} from '../../core/dist/index.js';

const run=promisify(execFile);
const COLLECTOR_IMAGE='otel/opentelemetry-collector-contrib:0.162.0@sha256:39923a8e431bd1f57be82411999d389fcfe40857492e4365456d97a4c1f74be6';
const enabled=process.env.APP_MIXER_TEST_OTEL_COLLECTOR==='docker';
const collectorConfig=`receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
exporters:
  file:
    path: /out/traces.jsonl
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [file]
`;
// The generated workspace runs as its own process and exports through the same collector.
const bootstrap=`import {context,propagation,trace} from '@opentelemetry/api';
import {W3CTraceContextPropagator} from '@opentelemetry/core';
import {AsyncLocalStorageContextManager} from '@opentelemetry/context-async-hooks';
import {TracerProvider,SimpleSpanProcessor} from '@opentelemetry/sdk-trace';
import {resourceFromAttributes} from '@opentelemetry/resources';
import {OTLPTraceExporter} from '@opentelemetry/exporter-trace-otlp-http';
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());propagation.setGlobalPropagator(new W3CTraceContextPropagator());
trace.setGlobalTracerProvider(new TracerProvider({resource:resourceFromAttributes({'service.name':'app-mixer-workspace'}),spanProcessors:[new SimpleSpanProcessor({exporter:new OTLPTraceExporter({url:process.env.TEST_OTLP_TRACES_URL})})]}));
`;
const wait=async(predicate,label,limit=20000)=>{const end=Date.now()+limit;while(Date.now()<end){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('Timed out waiting for '+label);};
async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${server.address().port}`;}
async function close(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
// Flattens the collector's file export (one OTLP JSON request per line) into spans tagged with their service.
function collected(text){const spans=[];for(const line of text.split('\n')){if(!line.trim())continue;for(const resource of JSON.parse(line).resourceSpans??[]){const service=resource.resource?.attributes?.find(a=>a.key==='service.name')?.value?.stringValue;for(const scope of resource.scopeSpans??[])for(const span of scope.spans??[])spans.push({service,name:span.name,kind:span.kind,traceId:span.traceId,spanId:span.spanId,parentSpanId:span.parentSpanId||undefined,attributes:Object.fromEntries((span.attributes??[]).map(a=>[a.key,Object.values(a.value??{})[0]]))});}}return spans;}

test('one trace spans browser, workspace, Data Plane, capabilities and Control Plane in a real collector',{skip:enabled?false:'set APP_MIXER_TEST_OTEL_COLLECTOR=docker to run against a collector container',timeout:180000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'otel-collector-')),out=join(dir,'out'),name='app-mixer-otel-'+process.pid+'-'+Date.now();await mkdir(out);await mkdir(join(dir,'config'));await mkdir(join(dir,'workspace'));await writeFile(join(dir,'config','config.yaml'),collectorConfig);
 const manager=new AsyncLocalStorageContextManager().enable();context.setGlobalContextManager(manager);propagation.setGlobalPropagator(new W3CTraceContextPropagator());
 const providers=[],servers=[];let child,started=false;
 try{
  // On Linux the bind-mounted temp directory is private to this user, so the collector runs as the same user.
  const user=typeof process.getuid==='function'?['--user',process.getuid()+':'+process.getgid()]:[];
  await run('docker',['run','-d','--rm','--name',name,...user,'-p','127.0.0.1::4318','-v',join(dir,'config')+':/etc/otelcol-contrib:ro','-v',out+':/out',COLLECTOR_IMAGE,'--config=/etc/otelcol-contrib/config.yaml']);started=true;
  const port=(await run('docker',['port',name,'4318/tcp'])).stdout.trim().split('\n')[0].split(':').pop(),tracesUrl=`http://127.0.0.1:${port}/v1/traces`;
  await wait(async()=>{try{return (await fetch(tracesUrl,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).ok;}catch{return false;}},'the collector to accept OTLP');
  const tracer=service=>{const provider=new TracerProvider({resource:resourceFromAttributes({'service.name':service}),spanProcessors:[new SimpleSpanProcessor({exporter:new OTLPTraceExporter({url:tracesUrl})})]});providers.push(provider);return provider.getTracer(service);};

  // Data Plane serving the published application to the workspace.
  const published=new ApplicationStore({id:'demo-app',schemaVersion:1,revision:0,pages:[]});published.publish(0);
  const plane=createDataPlane(published,{tracing:{tracer:tracer('app-mixer-data-plane'),trustRemoteParent:true}});servers.push(plane);const planeUrl=await listen(plane);
  // Control Plane source the promotion capability pulls from.
  const sourceToken='source-secret-at-least-32-characters',source=new ApplicationStore({id:'demo',schemaVersion:1,revision:0,pages:[]}),target=new ApplicationStore({id:'demo',schemaVersion:1,revision:0,pages:[]});source.publish(0);
  const control=createControlPlane(source,sourceToken,undefined,undefined,undefined,undefined,undefined,{tracer:tracer('app-mixer-control-plane'),trustRemoteParent:true});servers.push(control);const controlUrl=await listen(control);
  // Capability service whose operation promotes through the remote connector, so its client spans run under the capability span.
  const capabilityTracer=tracer('app-mixer-capabilities'),actor={tenantId:'tenant-private',principalId:'actor-private'},capabilityToken='capability-secret-at-least-thirty-two-characters';
  const connector=createRemoteControlConnector({sourceOrigin:controlUrl,sourceToken,sourceEnvironment:'development',targetEnvironment:'production',applicationId:'demo',repository:target,allowLoopbackHttp:true,authorize:()=>true,audit:()=>{},discovery:{authorize:()=>true,audit:()=>{}},tracing:{tracer:capabilityTracer,propagate:true}});
  const registry=new CapabilityRegistry(()=>{});
  registry.register({operationId:'release.promote',method:'POST',path:'/release/promote'},{authorize:()=>true,validate:input=>input.confirm===true,execute:async()=>{const latest=await connector.discoverLatest(actor);const promoted=await connector.importPublication({actor,sourceVersion:latest.sourceVersion,expectedVersion:0});return {version:promoted.version};}});
  const capabilities=createCapabilityServer(registry,req=>req.headers.authorization===`Bearer ${capabilityToken}`?actor:undefined,()=>{},{tracer:capabilityTracer,trustRemoteParent:true});servers.push(capabilities);const capabilityUrl=await listen(capabilities);

  // Generated workspace in its own process, trusting the browser's trace parent and propagating to both services.
  const target_=await createProject('demo-app',join(dir,'workspace'));await symlink(fileURLToPath(new URL('../../../node_modules',import.meta.url)),join(target_,'node_modules'),'junction');await writeFile(join(target_,'trace-bootstrap.mjs'),bootstrap);
  child=spawn(process.execPath,['--import',pathToFileURL(join(target_,'trace-bootstrap.mjs')).href,'server.mjs'],{cwd:target_,env:{...process.env,PORT:'0',TEST_OTLP_TRACES_URL:tracesUrl,DATA_PLANE_URL:planeUrl+'/application',CAPABILITY_URL:capabilityUrl+'/capabilities/',CAPABILITY_TOKEN:capabilityToken,WORKSPACE_TRACING_ENABLED:'true',WORKSPACE_TRACING_TRUST_INCOMING:'true',WORKSPACE_TRACING_PROPAGATE:'true',WORKSPACE_TRACING_PROPAGATE_CAPABILITIES:'true'},stdio:['ignore','pipe','pipe']});
  let output='',errors='';child.stdout.on('data',part=>output+=part);child.stderr.on('data',part=>errors+=part);await wait(()=>/http:\/\/127\.0\.0\.1:\d+/.test(output)||child.exitCode!==null,'the workspace');assert.equal(child.exitCode,null,errors);const workspace=output.match(/http:\/\/127\.0\.0\.1:\d+/)[0];

  // The browser: a page-load span whose W3C context rides on both requests, as a browser OpenTelemetry SDK would send it.
  const browser=tracer('app-mixer-browser'),page=browser.startSpan('page load /releases',{kind:SpanKind.CLIENT});let traceId;
  await context.with(trace.setSpan(context.active(),page),async()=>{
   traceId=page.spanContext().traceId;const headers={};propagation.inject(context.active(),headers);
   const publication=await fetch(workspace+'/api/publication',{headers:{...headers,authorization:'Bearer browser-session-private'}});assert.equal(publication.status,200);await publication.text();
   const promote=await fetch(workspace+'/api/capabilities/release.promote',{method:'POST',headers:{...headers,origin:workspace,'content-type':'application/json'},body:JSON.stringify({confirm:true,note:'input-private'})});assert.equal(promote.status,200,await promote.clone().text());assert.deepEqual(await promote.json(),{result:{version:1}});
  });
  page.end();for(const provider of providers)await provider.forceFlush();

  const file=join(out,'traces.jsonl');let spans=[];
  await wait(async()=>{try{spans=collected(await readFile(file,'utf8')).filter(s=>s.traceId===traceId);}catch{return false;}const services=new Set(spans.map(s=>s.service));return ['app-mixer-browser','app-mixer-workspace','app-mixer-data-plane','app-mixer-capabilities','app-mixer-control-plane'].every(s=>services.has(s))&&spans.filter(s=>s.service==='app-mixer-control-plane').length>=2&&spans.filter(s=>s.service==='app-mixer-workspace').length>=4;},'the collector to write every service span');
  if(process.env.APP_MIXER_TEST_OTEL_EXPORT)await copyFile(file,process.env.APP_MIXER_TEST_OTEL_EXPORT);

  // Every hop is the child of the previous service's span, so the collector holds one connected tree.
  const byId=new Map(spans.map(s=>[s.spanId,s])),parentOf=s=>byId.get(s.parentSpanId),root=spans.find(s=>s.service==='app-mixer-browser');
  assert.equal(root.parentSpanId,undefined);for(const span of spans)if(span!==root)assert.ok(parentOf(span),'orphan span '+span.service+' '+span.name);
  const chain=span=>{const names=[];for(let at=span;at;at=parentOf(at))names.unshift(at.service);return names.filter((s,i,all)=>s!==all[i-1]);};
  const planeSpan=spans.find(s=>s.service==='app-mixer-data-plane');assert.deepEqual(chain(planeSpan),['app-mixer-browser','app-mixer-workspace','app-mixer-data-plane']);
  for(const route of ['/publications/latest','/promotion/export']){const server=spans.find(s=>s.service==='app-mixer-control-plane'&&s.attributes['http.route']===route);assert.ok(server,route);assert.deepEqual(chain(server),['app-mixer-browser','app-mixer-workspace','app-mixer-capabilities','app-mixer-control-plane']);}
  assert.equal(spans.find(s=>s.service==='app-mixer-capabilities'&&parentOf(s)?.service==='app-mixer-workspace').attributes['http.route'],'/capabilities/{operationId}/invoke');
  // Nothing sensitive reaches the collector from this instrumentation.
  const exported=await readFile(file,'utf8');for(const secret of [sourceToken,capabilityToken,'browser-session-private','input-private','release.promote','tenant-private','actor-private',controlUrl])assert.equal(exported.includes(secret),false,secret);
 }finally{
  if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}
  for(const server of servers)await close(server);for(const provider of providers)await provider.shutdown().catch(()=>{});
  context.disable();propagation.disable();manager.disable();
  if(started)await run('docker',['rm','-f',name]).catch(()=>{});
  await rm(dir,{recursive:true,force:true});
 }
});
