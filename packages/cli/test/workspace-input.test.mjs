import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {runInNewContext} from 'node:vm';
import {JSDOM} from 'jsdom';
import {createProject} from '../dist/index.js';
import {DEVELOPMENT_UI} from '../../core/dist/development-ui.js';
import {A2UIRenderer,APP_MIXER_CATALOG,basicRegistry} from '../../web/dist/index.js';
const wait=async predicate=>{for(let n=0;n<200&&!predicate();n++)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(predicate());};

test('published Input components render editable bound fields and preview consistently',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'workspace-input-'));let dom;try{const target=await createProject('sample-app',dir),{prepareWorkspace}=await import(pathToFileURL(join(target,'workspace.mjs')).href),definition={schemaVersion:1,pages:[{id:'home',title:'Home',route:'/',components:[{id:'field',type:'Input',props:{label:'Notes',path:'/form/notes',variant:'longText'}}]}]},prepared=prepareWorkspace(definition);dom=new JSDOM('<!doctype html><main></main>');const document=dom.window.document,renderer=new A2UIRenderer(document.querySelector('main'),prepared.registry);renderer.apply({version:'v0.9.1',createSurface:{surfaceId:'main',catalogId:APP_MIXER_CATALOG}});renderer.apply({version:'v0.9.1',updateComponents:{surfaceId:'main',components:prepared.components}});const field=document.querySelector('textarea');assert.ok(field);assert.equal(field.parentElement.querySelector('span').textContent,'Notes');field.value='First\nSecond';field.dispatchEvent(new dom.window.Event('input',{bubbles:true}));assert.equal(field.value,'First\nSecond');renderer.apply({version:'v0.9.1',updateDataModel:{surfaceId:'main',path:'/form/notes',value:'External update'}});assert.equal(document.querySelector('textarea').value,'External update');
  for(const props of [{label:'x'}, {label:'x',path:'/x',variant:'other'}, {label:'x',path:'/x',extra:true}, {label:1,path:'/x'}])assert.throws(()=>prepareWorkspace({...definition,pages:[{...definition.pages[0],components:[{id:'field',type:'Input',props}]}]}),/Invalid Input/);
  for(const path of ['/', 'relative', '/__proto__/x', '/bad~2escape']){const bad=prepareWorkspace({...definition,pages:[{...definition.pages[0],components:[{id:'field',type:'Input',props:{label:'Bad',path}}]}]});assert.throws(()=>renderer.apply({version:'v0.9.1',updateComponents:{surfaceId:'main',components:bad.components}}),/path|pointer|unsafe|TextField/i);assert.equal(document.querySelector('textarea').value,'External update');}
  const html=DEVELOPMENT_UI,previewDom=new JSDOM(html),previewDoc=previewDom.window.document,script=html.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/^\s*import [^;]+;\s*/gm,''),proposalId='00000000-0000-0000-0000-000000000000',calls=[];runInNewContext(script,{document:previewDoc,A2UIRenderer,APP_MIXER_CATALOG,basicRegistry,installedExtensions:[],fetch:async path=>{calls.push(path);return {ok:true,json:async()=>({id:proposalId,status:'pending',patches:[],preview:definition})};}});previewDoc.getElementById('proposal-id').value=proposalId;previewDoc.getElementById('load').click();await wait(()=>!previewDoc.getElementById('approve').disabled);assert.equal(previewDoc.querySelector('#rendered-preview textarea').parentElement.querySelector('span').textContent,'Notes');assert.deepEqual(calls,['/proposals/'+proposalId]);previewDom.window.close();
 }finally{dom?.window.close();await rm(dir,{recursive:true,force:true});}
});

