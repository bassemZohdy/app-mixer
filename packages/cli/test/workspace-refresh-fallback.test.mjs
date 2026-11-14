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
const good=title=>({id:'demo-app',schemaVersion:1,pages:[{id:'home',route:'/',title,components:[{id:'intro',type:'Text',props:{text:title}}]}]});
// Accepted by prepareWorkspace, rejected by the renderer: an Input bound to the root pointer.
const unrenderable=()=>({id:'demo-app',schemaVersion:1,pages:[{id:'home',route:'/',title:'Broken',components:[{id:'field',type:'Input',props:{label:'Bad',path:'/'}}]}]});
const publication=(version,definition)=>({version,definition});
const etag=value=>'"'+createHash('sha256').update(JSON.stringify(value)).digest('hex')+'"';

async function open(responses){
 const dir=await mkdtemp(join(tmpdir(),'workspace-refresh-'));
 const target=await createProject('demo-app',dir),html=await readFile(join(target,'index.html'),'utf8');
 const renderer=await import(pathToFileURL(join(target,'renderer.mjs')).href),workspace=await import(pathToFileURL(join(target,'workspace.mjs')).href);
 const dom=new JSDOM(html),document=dom.window.document,script=html.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/^import [^;]+;\s*/gm,'');
 let served=0;
 const fetch=async path=>{
  if(path==='/api/publication/status')return new Response(JSON.stringify({configured:true,schemaVersion:1}),{status:200});
  if(path==='/api/publication'){const value=responses[Math.min(served++,responses.length-1)];if(value.denied)return new Response('',{status:403});return new Response(JSON.stringify(value),{status:200,headers:{etag:etag(value)}});}
  throw Error('unexpected fetch '+path);
 };
 await new AsyncFunction('document','fetch','A2UIRenderer','APP_MIXER_CATALOG','ClientPublishedCache','prepareWorkspace','createOfflinePublicationRuntime','initializeOfflinePublication',script)(document,fetch,renderer.A2UIRenderer,renderer.APP_MIXER_CATALOG,renderer.ClientPublishedCache,workspace.prepareWorkspace,undefined,async()=>undefined);
 return {document,close:async()=>{dom.window.close();await rm(dir,{recursive:true,force:true});}};
}

test('FIX-028 a refreshed publication the renderer rejects leaves the earlier pages in place',async()=>{
 const app=await open([publication(1,good('Working page')),publication(2,unrenderable())]);
 try{
  const pages=app.document.getElementById('pages'),status=app.document.getElementById('publication-status');
  assert.match(pages.textContent,/Working page/);
  app.document.getElementById('refresh-publication').click();
  await wait(()=>/not applied/i.test(status.textContent));
  assert.match(pages.textContent,/Working page/);
  assert.doesNotMatch(pages.textContent,/Unable to render/);
  assert.match(status.textContent,/new version was not applied/i);
 }finally{await app.close();}
});

test('FIX-028 a first load the renderer rejects still shows the error',async()=>{
 const app=await open([publication(1,unrenderable())]);
 try{
  assert.match(app.document.getElementById('pages').textContent,/Unable to render application/);
 }finally{await app.close();}
});

test('FIX-028 a later valid publication replaces the page again after a rejected one',async()=>{
 const app=await open([publication(1,good('First')),publication(2,unrenderable()),publication(3,good('Third'))]);
 try{
  const pages=app.document.getElementById('pages'),status=app.document.getElementById('publication-status'),button=app.document.getElementById('refresh-publication');
  button.click();await wait(()=>/not applied/i.test(status.textContent));
  button.click();await wait(()=>/Third/.test(pages.textContent));
  assert.doesNotMatch(pages.textContent,/First/);
  assert.equal(status.textContent,'');
 }finally{await app.close();}
});

test('FIX-028 a refresh the server refuses (access denied) does not keep the earlier pages on screen',async()=>{
 const app=await open([publication(1,good('Working page')),{denied:true}]);
 try{
  const pages=app.document.getElementById('pages');
  assert.match(pages.textContent,/Working page/);
  app.document.getElementById('refresh-publication').click();
  await wait(()=>/Unable to render/.test(pages.textContent));
  assert.doesNotMatch(pages.textContent,/Working page/);
 }finally{await app.close();}
});
