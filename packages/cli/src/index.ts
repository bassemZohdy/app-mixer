#!/usr/bin/env node
import {mkdir,writeFile,access,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
export async function createProject(name:string,parent=process.cwd()):Promise<string>{
 if(!/^[a-z][a-z0-9-]{1,48}$/.test(name))throw Error("Invalid project name");
 const target=resolve(parent,name);
 try{await access(target);throw Error("Target exists");}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
 await mkdir(target);
 const manifest={id:name,schemaVersion:1,revision:0,pages:[{id:"home",route:"/",title:"Home",components:[{id:"intro",type:"Text",props:{text:"Welcome to App Mixer"}}]}]};
 const html=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>App Mixer</title><style>body{font:16px system-ui;margin:0;background:#f2f5fa;color:#17243a}header{padding:22px;background:#142c4a;color:white}main{display:grid;grid-template-columns:1fr 2fr;gap:24px;padding:24px}section{background:white;border-radius:12px;padding:24px}input{padding:10px}@media(max-width:700px){main{grid-template-columns:1fr}}</style><header>App Mixer</header><main><section><h2>Conversation</h2><p>Agent integration coming soon.</p><input placeholder="Ask agent" disabled></section><section><h2>Workspace</h2><div id="pages"></div></section></main><script type="module">import {A2UIRenderer,BASIC_CATALOG} from '/renderer.mjs';
const host=document.getElementById('pages');
try {
  const response=await fetch('/api/application');
  if(!response.ok) throw new Error('Could not load application');
  const app=await response.json();
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
  renderer.apply({version:'v0.9.1',createSurface:{surfaceId,catalogId:BASIC_CATALOG}});
  renderer.apply({version:'v0.9.1',updateComponents:{surfaceId,components}});
} catch(error) { host.textContent='Unable to render application: '+error.message; }
</script></html>`;
 const server=`import {createServer} from 'node:http';import {readFile} from 'node:fs/promises';const port=Number(process.env.PORT||3000);createServer(async(req,res)=>{const path=req.method==='GET'&&req.url==='/api/application'?'application.json':req.method==='GET'&&req.url==='/'?'index.html':req.method==='GET'&&req.url==='/renderer.mjs'?'renderer.mjs':null;if(!path){res.writeHead(404);res.end();return;}try{const data=await readFile(new URL(path,import.meta.url));res.writeHead(200,{'Content-Type':path.endsWith('.json')?'application/json; charset=utf-8':path.endsWith('.mjs')?'text/javascript; charset=utf-8':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(data)}catch{res.writeHead(500);res.end()}}).listen(port,'127.0.0.1',function(){console.log('http://127.0.0.1:'+this.address().port)});`;
 const rendererSource=await readFile(new URL(import.meta.resolve('@app-mixer/web')));
 await Promise.all([writeFile(resolve(target,'renderer.mjs'),rendererSource),writeFile(resolve(target,"package.json"),JSON.stringify({name,private:true,type:"module",scripts:{dev:"node server.mjs"}},null,2)),writeFile(resolve(target,"application.json"),JSON.stringify(manifest,null,2)),writeFile(resolve(target,"index.html"),html),writeFile(resolve(target,"server.mjs"),server),writeFile(resolve(target,".env.example"),"PORT=3000\nLLM_PROVIDER=\nLLM_MODEL=\nLLM_API_KEY=\n")]);
 return target;
}
if(process.argv[1]?.endsWith('/dist/index.js')){const [, , command,name]=process.argv;if(command==='create'&&name)createProject(name).then(p=>console.log('Created '+p),e=>{console.error(e.message);process.exitCode=1});else{console.error('Usage: app-mixer create <name>');process.exitCode=1;}}
