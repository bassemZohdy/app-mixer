import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {createProject} from '../dist/index.js';
const wait=async predicate=>{for(let n=0;n<200&&!predicate();n++)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(predicate());};
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const definition={id:'demo-app',schemaVersion:1,pages:[
 {id:'home',route:'/',title:'Home',components:[{id:'welcome',type:'Text',props:{text:'Welcome text'}},{id:'name',type:'Input',props:{label:'Name',path:'/name'}}]},
 {id:'about',route:'/about',title:'About us',components:[{id:'story',type:'Text',props:{text:'Story text'}}]}]};
const publication={version:1,definition};
const etag='"'+createHash('sha256').update(JSON.stringify(publication)).digest('hex')+'"';

async function open(value=publication){
 const dir=await mkdtemp(join(tmpdir(),'workspace-nav-'));
 const target=await createProject('demo-app',dir),html=await readFile(join(target,'index.html'),'utf8');
 const renderer=await import(pathToFileURL(join(target,'renderer.mjs')).href),workspace=await import(pathToFileURL(join(target,'workspace.mjs')).href);
 const dom=new JSDOM(html,{url:'http://127.0.0.1:3000/'}),document=dom.window.document,script=html.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/^import [^;]+;\s*/gm,'');
 const fetch=async path=>path==='/api/publication/status'?new Response(JSON.stringify({configured:true,schemaVersion:1}),{status:200}):new Response(JSON.stringify(value),{status:200,headers:{etag}});
 await new AsyncFunction('document','fetch','A2UIRenderer','APP_MIXER_CATALOG','ClientPublishedCache','prepareWorkspace','createOfflinePublicationRuntime','initializeOfflinePublication',script)(document,fetch,renderer.A2UIRenderer,renderer.APP_MIXER_CATALOG,renderer.ClientPublishedCache,workspace.prepareWorkspace,undefined,async()=>undefined);
 const pages=document.getElementById('pages'),nav=document.getElementById('page-nav');
 const current=()=>[...nav.querySelectorAll('a')].filter(link=>link.getAttribute('aria-current')==='page').map(link=>link.textContent);
 return {dom,document,pages,nav,current,go:hash=>{dom.window.location.hash=hash;},close:async()=>{dom.window.close();await rm(dir,{recursive:true,force:true});}};
}

test('FEAT-035 only the page of the current hash is rendered and the list marks it',async()=>{
 const app=await open();
 try{
  assert.match(app.pages.textContent,/Welcome text/);assert.doesNotMatch(app.pages.textContent,/Story text/);
  assert.deepEqual([...app.nav.querySelectorAll('a')].map(link=>link.textContent),['Home','About us']);
  assert.deepEqual([...app.nav.querySelectorAll('a')].map(link=>link.getAttribute('href')),['#/','#/about']);
  assert.deepEqual(app.current(),['Home']);
  app.go('#/about');
  await wait(()=>/Story text/.test(app.pages.textContent));
  assert.doesNotMatch(app.pages.textContent,/Welcome text/);
  assert.deepEqual(app.current(),['About us']);
  app.go('#/unknown');
  await wait(()=>/Welcome text/.test(app.pages.textContent));
  assert.doesNotMatch(app.pages.textContent,/Story text/);
  assert.deepEqual(app.current(),['Home']);
 }finally{await app.close();}
});

test('FEAT-035 field values survive switching pages',async()=>{
 const app=await open();
 try{
  const input=app.pages.querySelector('input');
  input.value='Ada';input.dispatchEvent(new app.dom.window.Event('input',{bubbles:true}));
  app.go('#/about');await wait(()=>/Story text/.test(app.pages.textContent));
  app.go('#/');await wait(()=>/Welcome text/.test(app.pages.textContent));
  assert.equal(app.pages.querySelector('input').value,'Ada');
 }finally{await app.close();}
});

test('FEAT-035 a one-page application shows no page list',async()=>{
 const single={version:1,definition:{...definition,pages:[definition.pages[0]]}};
 const app=await open(single);
 try{
  assert.match(app.pages.textContent,/Welcome text/);
  assert.equal(app.nav.hidden,true);
 }finally{await app.close();}
});
