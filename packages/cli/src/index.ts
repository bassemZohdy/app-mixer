#!/usr/bin/env node
import {mkdir,writeFile,access,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
export async function createProject(name:string,parent=process.cwd()):Promise<string>{
 if(!/^[a-z][a-z0-9-]{1,48}$/.test(name))throw Error("Invalid project name");
 const target=resolve(parent,name);
 try{await access(target);throw Error("Target exists");}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
 await mkdir(target);
 const manifest={id:name,schemaVersion:1,revision:0,pages:[{id:"home",route:"/",title:"Home",components:[{id:"intro",type:"Text",props:{text:"Welcome to App Mixer"}}]}]};
 const html=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>App Mixer</title><style>body{font:16px system-ui;margin:0;background:#f2f5fa;color:#17243a}header{padding:22px;background:#142c4a;color:white}main{display:grid;grid-template-columns:1fr 2fr;gap:24px;padding:24px}section{background:white;border-radius:12px;padding:24px}input{padding:10px}@media(max-width:700px){main{grid-template-columns:1fr}}</style><header>App Mixer</header><main><section><h2>Conversation</h2><p id="chat-status" role="status">Checking agent…</p><div id="chat-log" aria-live="polite"></div><form id="chat-form"><label for="chat-input">Message</label><input id="chat-input" placeholder="Ask agent" disabled><button id="chat-send" type="submit" disabled>Send</button></form></section><section><h2>Workspace</h2><button id="refresh-publication" hidden>Refresh publication</button><div id="pages"></div></section></main><script type="module">import {A2UIRenderer,APP_MIXER_CATALOG,ClientPublishedCache} from '/renderer.mjs';
import {prepareWorkspace} from '/workspace.mjs';
const host=document.getElementById('pages');
let cache;
const render=async()=>{try {
  let app;
  if(cache) app=(await cache.refresh()).definition;
  else {const response=await fetch('/api/application');if(!response.ok)throw new Error('Could not load application');app=await response.json();}
  host.replaceChildren();
  const {registry,components}=prepareWorkspace(app);
  const renderer=new A2UIRenderer(host,registry);
  const surfaceId='workspace';
  renderer.apply({version:'v0.9.1',createSurface:{surfaceId,catalogId:APP_MIXER_CATALOG}});
  renderer.apply({version:'v0.9.1',updateComponents:{surfaceId,components}});
} catch(error) { host.textContent='Unable to render application: '+error.message; }};
try {
  const state=await (await fetch('/api/publication/status')).json();
  if(state.configured){
    cache=new ClientPublishedCache({tenantId:'local',authorizationKey:'local',applicationId:${JSON.stringify(name)},schemaVersion:1},async etag=>{
      const response=await fetch('/api/publication',{headers:etag?{'If-None-Match':etag}:{},cache:'no-store'});
      if(response.status===304)return {status:304};
      if(!response.ok)throw Error('Publication unavailable');
      return {status:200,etag:response.headers.get('etag'),publication:await response.json()};
    },definition=>{try{prepareWorkspace(definition);return true;}catch{return false;}});
    const button=document.getElementById('refresh-publication');button.hidden=false;button.addEventListener('click',()=>render());
  }
  await render();
} catch(error) {host.textContent='Unable to render application: '+error.message;}
</script><script type="module" src="/chat.mjs"></script></html>`;
 const server=String.raw`import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {once} from 'node:events';
const port=Number(process.env.PORT||3000);
const bind=process.env.APP_MIXER_BIND||'127.0.0.1';
if(!['127.0.0.1','0.0.0.0'].includes(bind))throw Error('Invalid bind address');
let dataURL;
try {const candidate=new URL(process.env.DATA_PLANE_URL||'');if(candidate.protocol==='http:'&&['127.0.0.1','localhost'].includes(candidate.hostname)&&candidate.pathname==='/application'&&!candidate.search&&!candidate.hash&&!candidate.username&&!candidate.password)dataURL=candidate;}catch{}
let capabilityURL;
try {
  const candidate=new URL(process.env.CAPABILITY_URL||'');
  if(candidate.protocol==='http:'&&['127.0.0.1','localhost'].includes(candidate.hostname)&&candidate.pathname==='/capabilities/'&&!candidate.search&&!candidate.hash&&!candidate.username&&!candidate.password&&(process.env.CAPABILITY_TOKEN||'').length>=32)capabilityURL=candidate;
} catch {}
let agentURL;
try {
  const candidate=new URL(process.env.AGENT_URL || '');
  if(candidate.protocol==='http:' && ['127.0.0.1','localhost'].includes(candidate.hostname) && candidate.pathname==='/agent' && !candidate.search && !candidate.hash && !candidate.username && !candidate.password && (process.env.AGENT_TOKEN||'').length>=32) agentURL=candidate;
} catch {}
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
createServer(async(req,res)=>{
  const host=req.headers.host;
  if(host!==('127.0.0.1:'+req.socket.localPort) && host!==('localhost:'+req.socket.localPort)){json(res,400,{error:'Invalid host'});return;}
  if(req.method==='GET' && req.url==='/api/publication/status'){json(res,200,{configured:!!process.env.DATA_PLANE_URL});return;}
  if(req.method==='GET' && req.url==='/api/publication'){
    if(!dataURL){json(res,503,{error:'Data plane is not configured'});return;}
    try{
      const upstream=await fetch(dataURL,{headers:req.headers['if-none-match']?{'If-None-Match':req.headers['if-none-match']}:{},redirect:'error',signal:AbortSignal.timeout(5000)});
      const etag=upstream.headers.get('etag');
      if(upstream.status===304&&etag){res.writeHead(304,{'etag':etag,'cache-control':'no-store'});res.end();return;}
      if(upstream.status!==200||!etag||!upstream.body)throw Error('Invalid publication response');
      const chunks=[];let size=0;for await(const chunk of upstream.body){size+=chunk.length;if(size>1024*1024)throw Error('Publication too large');chunks.push(chunk);}
      res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','etag':etag});res.end(Buffer.concat(chunks));
    }catch{if(!res.destroyed)json(res,502,{error:'Publication unavailable'});}
    return;
  }
  const capabilityMatch=req.method==='POST'&&/^\/api\/capabilities\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,255})$/.exec(req.url||'');
  if(capabilityMatch){
    if(req.headers.origin!=='http://'+host){json(res,403,{error:'Invalid origin'});return;}
    if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||'')){json(res,415,{error:'Expected JSON'});return;}
    if(!capabilityURL){json(res,503,{error:'Capabilities are not configured'});return;}
    const parts=[];let size=0,input;
    try {for await(const chunk of req){size+=chunk.length;if(size>1024*1024){json(res,413,{error:'Request too large'});return;}parts.push(chunk);}input=JSON.parse(Buffer.concat(parts).toString('utf8'));}
    catch{if(!res.destroyed)json(res,400,{error:'Invalid request'});return;}
    try {
      const upstream=await fetch(new URL(capabilityMatch[1]+'/invoke',capabilityURL),{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+process.env.CAPABILITY_TOKEN},body:JSON.stringify({origin:'ui',input}),redirect:'error',signal:AbortSignal.timeout(5000)});
      if(![200,400,401,403,404,409,415,500,503].includes(upstream.status)||!/^application\/json(?:\s*;|$)/i.test(upstream.headers.get('content-type')||'')||!upstream.body)throw Error('Invalid capability response');
      const chunks=[];let length=0;for await(const chunk of upstream.body){length+=chunk.length;if(length>1024*1024)throw Error('Capability response too large');chunks.push(chunk);}
      const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));json(res,upstream.status,result);
    }catch{if(!res.destroyed)json(res,502,{error:'Capability service unavailable'});}
    return;
  }
  if(req.method==='GET' && req.url==='/api/chat/status'){json(res,200,{enabled:!!agentURL});return;}
  if(req.method==='POST' && req.url==='/api/chat'){
    if(req.headers.origin!=='http://'+host){json(res,403,{error:'Invalid origin'});return;}
    if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||'')){json(res,415,{error:'Expected JSON'});return;}
    if(!agentURL){json(res,503,{error:'Agent is not configured'});return;}
    let body='',size=0;const parts=[];
    try{for await(const chunk of req){size+=chunk.length;if(size>1024*1024){json(res,413,{error:'Request too large'});return;}parts.push(chunk);}body=Buffer.concat(parts).toString('utf8');JSON.parse(body);}catch{if(!res.destroyed)json(res,400,{error:'Invalid request'});return;}
    const controller=new AbortController();
    res.once('close',()=>{if(!res.writableEnded)controller.abort();});
    try{
      const upstream=await fetch(agentURL,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+process.env.AGENT_TOKEN},body,signal:controller.signal});
      if(!upstream.ok || !upstream.body || !/^text\/event-stream/i.test(upstream.headers.get('content-type')||'')){if(!res.destroyed)json(res,502,{error:'Agent unavailable'});return;}
      res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
      for await(const chunk of upstream.body){if(res.destroyed)break;if(!res.write(chunk))await once(res,'drain',{signal:controller.signal});}
      if(!res.destroyed)res.end();
    }catch{if(!res.destroyed){if(!res.headersSent)json(res,502,{error:'Agent unavailable'});else res.destroy();}}
    return;
  }
  const path=req.method==='GET'&&req.url==='/api/application'?'application.json':req.method==='GET'&&req.url==='/'?'index.html':req.method==='GET'&&req.url==='/renderer.mjs'?'renderer.mjs':req.method==='GET'&&req.url==='/workspace.mjs'?'workspace.mjs':req.method==='GET'&&req.url==='/extensions.mjs'?'extensions.mjs':req.method==='GET'&&req.url==='/chat.mjs'?'chat.mjs':req.method==='GET'&&req.url==='/capabilities.mjs'?'capabilities.mjs':req.method==='GET'&&req.url==='/data-editor.mjs'?'data-editor.mjs':req.method==='GET'&&req.url==='/staged-editor.mjs'?'staged-editor.mjs':null;
  if(!path){res.writeHead(404);res.end();return;}
  try{const data=await readFile(new URL(path,import.meta.url));res.writeHead(200,{'Content-Type':path.endsWith('.json')?'application/json; charset=utf-8':path.endsWith('.mjs')?'text/javascript; charset=utf-8':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(data)}catch{res.writeHead(500);res.end()}
}).listen(port,bind,function(){console.log('http://127.0.0.1:'+this.address().port)});
`;
 const capabilities=String.raw`// Trusted application code invokes only host-registered capabilities.
export async function invokeCapability(operationId,input){
  if(typeof operationId!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(operationId))throw Error('Invalid capability ID');
  const response=await fetch('/api/capabilities/'+operationId,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
  const body=await response.json();
  if(!response.ok){const error=new Error(body.error||'Capability invocation failed');error.status=response.status;throw error;}
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
  const user={id:crypto.randomUUID(),role:'user',content:value};history.push(user);line('You',value);
  let assistant='',complete=false,entry;
  try{
    const response=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({threadId,runId:crypto.randomUUID(),messages:history,tools:[],context:[],state:{}})});
    if(!response.ok || !response.body)throw Error('Agent unavailable');
    const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
    while(true){const {value:chunk,done}=await reader.read();buffer+=decoder.decode(chunk||new Uint8Array(),{stream:!done});
      let end;while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);const data=frame.split('\n').filter(x=>x.startsWith('data: ')).map(x=>x.slice(6)).join('\n');if(!data)continue;
        const message=JSON.parse(data);if(message.type==='TEXT_MESSAGE_CONTENT'){assistant+=message.delta;if(!entry)entry=line('Agent','');entry.textContent='Agent: '+assistant;}
        if(message.type==='RUN_ERROR')throw Error('Agent could not complete the request');if(message.type==='RUN_FINISHED')complete=true;
      }if(done)break;
    }
    if(!complete)throw Error('Agent stream ended unexpectedly');
    history.push({id:crypto.randomUUID(),role:'assistant',content:assistant});status.textContent='Ready';
  }catch(error){history.pop();if(entry)entry.textContent+=' (incomplete)';status.textContent=error.message||'Agent unavailable';}
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
  if(!object(app)||!Array.isArray(app.pages)||!Array.isArray(app.extensions??[]))throw Error('Invalid application');
  const references=app.extensions??[], selected=new Map(), registry=basicRegistry();
  if(references.length>256)throw Error('Too many extensions');
  for(const ref of references){
    if(!object(ref)||Object.keys(ref).length!==3||typeof ref.id!=='string'||typeof ref.version!=='string'||!['platform','development','application'].includes(ref.scope)||selected.has(ref.id))throw Error('Invalid extension reference');
    const matches=installedExtensions.filter(item=>item.id===ref.id&&item.version===ref.version&&item.scope===ref.scope);
    if(matches.length!==1||!object(matches[0].components))throw Error('Extension unavailable: '+ref.id);
    selected.set(ref.id,matches[0]);
  }
  const components=[{id:'root',component:'Column',children:[]}], registered=new Map();
  for(const [index,page] of app.pages.entries()){
    if(!object(page)||typeof page.title!=='string'||!Array.isArray(page.components))throw Error('Invalid page');
    const titleId='page-'+index;components[0].children.push(titleId);components.push({id:titleId,component:'Text',text:page.title,variant:'h2'});
    for(const [itemIndex,item] of page.components.entries()){
      if(!object(item))throw Error('Invalid component');
      const itemId='page-'+index+'-item-'+itemIndex;components[0].children.push(itemId);
      if(item.type==='Text'){components.push({id:itemId,component:'Text',text:String(item.props?.text??'')});continue;}
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
  }
  return {registry,components};
}
`;
 const rendererSource=await readFile(new URL(import.meta.resolve('@app-mixer/web')));
 const dataEditor=await readFile(new URL('../templates/data-editor.mjs',import.meta.url));
 const stagedEditor=await readFile(new URL('../templates/staged-editor.mjs',import.meta.url));
 await Promise.all([writeFile(resolve(target,'chat.mjs'),chat),writeFile(resolve(target,'capabilities.mjs'),capabilities),writeFile(resolve(target,'data-editor.mjs'),dataEditor),writeFile(resolve(target,'staged-editor.mjs'),stagedEditor),writeFile(resolve(target,'renderer.mjs'),rendererSource),writeFile(resolve(target,'workspace.mjs'),workspace),writeFile(resolve(target,'extensions.mjs'),extensions),writeFile(resolve(target,"package.json"),JSON.stringify({name,private:true,type:"module",scripts:{dev:"node server.mjs"}},null,2)),writeFile(resolve(target,"application.json"),JSON.stringify(manifest,null,2)),writeFile(resolve(target,"index.html"),html),writeFile(resolve(target,"server.mjs"),server),writeFile(resolve(target,".env.example"),"PORT=3000\nDATA_PLANE_URL=\nAGENT_URL=\nAGENT_TOKEN=\nCAPABILITY_URL=\nCAPABILITY_TOKEN=\n")]);
 return target;
}
if(process.argv[1]?.endsWith('/dist/index.js')){const [, , command,name]=process.argv;if(command==='create'&&name)createProject(name).then(p=>console.log('Created '+p),e=>{console.error(e.message);process.exitCode=1});else{console.error('Usage: app-mixer create <name>');process.exitCode=1;}}
