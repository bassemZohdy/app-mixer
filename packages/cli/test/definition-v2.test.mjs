import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createProject} from '../dist/index.js';
import {ApplicationStore,createDataPlane} from '../../core/dist/index.js';

test('generated app renders a schema version 2 publication',async()=>{
 const repo=new ApplicationStore({id:'demo-app',schemaVersion:1,revision:0,pages:[{id:'home',title:'Home',route:'/',components:[]}]});repo.migrateDraft(0,2);repo.apply(1,[{op:'setPageDescription',pageId:'home',description:'Useful details'}]);repo.publish(2);
 const plane=createDataPlane(repo);plane.listen(0,'127.0.0.1');await once(plane,'listening');const dir=await mkdtemp(join(tmpdir(),'app-mixer-schema-'));let server;
 try{const target=await createProject('demo-app',dir);server=spawn(process.execPath,['server.mjs'],{cwd:target,env:{...process.env,PORT:'0',PUBLICATION_SCHEMA_VERSION:'2',DATA_PLANE_URL:`http://127.0.0.1:${plane.address().port}/application`},stdio:['ignore','pipe','pipe']});
  const url=await new Promise((resolve,reject)=>{let output='';server.stdout.on('data',chunk=>{output+=chunk;const m=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);});server.once('error',reject);server.once('exit',code=>reject(Error(`Server exited ${code}`)));});
  class Element{constructor(doc){this.ownerDocument=doc;this.children=[];this.style={};this.dataset={};this.textContent='';this.hidden=true;}appendChild(x){this.children.push(x);return x;}replaceChildren(...x){this.children=x;}addEventListener(_event,fn){this.handler=fn;}}
  const doc={createElement:()=>new Element(doc),getElementById:id=>id==='pages'?host:button},host=new Element(doc),button=new Element(doc);const renderer=await import(pathToFileURL(join(target,'renderer.mjs')).href),workspace=await import(pathToFileURL(join(target,'workspace.mjs')).href);
  const html=await (await fetch(url)).text(),script=html.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/^import [^;]+;\s*/gm,'');const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  await new AsyncFunction('document','fetch','A2UIRenderer','APP_MIXER_CATALOG','ClientPublishedCache','prepareWorkspace','initializeOfflinePublication',script)(doc,(path,options)=>fetch(new URL(path,url),options),renderer.A2UIRenderer,renderer.APP_MIXER_CATALOG,renderer.ClientPublishedCache,workspace.prepareWorkspace,async()=>null);
  assert.equal(host.children[0].children[0].children[0].textContent,'Home');assert.equal(host.children[0].children[0].children[1].textContent,'Useful details');
  assert.throws(()=>workspace.prepareWorkspace({schemaVersion:3,pages:[]}),/Invalid application/);
 }finally{if(server&&server.exitCode===null&&server.signalCode===null){const exited=once(server,'exit');server.kill();await exited;}await new Promise(r=>plane.close(r));await rm(dir,{recursive:true,force:true});}
});
