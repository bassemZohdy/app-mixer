import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createProject} from '../dist/index.js';

test('generated workspace uses only matching host-installed extension renderers',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'app-mixer-extension-'));
 try{
  const target=await createProject('demo-app',dir);
  const {installedExtensions}=await import(pathToFileURL(join(target,'extensions.mjs')).href);
  const {prepareWorkspace}=await import(pathToFileURL(join(target,'workspace.mjs')).href);
  const {A2UIRenderer,APP_MIXER_CATALOG}=await import(pathToFileURL(join(target,'renderer.mjs')).href);
  const ref={id:'sample.chart',version:'1.0.0',scope:'application'};
  const item={id:'chart',type:'Extension',extensionId:ref.id,name:'chart',props:{label:'Sales'}};
  const definition={schemaVersion:1,extensions:[ref],pages:[{title:'Home',components:[item]}]};
  assert.throws(()=>prepareWorkspace(definition),/unavailable/);
  installedExtensions.push({...ref,components:{chart:{render:(c,_child,_data,doc)=>{const node=doc.createElement('p');node.textContent=c.label;return node;},validate:c=>{if(typeof c.label!=='string')throw Error('Invalid chart');}}}});
  const doc={createElement(){return {ownerDocument:doc,children:[],dataset:{},style:{},textContent:'',appendChild(child){this.children.push(child);},replaceChildren(...children){this.children=children;}};}},host=doc.createElement();
  const {registry,components}=prepareWorkspace(definition),renderer=new A2UIRenderer(host,registry);
  renderer.apply({version:'v0.9.1',createSurface:{surfaceId:'main',catalogId:APP_MIXER_CATALOG}});
  renderer.apply({version:'v0.9.1',updateComponents:{surfaceId:'main',components}});
  assert.equal(host.children[0].children[0].children[1].textContent,'Sales');
  assert.throws(()=>prepareWorkspace({...definition,extensions:[{...ref,version:'2.0.0'}]}),/unavailable/);
  assert.throws(()=>prepareWorkspace({...definition,extensions:[]}),/unavailable/);
  assert.throws(()=>prepareWorkspace({...definition,pages:[{title:'Home',components:[{...item,props:{component:'Text'}}]}]}),/properties/);
  assert.throws(()=>prepareWorkspace({...definition,pages:[{title:'Home',components:[{...item,props:{label:true}}]}]}),/Invalid chart/);
  assert.equal(host.children[0].children[0].children[1].textContent,'Sales');
 }finally{await rm(dir,{recursive:true,force:true});}
});
