#!/usr/bin/env node
import {mkdir,writeFile,access,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {realpathSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {signExtensionFiles,verifyExtensionFiles,checkExtensionFiles,checkExtensionSetFiles} from './extension-sign.js';
export async function createProject(name:string,parent=process.cwd()):Promise<string>{
 if(!/^[a-z][a-z0-9-]{1,48}$/.test(name)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(name))throw Error("Invalid project name");
 const target=resolve(parent,name);
 try{await access(target);throw Error("Target exists");}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
 await mkdir(target);
 const manifest={id:name,schemaVersion:1,revision:0,pages:[{id:"home",route:"/",title:"Home",components:[{id:"intro",type:"Text",props:{text:"Welcome to App Mixer"}}]}]};
 const html=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>App Mixer</title><style>body{font:16px system-ui;margin:0;background:#f2f5fa;color:#17243a}header{padding:22px;background:#142c4a;color:white}header h1{margin:0;font:inherit}main{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr);gap:24px;padding:24px}section{background:white;border-radius:12px;padding:24px;min-width:0;overflow-wrap:anywhere}#page-nav ul{list-style:none;margin:0 0 16px;padding:0;display:flex;flex-wrap:wrap;gap:8px 16px}#page-nav a[aria-current]{font-weight:700;color:#17243a;text-decoration:none}#pages section{margin:12px 0;border:1px solid #c5cfdf}#pages label{display:block;margin:12px 0}#pages label>span{display:block;margin-bottom:6px;font-weight:600}#pages input,#pages textarea{width:100%;box-sizing:border-box}input{padding:10px}@media(max-width:700px){main{grid-template-columns:minmax(0,1fr)}}</style><header><h1>App Mixer</h1></header><main><section><h2>Conversation</h2><p id="chat-status" role="status">Checking agent…</p><div id="chat-log" aria-live="polite"></div><form id="chat-form"><label for="chat-input">Message</label><input id="chat-input" placeholder="Ask agent" disabled><button id="chat-send" type="submit" disabled>Send</button></form></section><section><h2>Workspace</h2><button id="refresh-publication" hidden>Refresh publication</button><p id="publication-status" role="status"></p><nav id="page-nav" aria-label="Pages" hidden></nav><div id="pages"></div></section></main><script type="module">import {A2UIRenderer,APP_MIXER_CATALOG,ClientPublishedCache} from '/renderer.mjs';
import {prepareWorkspace} from '/workspace.mjs';
import {createOfflinePublicationRuntime} from '/offline-publication-runtime.mjs';
import {initializeOfflinePublication} from '/offline-publication-host.mjs';
const host=document.getElementById('pages');
let cache,offlineRuntime,renderGeneration=0,shown=false,view;
const win=document.defaultView,nav=document.getElementById('page-nav');
const showPage=state=>{
  const route=(win?.location.hash.slice(1))||'/',page=state.pages.find(item=>item.route===route)??state.pages[0];
  state.renderer.apply({version:'v0.9.1',updateComponents:{surfaceId:'workspace',components:[{...state.components[0],children:page?page.ids:[]},...state.components.slice(1)]}});
  if(nav){const list=document.createElement('ul');for(const item of state.pages){const entry=document.createElement('li'),link=document.createElement('a');link.href='#'+item.route;link.textContent=item.title;if(item===page)link.setAttribute('aria-current','page');entry.appendChild(link);list.appendChild(entry);}nav.replaceChildren(list);nav.hidden=state.pages.length<2;}
};
win?.addEventListener('hashchange',()=>{if(!view)return;try{showPage(view);}catch(error){document.getElementById('publication-status').textContent='The page could not be shown: '+error.message;}});
const render=async()=>{const generation=++renderGeneration;let previous=[];try {
  let app;
  if(offlineRuntime){const result=await offlineRuntime.refresh();if(generation!==renderGeneration)return;app=result.publication.definition;document.getElementById('publication-status').textContent=result.offline?'Showing saved offline publication.':'';}
  else if(cache) app=(await cache.refresh()).definition;
  else {const response=await fetch('/api/application');if(!response.ok)throw new Error('Could not load application');app=await response.json();}
  previous=[...host.children];host.replaceChildren();
  const {registry,components,pages}=prepareWorkspace(app);
  const renderer=new A2UIRenderer(host,registry);
  renderer.apply({version:'v0.9.1',createSurface:{surfaceId:'workspace',catalogId:APP_MIXER_CATALOG}});
  const next={renderer,components,pages};showPage(next);view=next;
  shown=true;{const note=document.getElementById('publication-status');if(note.textContent.startsWith('The new version was not applied'))note.textContent='';}
} catch(error) { if(generation===renderGeneration){if(shown){if(previous.length)host.replaceChildren(...previous);document.getElementById('publication-status').textContent='The new version was not applied: '+error.message;}else{document.getElementById('publication-status').textContent='';host.textContent='Unable to render application: '+error.message;}} }};
try {
  const offlineOptions=await initializeOfflinePublication();
  if(offlineOptions){
    if(offlineOptions.scope?.applicationId!==${JSON.stringify(name)}||![1,2].includes(offlineOptions.scope?.schemaVersion)||typeof offlineOptions.onReady!=='function')throw Error('Invalid offline publication host');
    offlineRuntime=await createOfflinePublicationRuntime({...offlineOptions,compatible:definition=>{try{prepareWorkspace(definition);return true;}catch{return false;}}});
    const button=document.getElementById('refresh-publication');button.hidden=false;button.addEventListener('click',()=>render());
    const clearDisplay=()=>{renderGeneration++;view=undefined;if(nav){nav.replaceChildren();nav.hidden=true;}document.getElementById('publication-status').textContent='';host.replaceChildren();};
    offlineOptions.onReady({lock(){clearDisplay();offlineRuntime.close();button.hidden=true;},async clear(){clearDisplay();await offlineRuntime.clear();},hasPendingRollbackAnchor(){return offlineRuntime.hasPendingRollbackAnchor();},async syncRollbackAnchor(){return offlineRuntime.syncRollbackAnchor();}});
  } else {
  const state=await (await fetch('/api/publication/status')).json();
  if(state.configured){
    if(![1,2].includes(state.schemaVersion))throw Error('Invalid publication schema version');
    cache=new ClientPublishedCache({tenantId:'local',authorizationKey:'local',applicationId:${JSON.stringify(name)},schemaVersion:state.schemaVersion},async etag=>{
      const response=await fetch('/api/publication',{headers:etag?{'If-None-Match':etag}:{},cache:'no-store'});
      if(response.status===304)return {status:304};
      if(!response.ok)throw Error('Publication unavailable');
      return {status:200,etag:response.headers.get('etag'),publication:await response.json()};
    },definition=>{try{prepareWorkspace(definition);return true;}catch{return false;}});
    const button=document.getElementById('refresh-publication');button.hidden=false;button.addEventListener('click',()=>render());
  }
  }
  await render();
} catch(error) {host.textContent='Unable to render application: '+error.message;}
</script><script type="module" src="/chat.mjs"></script></html>`;
 const server=String.raw`import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {once} from 'node:events';
import {createPublicationTracing} from './publication-tracing.mjs';
const fail=message=>{console.error('server.mjs: '+message);process.exit(1);};
const flag=name=>{const value=process.env[name]??'false';if(value!=='true'&&value!=='false')fail('Invalid '+name);return value==='true';};
const tracingEnabled=flag('WORKSPACE_TRACING_ENABLED'),capabilityPropagation=flag('WORKSPACE_TRACING_PROPAGATE_CAPABILITIES'),agentPropagation=flag('WORKSPACE_TRACING_PROPAGATE_AGENT');if((capabilityPropagation||agentPropagation)&&!tracingEnabled)fail('Invalid workspace tracing configuration');
const tracing=await createPublicationTracing({enabled:tracingEnabled,trustIncoming:flag('WORKSPACE_TRACING_TRUST_INCOMING'),propagate:flag('WORKSPACE_TRACING_PROPAGATE')});
const portText=process.env.PORT||'3000';
if(!/^\d{1,5}$/.test(portText)||Number(portText)>65535)fail('PORT must be an integer from 0 to 65535');
const port=Number(portText);
const publicationSchemaVersion=/^[12]$/.test(process.env.PUBLICATION_SCHEMA_VERSION||'1')?Number(process.env.PUBLICATION_SCHEMA_VERSION||'1'):null;
const bind=process.env.APP_MIXER_BIND||'127.0.0.1';
if(!['127.0.0.1','0.0.0.0'].includes(bind))fail('Invalid bind address');
const endpoint=(urlName,path,tokenName)=>{
  const text=process.env[urlName];if(!text)return undefined;
  const expected=urlName+' must be an http URL on 127.0.0.1 or localhost with the path '+path;
  let candidate;try{candidate=new URL(text);}catch{fail(expected);}
  if(!(candidate.protocol==='http:'&&['127.0.0.1','localhost'].includes(candidate.hostname)&&candidate.pathname===path&&!candidate.search&&!candidate.hash&&!candidate.username&&!candidate.password))fail(expected);
  if(tokenName&&(process.env[tokenName]||'').length<32)fail(tokenName+' must contain at least 32 characters when '+urlName+' is set');
  return candidate;
};
const dataURL=endpoint('DATA_PLANE_URL','/application');
const capabilityTimeoutText=process.env.CAPABILITY_TIMEOUT_MS??'5000';
if(!/^[1-9]\d{0,4}$/.test(capabilityTimeoutText)||Number(capabilityTimeoutText)<100||Number(capabilityTimeoutText)>30000)fail('Invalid CAPABILITY_TIMEOUT_MS');
const capabilityTimeoutMs=Number(capabilityTimeoutText);
const capabilityResponseLimitText=process.env.CAPABILITY_RESPONSE_MAX_BYTES??'1048576';
if(!/^[1-9]\d{0,7}$/.test(capabilityResponseLimitText)||Number(capabilityResponseLimitText)<1048576||Number(capabilityResponseLimitText)>8388608)fail('Invalid CAPABILITY_RESPONSE_MAX_BYTES');
const capabilityResponseLimit=Number(capabilityResponseLimitText);
const capabilityRequestLimitText=process.env.CAPABILITY_REQUEST_MAX_BYTES??'1048576';
if(!/^[1-9]\d{0,7}$/.test(capabilityRequestLimitText)||Number(capabilityRequestLimitText)<1048576||Number(capabilityRequestLimitText)>8388608)fail('Invalid CAPABILITY_REQUEST_MAX_BYTES');
const capabilityRequestLimit=Number(capabilityRequestLimitText);
const capabilityConcurrencyText=process.env.CAPABILITY_MAX_IN_FLIGHT;
if(capabilityConcurrencyText!==undefined&&(!/^[1-9]\d{0,2}$/.test(capabilityConcurrencyText)||Number(capabilityConcurrencyText)>100))fail('Invalid CAPABILITY_MAX_IN_FLIGHT');
const capabilityConcurrency=capabilityConcurrencyText===undefined?undefined:Number(capabilityConcurrencyText);let capabilityInFlight=0;
const capabilityUploadTimeoutText=process.env.CAPABILITY_UPLOAD_TIMEOUT_MS;
if(capabilityUploadTimeoutText!==undefined&&(!/^[1-9]\d{0,4}$/.test(capabilityUploadTimeoutText)||Number(capabilityUploadTimeoutText)<100||Number(capabilityUploadTimeoutText)>30000))fail('Invalid CAPABILITY_UPLOAD_TIMEOUT_MS');
const capabilityUploadTimeout=capabilityUploadTimeoutText===undefined?undefined:Number(capabilityUploadTimeoutText);
const capabilityURL=endpoint('CAPABILITY_URL','/capabilities/','CAPABILITY_TOKEN');
const agentURL=endpoint('AGENT_URL','/agent','AGENT_TOKEN');
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
const readCapabilityBody=(req,maxBytes,timeoutMs)=>new Promise((resolve,reject)=>{
  const parts=[];let size=0,finished=false;
  const timer=setTimeout(()=>finish(Error('UPLOAD_TIMEOUT')),timeoutMs);
  const cleanup=()=>{clearTimeout(timer);req.off('data',onData);req.off('end',onEnd);req.off('aborted',onAbort);req.off('error',onError);};
  const finish=(error,value)=>{if(finished)return;finished=true;cleanup();if(error){req.on('error',()=>{});req.resume();reject(error);}else resolve(value);};
  const onData=chunk=>{size+=chunk.length;if(size>maxBytes){finish(Error('TOO_LARGE'));return;}parts.push(chunk);};
  const onEnd=()=>{try{finish(undefined,JSON.parse(Buffer.concat(parts).toString('utf8')));}catch{finish(Error('INVALID_JSON'));}};
  const onAbort=()=>finish(Error('DISCONNECTED')),onError=()=>finish(Error('DISCONNECTED'));
  req.on('data',onData);req.once('end',onEnd);req.once('aborted',onAbort);req.once('error',onError);
});
const server=createServer(async(req,res)=>{
  const host=req.headers.host;
  if(host!==('127.0.0.1:'+req.socket.localPort) && host!==('localhost:'+req.socket.localPort)){json(res,400,{error:'Invalid host'});return;}
  if(req.method==='GET' && req.url==='/api/publication/status'){json(res,200,{configured:!!process.env.DATA_PLANE_URL,schemaVersion:publicationSchemaVersion});return;}
  if(req.method==='GET' && req.url==='/api/publication'){
    return tracing.handle(req,res,'GET','/api/publication',async()=>{
    if(!dataURL){json(res,503,{error:'Data plane is not configured'});return;}
    try{
      await tracing.upstream('GET','/application',async(traceHeaders,report)=>{
      const upstream=await fetch(dataURL,{headers:{...traceHeaders,...(req.headers['if-none-match']?{'If-None-Match':req.headers['if-none-match']}:{})},redirect:'error',signal:AbortSignal.timeout(5000)});report(upstream.status);
      const etag=upstream.headers.get('etag');
      if(upstream.status===304&&etag){res.writeHead(304,{'etag':etag,'cache-control':'no-store'});res.end();return;}
      if(upstream.status!==200||!etag||!upstream.body)throw Error('Invalid publication response');
      const chunks=[];let size=0;for await(const chunk of upstream.body){size+=chunk.length;if(size>1024*1024)throw Error('Publication too large');chunks.push(chunk);}
      res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','etag':etag});res.end(Buffer.concat(chunks));});
    }catch{if(!res.destroyed)json(res,502,{error:'Publication unavailable'});}
    });
  }
  const capabilityMatch=req.method==='POST'&&/^\/api\/capabilities\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,255})$/.exec(req.url||'');
  if(capabilityMatch){
    return tracing.handle(req,res,'POST','/api/capabilities/{operationId}',async()=>{
    if(req.headers.origin!=='http://'+host){json(res,403,{error:'Invalid origin'});return;}
    if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||'')){json(res,415,{error:'Expected JSON'});return;}
    if(!capabilityURL){json(res,503,{error:'Capabilities are not configured'});return;}
    if(capabilityConcurrency!==undefined&&capabilityInFlight>=capabilityConcurrency){json(res,503,{error:'Capability proxy busy'});return;}
    capabilityInFlight++;
    try{
    const parts=[];let size=0,input;
    try {if(capabilityUploadTimeout!==undefined)input=await readCapabilityBody(req,capabilityRequestLimit,capabilityUploadTimeout);else{for await(const chunk of req){size+=chunk.length;if(size>capabilityRequestLimit){json(res,413,{error:'Request too large'});return;}parts.push(chunk);}input=JSON.parse(Buffer.concat(parts).toString('utf8'));}}
    catch(error){if(!res.destroyed){if(error?.message==='UPLOAD_TIMEOUT'||error?.message==='TOO_LARGE')res.setHeader('Connection','close');json(res,error?.message==='UPLOAD_TIMEOUT'?408:error?.message==='TOO_LARGE'?413:400,{error:error?.message==='UPLOAD_TIMEOUT'?'Request timed out':error?.message==='TOO_LARGE'?'Request too large':'Invalid request'});}return;}
    try {
      await tracing.upstream('POST','/capabilities/{operationId}/invoke',async(traceHeaders,report)=>{const upstream=await fetch(new URL(capabilityMatch[1]+'/invoke',capabilityURL),{method:'POST',headers:{...traceHeaders,'Content-Type':'application/json','Authorization':'Bearer '+process.env.CAPABILITY_TOKEN},body:JSON.stringify({origin:'ui',input}),redirect:'error',signal:AbortSignal.timeout(capabilityTimeoutMs)});report(upstream.status);
      if(![200,400,401,403,404,409,413,415,429,500,503].includes(upstream.status)||!/^application\/json(?:\s*;|$)/i.test(upstream.headers.get('content-type')||'')||!upstream.body)throw Error('Invalid capability response');
      const chunks=[];let length=0;for await(const chunk of upstream.body){length+=chunk.length;if(length>capabilityResponseLimit)throw Error('Capability response too large');chunks.push(chunk);}
      const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));json(res,upstream.status,result);},capabilityPropagation);
    }catch{if(!res.destroyed)json(res,502,{error:'Capability service unavailable'});}
    }finally{capabilityInFlight--;}
    });
  }
  if(req.method==='GET' && req.url==='/api/chat/status'){json(res,200,{enabled:!!agentURL});return;}
  if(req.method==='POST' && req.url==='/api/chat'){
    return tracing.handle(req,res,'POST','/api/chat',async()=>{
    if(req.headers.origin!=='http://'+host){json(res,403,{error:'Invalid origin'});return;}
    if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||'')){json(res,415,{error:'Expected JSON'});return;}
    if(!agentURL){json(res,503,{error:'Agent is not configured'});return;}
    let body='',size=0;const parts=[];
    try{for await(const chunk of req){size+=chunk.length;if(size>1024*1024){json(res,413,{error:'Request too large'});return;}parts.push(chunk);}body=Buffer.concat(parts).toString('utf8');JSON.parse(body);}catch{if(!res.destroyed)json(res,400,{error:'Invalid request'});return;}
    const controller=new AbortController();
    res.once('close',()=>{if(!res.writableEnded)controller.abort();});
    try{
      await tracing.upstream('POST','/agent',async(traceHeaders,report)=>{const upstream=await fetch(agentURL,{method:'POST',headers:{...traceHeaders,'Content-Type':'application/json','Authorization':'Bearer '+process.env.AGENT_TOKEN},body,signal:controller.signal});report(upstream.status);
      if(!upstream.ok || !upstream.body || !/^text\/event-stream/i.test(upstream.headers.get('content-type')||''))throw Error('Invalid agent response');
      res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
      for await(const chunk of upstream.body){if(res.destroyed)break;if(!res.write(chunk))await once(res,'drain',{signal:controller.signal});}
      if(controller.signal.aborted)throw Error('Client disconnected');if(!res.destroyed)res.end();},agentPropagation);
    }catch{if(!res.destroyed){if(!res.headersSent)json(res,502,{error:'Agent unavailable'});else res.destroy();}}
    });
  }
  const shellWorkerRequest=req.method==='GET'&&/^\/offline-shell-sw\.js\?revision=[a-zA-Z0-9._-]{1,64}$/.test(req.url||'');
  const path=shellWorkerRequest?'offline-shell-sw.js':req.method==='GET'&&req.url==='/api/application'?'application.json':req.method==='GET'&&req.url==='/'?'index.html':req.method==='GET'&&req.url==='/renderer.mjs'?'renderer.mjs':req.method==='GET'&&req.url==='/workspace.mjs'?'workspace.mjs':req.method==='GET'&&req.url==='/extensions.mjs'?'extensions.mjs':req.method==='GET'&&req.url==='/chat.mjs'?'chat.mjs':req.method==='GET'&&req.url==='/capabilities.mjs'?'capabilities.mjs':req.method==='GET'&&req.url==='/data-editor.mjs'?'data-editor.mjs':req.method==='GET'&&req.url==='/staged-editor.mjs'?'staged-editor.mjs':req.method==='GET'&&['/offline.js','/offline-worker.js','/offline-ui.js','/offline-runtime.mjs','/offline-shell.mjs','/offline-shell-sw.js','/offline-publications.js','/offline-publication-runtime.mjs','/offline-publication-host.mjs'].includes(req.url)?req.url.slice(1):null;
  if(!path){res.writeHead(404);res.end();return;}
  try{const data=await readFile(new URL(path,import.meta.url));res.writeHead(200,{'Content-Type':path.endsWith('.json')?'application/json; charset=utf-8':(path.endsWith('.mjs')||path.endsWith('.js'))?'text/javascript; charset=utf-8':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(data)}catch{res.writeHead(500);res.end()}
});
// Bound slow or stalled clients; Node's defaults wait 60 s for headers and 300 s for a request.
server.headersTimeout=10000;server.requestTimeout=30000;server.keepAliveTimeout=5000;server.setTimeout(30000);
server.once('error',error=>fail(error.code==='EADDRINUSE'?'PORT '+port+' is already in use on '+bind:'Cannot listen on '+bind+':'+port+': '+error.message));
server.listen(port,bind,function(){console.log('http://127.0.0.1:'+this.address().port)});
`;
 const capabilities=String.raw`// Trusted application code invokes only host-registered capabilities.
export async function invokeCapability(operationId,input){
  if(typeof operationId!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(operationId))throw Error('Invalid capability ID');
  let response,body;try{response=await fetch('/api/capabilities/'+operationId,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});body=await response.json();if(!body||typeof body!=='object'||Array.isArray(body)||(response.ok&&!Object.hasOwn(body,'result')))throw Error('Invalid capability response');}catch{const error=new Error('Capability outcome uncertain');error.code='CAPABILITY_OUTCOME_UNCERTAIN';throw error;}
  if(!response.ok){const error=new Error(body?.error||'Capability invocation failed');error.status=response.status;if(response.status>=500||body?.code==='CAPABILITY_OUTCOME_UNCERTAIN')error.code='CAPABILITY_OUTCOME_UNCERTAIN';throw error;}
  return body.result;
}
`;
 const chat=String.raw`const form=document.getElementById('chat-form'),input=document.getElementById('chat-input'),button=document.getElementById('chat-send'),status=document.getElementById('chat-status'),log=document.getElementById('chat-log');
const threadId=crypto.randomUUID(),history=[];
function line(role,text){const item=document.createElement('p');item.textContent=role+': '+text;log.appendChild(item);return item;}
try{const response=await fetch('/api/chat/status');const state=await response.json();if(state.enabled){input.disabled=false;button.disabled=false;status.textContent='Ready';}else status.textContent='Agent is not configured.';}catch{status.textContent='Agent is unavailable.';}
form.addEventListener('submit',async event=>{
  event.preventDefault();const value=input.value.trim();if(!value || button.disabled)return;
  input.value='';input.disabled=true;button.disabled=true;status.textContent='Thinking…';
  const user={id:crypto.randomUUID(),role:'user',content:value};history.push(user);const sent=line('You',value);
  let assistant='',complete=false,entry,started=false;
  try{
    const response=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({threadId,runId:crypto.randomUUID(),messages:history,tools:[],context:[],state:{}})});
    if(!response.ok || !response.body)throw Error('Agent unavailable');
    const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
    while(true){const {value:chunk,done}=await reader.read();buffer+=decoder.decode(chunk||new Uint8Array(),{stream:!done});
      let end;while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);const data=frame.split('\n').filter(x=>x.startsWith('data: ')).map(x=>x.slice(6)).join('\n');if(!data)continue;
        const message=JSON.parse(data);started=true;if(message.type==='TEXT_MESSAGE_CONTENT'){assistant+=message.delta;if(!entry)entry=line('Agent','');entry.textContent='Agent: '+assistant;}
        if(message.type==='RUN_ERROR')throw Error('Agent could not complete the request');if(message.type==='RUN_FINISHED')complete=true;
      }if(done)break;
    }
    if(!complete)throw Error('Agent stream ended unexpectedly');
    history.push({id:crypto.randomUUID(),role:'assistant',content:assistant});status.textContent='Ready';
  }catch(error){history.pop();if(!started){input.value=value;sent.textContent='You: '+value+' (not sent)';}if(entry)entry.textContent+=' (incomplete)';status.textContent=error.message||'Agent unavailable';}
  finally{input.disabled=false;button.disabled=false;input.focus();}
});
`;
 const extensions=String.raw`// Trusted host code only. Each entry is {id, version, scope, components},
// where components maps a name to {render, validate?}. No code is loaded from application definitions.
export const installedExtensions = [];
`;
 const workspace=String.raw`import {basicRegistry} from './renderer.mjs';
import {installedExtensions} from './extensions.mjs';
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export function prepareWorkspace(app){
  if(!object(app)||![1,2].includes(app.schemaVersion)||!Array.isArray(app.pages)||!Array.isArray(app.extensions??[]))throw Error('Invalid application');
  const references=app.extensions??[], selected=new Map(), registry=basicRegistry();
  if(references.length>256)throw Error('Too many extensions');
  for(const ref of references){
    if(!object(ref)||Object.keys(ref).length!==3||typeof ref.id!=='string'||typeof ref.version!=='string'||!['platform','development','application'].includes(ref.scope)||selected.has(ref.id))throw Error('Invalid extension reference');
    const matches=installedExtensions.filter(item=>item.id===ref.id&&item.version===ref.version&&item.scope===ref.scope);
    if(matches.length!==1||!object(matches[0].components))throw Error('Extension unavailable: '+ref.id);
    selected.set(ref.id,matches[0]);
  }
  const components=[{id:'root',component:'Column',children:[]}], registered=new Map(), pages=[];
  for(const [index,page] of app.pages.entries()){
    if(!object(page)||typeof page.title!=='string'||(app.schemaVersion===1&&page.description!==undefined)||(app.schemaVersion===2&&(typeof page.description!=='string'||page.description.length>10000))||!Array.isArray(page.components))throw Error('Invalid page');
    const ids=[],titleId='page-'+index;components[0].children.push(titleId);ids.push(titleId);components.push({id:titleId,component:'Text',text:page.title,variant:'h2'});
    if(app.schemaVersion===2&&page.description){const descriptionId='page-'+index+'-description';components[0].children.push(descriptionId);ids.push(descriptionId);components.push({id:descriptionId,component:'Text',text:page.description});}
    for(const [itemIndex,item] of page.components.entries()){
      if(!object(item))throw Error('Invalid component');
      const itemId='page-'+index+'-item-'+itemIndex;components[0].children.push(itemId);ids.push(itemId);
      if(item.type==='Text'){const props=item.props??{};if(Object.hasOwn(props,'path')){if(typeof props.path!=='string'||Object.hasOwn(props,'text')||Object.keys(props).some(key=>!['path','variant'].includes(key))||(props.variant!==undefined&&!['h1','h2','h3','h4','h5','body','caption'].includes(props.variant)))throw Error('Invalid Text properties');components.push({id:itemId,component:'Text',text:{path:props.path},...(props.variant===undefined?{}:{variant:props.variant})});}else components.push({id:itemId,component:'Text',text:String(props.text??'')});continue;}
      if(item.type==='Card'){const props=item.props??{};if(!props||typeof props!=='object'||Array.isArray(props)||Object.keys(props).some(key=>!['title','text'].includes(key))||(props.title!==undefined&&(typeof props.title!=='string'||props.title.length>10000))||(props.text!==undefined&&(typeof props.text!=='string'||props.text.length>10000)))throw Error('Invalid Card properties');const content=itemId+'-content',children=[];components.push({id:itemId,component:'Card',child:content},{id:content,component:'Column',children});if(props.title){const title=content+'-title';children.push(title);components.push({id:title,component:'Text',text:props.title,variant:'h3'});}if(props.text){const text=content+'-text';children.push(text);components.push({id:text,component:'Text',text:props.text});}continue;}
      if(item.type==='Input'){const props=item.props;if(!props||typeof props!=='object'||Array.isArray(props)||Object.keys(props).some(key=>!['label','path','variant'].includes(key))||typeof props.label!=='string'||typeof props.path!=='string'||(props.variant!==undefined&&!['shortText','longText'].includes(props.variant)))throw Error('Invalid Input properties');components.push({id:itemId,component:'TextField',label:props.label,value:{path:props.path},...(props.variant===undefined?{}:{variant:props.variant})});continue;}
      if(item.type!=='Extension'||typeof item.extensionId!=='string'||typeof item.name!=='string')throw Error('Unsupported component type: '+item.type);
      const extension=selected.get(item.extensionId), binding=extension&&Object.hasOwn(extension.components,item.name)?extension.components[item.name]:undefined;
      if(!binding||typeof binding.render!=='function'||(binding.validate!==undefined&&typeof binding.validate!=='function'))throw Error('Extension component unavailable: '+item.name);
      const props=item.props??{};
      if(!object(props)||Object.keys(props).length>100||Object.entries(props).some(([key,value])=>['id','component','__proto__','prototype','constructor'].includes(key)||!(typeof value==='string'||typeof value==='boolean'||(typeof value==='number'&&Number.isFinite(value)))))throw Error('Invalid extension component properties');
      const rendered={...props,id:itemId,component:item.name};
      if(binding.validate)binding.validate(rendered);
      if(!registered.has(item.name)){registry.register(item.name,binding.render,binding.validate);registered.set(item.name,item.extensionId);}
      else if(registered.get(item.name)!==item.extensionId)throw Error('Duplicate extension component: '+item.name);
      components.push(rendered);
    }
    pages.push({route:typeof page.route==='string'&&page.route.startsWith('/')?page.route:'/page-'+index,title:page.title,ids});
  }
  return {registry,components,pages};
}
`;
 const rendererSource=await readFile(new URL(import.meta.resolve('@app-mixer/web')));
 const dataEditor=await readFile(new URL('../templates/data-editor.mjs',import.meta.url));
 const publicationTracing=await readFile(new URL('../templates/publication-tracing.mjs',import.meta.url));
 const stagedEditor=await readFile(new URL('../templates/staged-editor.mjs',import.meta.url));
 const offlineRuntime=await readFile(new URL('../templates/offline-runtime.mjs',import.meta.url));
 const publicationRuntime=await readFile(new URL('../templates/offline-publication-runtime.mjs',import.meta.url));
 const publicationHost=await readFile(new URL('../templates/offline-publication-host.mjs',import.meta.url));
 const publicationSource=await readFile(new URL(import.meta.resolve('@app-mixer/web/offline-publications')));
 const shellTemplate=await readFile(new URL('../templates/offline-shell.mjs',import.meta.url),'utf8');
 const shellWorkerTemplate=await readFile(new URL('../templates/offline-shell-sw.js',import.meta.url),'utf8');
 const offlineShell=shellTemplate.replace('__APP_ID__',JSON.stringify(name)),offlineShellWorker=shellWorkerTemplate.replace('__APP_ID__',JSON.stringify(name));
 const offlineURL=new URL(import.meta.resolve('@app-mixer/web/offline'));
 const [offlineSource,offlineWorker,offlineUI]=await Promise.all([readFile(offlineURL),readFile(new URL('./offline-worker.js',offlineURL)),readFile(new URL('./offline-ui.js',offlineURL))]);
 await Promise.all([writeFile(resolve(target,'publication-tracing.mjs'),publicationTracing),writeFile(resolve(target,'offline-publications.js'),publicationSource),writeFile(resolve(target,'offline-publication-runtime.mjs'),publicationRuntime),writeFile(resolve(target,'offline-publication-host.mjs'),publicationHost),writeFile(resolve(target,'chat.mjs'),chat),writeFile(resolve(target,'capabilities.mjs'),capabilities),writeFile(resolve(target,'data-editor.mjs'),dataEditor),writeFile(resolve(target,'staged-editor.mjs'),stagedEditor),writeFile(resolve(target,'offline-runtime.mjs'),offlineRuntime),writeFile(resolve(target,'offline-shell.mjs'),offlineShell),writeFile(resolve(target,'offline-shell-sw.js'),offlineShellWorker),writeFile(resolve(target,'offline.js'),offlineSource),writeFile(resolve(target,'offline-worker.js'),offlineWorker),writeFile(resolve(target,'offline-ui.js'),offlineUI),writeFile(resolve(target,'renderer.mjs'),rendererSource),writeFile(resolve(target,'workspace.mjs'),workspace),writeFile(resolve(target,'extensions.mjs'),extensions),writeFile(resolve(target,"package.json"),JSON.stringify({name,private:true,type:"module",scripts:{dev:"node --env-file-if-exists=.env server.mjs"}},null,2)),writeFile(resolve(target,"application.json"),JSON.stringify(manifest,null,2)),writeFile(resolve(target,"index.html"),html),writeFile(resolve(target,"server.mjs"),server),writeFile(resolve(target,".gitignore"),".env"+String.fromCharCode(10)),writeFile(resolve(target,".env.example"),"PORT=3000\nPUBLICATION_SCHEMA_VERSION=1\nDATA_PLANE_URL=\nWORKSPACE_TRACING_ENABLED=false\nWORKSPACE_TRACING_TRUST_INCOMING=false\nWORKSPACE_TRACING_PROPAGATE=false\nWORKSPACE_TRACING_PROPAGATE_CAPABILITIES=false\nWORKSPACE_TRACING_PROPAGATE_AGENT=false\nAGENT_URL=\nAGENT_TOKEN=\nCAPABILITY_URL=\nCAPABILITY_TOKEN=\nCAPABILITY_TIMEOUT_MS=5000\nCAPABILITY_RESPONSE_MAX_BYTES=1048576\nCAPABILITY_REQUEST_MAX_BYTES=1048576\n# CAPABILITY_MAX_IN_FLIGHT=10\n# CAPABILITY_UPLOAD_TIMEOUT_MS=5000\n")]);
 return target;
}
let isMain=false;try{isMain=!!process.argv[1]&&realpathSync(resolve(process.argv[1]))===fileURLToPath(import.meta.url);}catch{}
const USAGE=['create <name>','extension-sign <manifest.json> <package-file> <private-key.pem> <key-id> <output.json>','extension-verify <signed.json> <package-file> <public-key.pem> <key-id>','extension-check <signed.json> <package-file> <public-key.pem> <key-id> <host.json> <requirements.json>','extension-check-set <set.json> <host.json> <requirements.json>'];
const usageText='Usage: app-mixer <command> [arguments]\n'+USAGE.map(line=>'  '+line).join('\n')+'\n  --version\n  --help';
if(isMain){const [, , command,...args]=process.argv;const fail=(e:Error)=>{console.error(e.message);process.exitCode=1;};if((command==='--help'||command==='-h')&&args.length===0)console.log(usageText);else if(command==='--version'&&args.length===0)console.log(JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version);else if(command==='create'&&args.length===1)createProject(args[0]).then(p=>console.log('Created '+p),fail);else if(command==='extension-sign'&&args.length===5)signExtensionFiles(args[0],args[1],args[2],args[3],args[4]).then(()=>console.log('Signed extension manifest written'),fail);else if(command==='extension-verify'&&args.length===4)verifyExtensionFiles(args[0],args[1],args[2],args[3]).then(m=>console.log(`Verified ${m.id}@${m.version} (${m.scope})`),fail);else if(command==='extension-check'&&args.length===6)checkExtensionFiles(args[0],args[1],args[2],args[3],args[4],args[5]).then(m=>console.log(`Compatible ${m.id}@${m.version} (${m.scope})`),fail);else if(command==='extension-check-set'&&args.length===3)checkExtensionSetFiles(args[0],args[1],args[2]).then(m=>console.log(`Compatible extensions: ${m.length}`),fail);else{console.error(usageText);process.exitCode=1;}}
