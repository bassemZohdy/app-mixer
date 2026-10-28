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
const host=document.getElementById('pages');
let cache;
const render=async()=>{try {
  let app;
  if(cache) app=(await cache.refresh()).definition;
  else {const response=await fetch('/api/application');if(!response.ok)throw new Error('Could not load application');app=await response.json();}
  host.replaceChildren();
  const renderer=new A2UIRenderer(host);
  const surfaceId='workspace';
  const components=[{id:'root',component:'Column',children:[]}];
  for(const [index,page] of app.pages.entries()) {
    const titleId='page-'+index;
    components[0].children.push(titleId);
    components.push({id:titleId,component:'Text',text:page.title,variant:'h2'});
    for(const [itemIndex,item] of page.components.entries()) {
      if(item.type!=='Text') throw new Error('Unsupported component type: '+item.type);
      const itemId='page-'+index+'-item-'+itemIndex;
      components[0].children.push(itemId);
      components.push({id:itemId,component:'Text',text:String(item.props?.text??'')});
    }
  }
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
    },definition=>Array.isArray(definition.pages)&&definition.pages.every(page=>page&&typeof page.title==='string'&&Array.isArray(page.components)&&page.components.every(item=>item&&item.type==='Text')));
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
  const path=req.method==='GET'&&req.url==='/api/application'?'application.json':req.method==='GET'&&req.url==='/'?'index.html':req.method==='GET'&&req.url==='/renderer.mjs'?'renderer.mjs':req.method==='GET'&&req.url==='/chat.mjs'?'chat.mjs':null;
  if(!path){res.writeHead(404);res.end();return;}
  try{const data=await readFile(new URL(path,import.meta.url));res.writeHead(200,{'Content-Type':path.endsWith('.json')?'application/json; charset=utf-8':path.endsWith('.mjs')?'text/javascript; charset=utf-8':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(data)}catch{res.writeHead(500);res.end()}
}).listen(port,bind,function(){console.log('http://127.0.0.1:'+this.address().port)});
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
 const rendererSource=await readFile(new URL(import.meta.resolve('@app-mixer/web')));
 await Promise.all([writeFile(resolve(target,'chat.mjs'),chat),writeFile(resolve(target,'renderer.mjs'),rendererSource),writeFile(resolve(target,"package.json"),JSON.stringify({name,private:true,type:"module",scripts:{dev:"node server.mjs"}},null,2)),writeFile(resolve(target,"application.json"),JSON.stringify(manifest,null,2)),writeFile(resolve(target,"index.html"),html),writeFile(resolve(target,"server.mjs"),server),writeFile(resolve(target,".env.example"),"PORT=3000\nDATA_PLANE_URL=\nAGENT_URL=\nAGENT_TOKEN=\n")]);
 return target;
}
if(process.argv[1]?.endsWith('/dist/index.js')){const [, , command,name]=process.argv;if(command==='create'&&name)createProject(name).then(p=>console.log('Created '+p),e=>{console.error(e.message);process.exitCode=1});else{console.error('Usage: app-mixer create <name>');process.exitCode=1;}}
