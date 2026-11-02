import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ApplicationStore,ExtensionRegistry,computeExtensionIntegrity,signExtensionManifest} from '@app-mixer/core';
import {createProject} from '../dist/index.js';

test('status badge example signs, publishes and renders through a generated workspace',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'extension-example-'));
 try{
  const example=resolve('examples/extensions/status-badge'),bytes=await readFile(join(example,'extension.mjs')),manifest={...JSON.parse(await readFile(join(example,'manifest.json'),'utf8')),integrity:computeExtensionIntegrity(bytes)},definition=JSON.parse(await readFile(join(example,'application.json'),'utf8')),{installedExtension,render}=await import(pathToFileURL(join(example,'extension.mjs')).href),keys=generateKeyPairSync('ed25519');
  const host={runtimeVersion:'0.1.0',renderer:'web',requireIntegrityPins:true,approved:[{id:manifest.id,version:manifest.version,scope:manifest.scope,permissions:[],integrity:manifest.integrity}]},registry=new ExtensionRegistry(host,{trustedKeys:{publisher:keys.publicKey}}),signed=signExtensionManifest(manifest,'publisher',keys.privateKey);
  assert.throws(()=>registry.registerSigned(signed,{components:{'status-badge':render},tools:{},providers:{}},{},Buffer.from('different package')),/Invalid signed extension manifest/);
  registry.registerSigned(signed,{components:{'status-badge':render},tools:{},providers:{}},{},bytes);
  const store=new ApplicationStore(definition,registry.createPublicationGuard(()=>({components:['status-badge'],tools:[],providers:[]}))),published=store.publish(0).definition;
  const target=await createProject('status-demo',dir),{installedExtensions}=await import(pathToFileURL(join(target,'extensions.mjs')).href),{prepareWorkspace}=await import(pathToFileURL(join(target,'workspace.mjs')).href),{A2UIRenderer,APP_MIXER_CATALOG}=await import(pathToFileURL(join(target,'renderer.mjs')).href);installedExtensions.push(installedExtension);
  const doc={createElement(){return {ownerDocument:doc,children:[],dataset:{},style:{},textContent:'',appendChild(child){this.children.push(child);},replaceChildren(...children){this.children=children;}};}},root=doc.createElement(),{registry:componentsRegistry,components}=prepareWorkspace(published),renderer=new A2UIRenderer(root,componentsRegistry);
  renderer.apply({version:'v0.9.1',createSurface:{surfaceId:'main',catalogId:APP_MIXER_CATALOG}});renderer.apply({version:'v0.9.1',updateComponents:{surfaceId:'main',components}});assert.equal(root.children[0].children[0].children[1].textContent,'Service: healthy');
  const invalid=structuredClone(published);invalid.pages[0].components[0].props.status='unsupported';assert.throws(()=>prepareWorkspace(invalid),/Invalid status badge/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
