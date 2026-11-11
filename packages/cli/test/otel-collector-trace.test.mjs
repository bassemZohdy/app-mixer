// Exports one trace from five processes' worth of tracers to a real OpenTelemetry Collector and reads it back.
// Opt in with APP_MIXER_TEST_OTEL_COLLECTOR=docker (Docker must be running); the collector image is pinned below.
// Set APP_MIXER_TEST_OTEL_EXPORT to a file path to keep the collector's export as evidence.
// The browser variant also needs headless Chrome or Edge (CHROME_BIN, or found in the usual install location).
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {createServer,request as httpRequest} from 'node:http';
import {existsSync,statSync,readFileSync} from 'node:fs';
import {once} from 'node:events';
import {copyFile,mkdtemp,mkdir,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,sep} from 'node:path';
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
const collectorConfig=port=>`receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:${port}
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
const freePort=async()=>{const {createServer}=await import('node:net'),probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const {port}=probe.address();await new Promise(resolve=>probe.close(resolve));return port;};

// A real browser for the browser variant: CHROME_BIN, or Chrome or Edge where they are normally installed.
const browserBinary=process.env.CHROME_BIN||['/usr/bin/google-chrome','/usr/bin/chromium','C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(path=>existsSync(path));
// Serves the OpenTelemetry web SDK's ESM builds straight from node_modules: extensionless and directory imports redirect
// to the real file, and each package's browser field picks its browser platform files, as a bundler would.
const missing=[];
const modulesRoot=fileURLToPath(new URL('../../../node_modules/',import.meta.url));
function packageRoot(file){const parts=relative(modulesRoot,file).split(sep);return join(modulesRoot,...parts.slice(0,parts[0].startsWith('@')?2:1));}
// A package's own `#name` imports (its package.json "imports" map, which the OpenTelemetry 3.x packages use for platform code) are rewritten to the
// file a bundler would pick for the browser: the first browser, module, import or default entry, never the node, require or source-only ones.
function withPackageImports(root,file,source){
 const imports=JSON.parse(readFileSync(join(root,'package.json'),'utf8')).imports;if(!imports||!source.includes('#'))return source;
 const target=value=>{if(typeof value==='string')return value;if(!value||typeof value!=='object')return undefined;for(const key of ['browser','module','import','default']){const found=target(value[key]);if(found)return found;}return undefined;};
 return source.replace(/(\bfrom\s*|\bimport\s*\(?\s*)(['"])(#[\w-]+)\2/g,(match,lead,quote,name)=>{const resolved=target(imports[name]);if(!resolved)return match;return lead+quote+'/m/'+relative(modulesRoot,join(root,resolved)).split(sep).join('/')+quote;});
}
function serveModule(path,res){
 const file=join(modulesRoot,...path.split('/'));if(!file.startsWith(modulesRoot)||!file.includes(sep+'@opentelemetry'+sep)){res.writeHead(404).end();return;}
 const redirect=to=>res.writeHead(302,{location:'/m/'+relative(modulesRoot,to).split(sep).join('/')}).end();
 if(existsSync(file)&&statSync(file).isFile()){const root=packageRoot(file),browser=JSON.parse(readFileSync(join(root,'package.json'),'utf8')).browser,mapped=typeof browser==='object'?browser['./'+relative(root,file).split(sep).join('/')]:undefined;if(typeof mapped==='string'&&join(root,mapped)!==file){redirect(join(root,mapped));return;}res.writeHead(200,{'content-type':'text/javascript'}).end(withPackageImports(root,file,readFileSync(file,'utf8')));return;}
 if(existsSync(file+'.js')){redirect(file+'.js');return;}if(existsSync(join(file,'index.js'))){redirect(join(file,'index.js'));return;}missing.push(path);res.writeHead(404).end();
}
// Follows package export conditions the way a browser bundler does: browser and ESM entries, never require or types.
const esmTarget=value=>{if(typeof value==='string')return value;if(!value||typeof value!=='object')return undefined;for(const key of ['browser','module','esnext','import','default']){const found=esmTarget(value[key]);if(found&&!found.endsWith('.d.ts')&&!found.endsWith('.d.mts'))return found;}return undefined;};
function importMap(){const imports={},base=join(modulesRoot,'@opentelemetry');for(const name of readdirSync(base)){const pkg=JSON.parse(readFileSync(join(base,name,'package.json'),'utf8'));const entry=(subpath,target)=>{if(typeof target==='string')imports['@opentelemetry/'+name+subpath]='/m/@opentelemetry/'+name+'/'+target.replace(/^\.\//,'');};if(pkg.exports&&typeof pkg.exports==='object')for(const [key,value] of Object.entries(pkg.exports))entry(key==='.'?'':key.slice(1),esmTarget(value));if(!imports['@opentelemetry/'+name])entry('',pkg.module);}return {imports};}
const browserPage=()=>`<!doctype html><meta charset="utf-8"><title>Releases</title><script type="importmap">${JSON.stringify(importMap())}</script><p id="out">loading</p>
<script type="module">
import {trace,ROOT_CONTEXT,SpanKind} from '@opentelemetry/api';
import {W3CTraceContextPropagator} from '@opentelemetry/core';
import {TracerProvider,SimpleSpanProcessor} from '@opentelemetry/sdk-trace';
import {defaultResource,resourceFromAttributes} from '@opentelemetry/resources';
import {OTLPTraceExporter} from '@opentelemetry/exporter-trace-otlp-http';
const out=document.getElementById('out');
try{
 // A header makes the exporter send with XHR, which forceFlush waits for, instead of a fire-and-forget beacon.
 const provider=new TracerProvider({resource:defaultResource().merge(resourceFromAttributes({'service.name':'app-mixer-browser'})),spanProcessors:[new SimpleSpanProcessor({exporter:new OTLPTraceExporter({url:location.origin+'/v1/traces',headers:{'x-trace-test':'1'}})})]});
 const span=provider.getTracer('app-mixer-browser').startSpan('page load /releases',{kind:SpanKind.CLIENT}),headers={};
 new W3CTraceContextPropagator().inject(trace.setSpan(ROOT_CONTEXT,span),headers,{set:(carrier,key,value)=>{carrier[key]=value;}});
 const publication=await fetch('/api/publication',{headers});if(publication.status!==200)throw Error('publication '+publication.status);await publication.text();
 const promote=await fetch('/api/capabilities/release.promote',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({confirm:true,note:'input-private'})});const body=await promote.text();if(promote.status!==200)throw Error('promote '+promote.status+' '+body);
 span.end();await provider.forceFlush();out.textContent='trace '+span.spanContext().traceId+' '+navigator.userAgent;
}catch(error){out.textContent='error '+error.message;}
</script>`;
// The edge in front of the page: serves it and the SDK, and proxies the API to the workspace and OTLP to the collector,
// presenting the workspace's own origin as a same-origin ingress would.
function edge(workspace,collector){const target=new URL(workspace),otlp=new URL(collector);return createServer((req,res)=>{
 if(req.url==='/releases'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end(browserPage());return;}
 if(req.url.startsWith('/m/')){serveModule(decodeURIComponent(req.url.slice(3).split('?')[0]),res);return;}
 const upstream=req.url.startsWith('/api/')?target:req.url==='/v1/traces'?otlp:undefined;if(!upstream){res.writeHead(404).end();return;}
 const headers={...req.headers,host:upstream.host};if(headers.origin)headers.origin=upstream.origin;
 const forward=httpRequest({host:upstream.hostname,port:upstream.port,method:req.method,path:req.url,headers},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});forward.on('error',()=>{res.writeHead(502).end();});req.pipe(forward);
});}
const nodeBrowser=async({tracer,workspace})=>{
 // A page-load span whose W3C context rides on both requests, as a browser OpenTelemetry SDK would send it.
 const page=tracer('app-mixer-browser').startSpan('page load /releases',{kind:SpanKind.CLIENT});let traceId;
 await context.with(trace.setSpan(context.active(),page),async()=>{
  traceId=page.spanContext().traceId;const headers={};propagation.inject(context.active(),headers);
  const publication=await fetch(workspace+'/api/publication',{headers:{...headers,authorization:'Bearer browser-session-private'}});assert.equal(publication.status,200);await publication.text();
  const promote=await fetch(workspace+'/api/capabilities/release.promote',{method:'POST',headers:{...headers,origin:workspace,'content-type':'application/json'},body:JSON.stringify({confirm:true,note:'input-private'})});assert.equal(promote.status,200,await promote.clone().text());assert.deepEqual(await promote.json(),{result:{version:1}});
 });
 page.end();return traceId;
};
const realBrowser=async({workspace,tracesUrl,dir,servers})=>{
 const front=edge(workspace,tracesUrl);servers.push(front);const url=await listen(front);
 const {stdout,stderr}=await run(browserBinary,['--headless','--enable-logging=stderr','--v=0','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--virtual-time-budget=15000','--user-data-dir='+join(dir,'browser-profile'),'--dump-dom',url+'/releases'],{timeout:90000,maxBuffer:1024*1024});
 const match=/trace ([0-9a-f]{32}) ([^<]*)/.exec(stdout);assert.ok(match,'the page did not finish: '+(/<p id="out">([^<]*)/.exec(stdout)?.[1]??stdout.slice(0,500))+(missing.length?'; missing modules: '+missing.join(', '):'')+'; console: '+stderr.split('\n').filter(line=>/CONSOLE|Uncaught|SyntaxError|TypeError|resolve/.test(line)).join(' | ').slice(0,3000));assert.match(match[2],/Chrome|Edg/);return match[1];
};
const wait=async(predicate,label,limit=20000)=>{const end=Date.now()+limit;while(Date.now()<end){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('Timed out waiting for '+label);};
async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${server.address().port}`;}
async function close(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
// Flattens the collector's file export (one OTLP JSON request per line) into spans tagged with their service.
function collected(text){const spans=[];for(const line of text.split('\n')){if(!line.trim())continue;for(const resource of JSON.parse(line).resourceSpans??[]){const attribute=key=>resource.resource?.attributes?.find(a=>a.key===key)?.value?.stringValue,service=attribute('service.name'),language=attribute('telemetry.sdk.language');for(const scope of resource.scopeSpans??[])for(const span of scope.spans??[])spans.push({service,language,name:span.name,kind:span.kind,traceId:span.traceId,spanId:span.spanId,parentSpanId:span.parentSpanId||undefined,attributes:Object.fromEntries((span.attributes??[]).map(a=>[a.key,Object.values(a.value??{})[0]]))});}}return spans;}

async function scenario(driveBrowser,browserLanguage){
 const dir=await mkdtemp(join(tmpdir(),'otel-collector-')),out=join(dir,'out'),name='app-mixer-otel-'+process.pid+'-'+Date.now();await mkdir(out);await mkdir(join(dir,'config'));await mkdir(join(dir,'workspace'));const linux=process.platform==='linux',listenPort=linux?await freePort():4318;await writeFile(join(dir,'config','config.yaml'),collectorConfig(listenPort));
 const manager=new AsyncLocalStorageContextManager().enable();context.setGlobalContextManager(manager);propagation.setGlobalPropagator(new W3CTraceContextPropagator());
 const providers=[],servers=[];let child,started=false;
 try{
  // On Linux the bind-mounted temp directory is private to this user, so the collector runs as the same user,
  // and it shares the host network on a free port; elsewhere Docker Desktop publishes the port to loopback.
  const user=typeof process.getuid==='function'?['--user',process.getuid()+':'+process.getgid()]:[];
  await run('docker',['run','-d','--rm','--name',name,...user,...(linux?['--network','host']:['-p','127.0.0.1::4318']),'-v',join(dir,'config')+':/etc/otelcol-contrib:ro','-v',out+':/out',COLLECTOR_IMAGE,'--config=/etc/otelcol-contrib/config.yaml']);started=true;
  const port=linux?listenPort:(await run('docker',['port',name,'4318/tcp'])).stdout.trim().split('\n')[0].split(':').pop(),tracesUrl=`http://127.0.0.1:${port}/v1/traces`;
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

  const traceId=await driveBrowser({tracer,workspace,tracesUrl,dir,servers});for(const provider of providers)await provider.forceFlush();

  const file=join(out,'traces.jsonl');let spans=[];
  await wait(async()=>{try{spans=collected(await readFile(file,'utf8')).filter(s=>s.traceId===traceId);}catch{return false;}const services=new Set(spans.map(s=>s.service));return ['app-mixer-browser','app-mixer-workspace','app-mixer-data-plane','app-mixer-capabilities','app-mixer-control-plane'].every(s=>services.has(s))&&spans.filter(s=>s.service==='app-mixer-control-plane').length>=2&&spans.filter(s=>s.service==='app-mixer-workspace').length>=4;},'the collector to write every service span');
  if(process.env.APP_MIXER_TEST_OTEL_EXPORT)await copyFile(file,process.env.APP_MIXER_TEST_OTEL_EXPORT);

  // Every hop is the child of the previous service's span, so the collector holds one connected tree.
  const byId=new Map(spans.map(s=>[s.spanId,s])),parentOf=s=>byId.get(s.parentSpanId),root=spans.find(s=>s.service==='app-mixer-browser');
  assert.equal(root.parentSpanId,undefined);if(browserLanguage)assert.equal(root.language,browserLanguage,'the root span comes from the browser SDK');for(const span of spans)if(span!==root)assert.ok(parentOf(span),'orphan span '+span.service+' '+span.name);
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
  if(started)await run('docker',['rm','-fv',name]).catch(()=>{});
  await rm(dir,{recursive:true,force:true});
 }
}

test('one trace spans browser, workspace, Data Plane, capabilities and Control Plane in a real collector',{skip:enabled?false:'set APP_MIXER_TEST_OTEL_COLLECTOR=docker to run against a collector container',timeout:180000},()=>scenario(nodeBrowser));
test('the same trace starts in a real headless browser running the OpenTelemetry web SDK',{skip:!enabled?'set APP_MIXER_TEST_OTEL_COLLECTOR=docker to run against a collector container':browserBinary?false:'no Chrome or Edge found; set CHROME_BIN',timeout:240000},()=>scenario(realBrowser,'webjs'));
