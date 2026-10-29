import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {runInNewContext} from 'node:vm';
import {createProject} from '../dist/index.js';

test('offline shell worker caches only its fixed static allowlist',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'app-mixer-shell-'));
 try{
  const target=await createProject('demo-app',dir),source=await readFile(join(target,'offline-shell-sw.js'),'utf8'),handlers={},stores=new Map(),fetches=[];
  const cache={addAll:async paths=>{for(const path of paths)stores.set(path,'cached:'+path);},match:async path=>stores.get(path)};
  const cacheNames=new Set(['app-mixer-shell:demo-app:old','app-mixer-shell:other:old']);
  const caches={keys:async()=>[...cacheNames],open:async name=>{cacheNames.add(name);return cache;},delete:async name=>cacheNames.delete(name)};
  const self={location:new URL('http://localhost/offline-shell-sw.js?revision=v1'),clients:{claim:async()=>{}},addEventListener:(name,fn)=>handlers[name]=fn};
  runInNewContext(source,{self,URL,caches,fetch:async request=>{fetches.push(request.url);return 'network';}});
  let pending;handlers.install({waitUntil:value=>pending=value});await pending;
  assert.ok(stores.has('/'));assert.ok(stores.has('/offline-runtime.mjs'));assert.equal(stores.has('/api/application'),false);assert.equal(stores.has('/api/publication'),false);
  handlers.activate({waitUntil:value=>pending=value});await pending;assert.equal(cacheNames.has('app-mixer-shell:demo-app:old'),false);assert.equal(cacheNames.has('app-mixer-shell:other:old'),true);
  let response;const event=(url,method='GET',authorization=false)=>({request:{url,method,headers:{has:key=>authorization&&key==='authorization'}},respondWith:value=>response=value});
  handlers.fetch(event('http://localhost/offline-runtime.mjs'));assert.equal(await response,'cached:/offline-runtime.mjs');
  for(const request of [event('http://localhost/api/application'),event('http://localhost/offline.js?x=1'),event('http://localhost/offline.js','POST'),event('http://localhost/offline.js','GET',true),event('http://other/offline.js')]){response=undefined;handlers.fetch(request);assert.equal(response,undefined);}
  assert.deepEqual(fetches,[]);
 } finally{await rm(dir,{recursive:true,force:true});}
});

test('offline shell enablement is explicit and disable leaves other workers and caches alone',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'app-mixer-shell-')),saved=Object.fromEntries(['navigator','caches','isSecureContext','location'].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
 try{
  const target=await createProject('demo-app',dir),module=await import(pathToFileURL(join(target,'offline-shell.mjs')).href),registered=[],deleted=[];
  let unrelated=true,unregistered=0;
  Object.defineProperty(globalThis,'isSecureContext',{configurable:true,value:true});Object.defineProperty(globalThis,'location',{configurable:true,value:new URL('http://localhost/')});
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{serviceWorker:{register:async(...args)=>{registered.push(args);return {};},getRegistration:async()=>({active:{scriptURL:unrelated?'http://localhost/other.js':'http://localhost/offline-shell-sw.js?revision=v1'},unregister:async()=>unregistered++})}}});
  Object.defineProperty(globalThis,'caches',{configurable:true,value:{keys:async()=>['app-mixer-shell:demo-app:v1','app-mixer-shell:other:v1'],delete:async name=>deleted.push(name)}});
  await assert.rejects(module.enableOfflineShell('../bad'),/unavailable/);assert.equal(registered.length,0);
  await module.enableOfflineShell('v1');assert.equal(registered[0][0],'/offline-shell-sw.js?revision=v1');
  await module.disableOfflineShell();assert.equal(unregistered,0);assert.deepEqual(deleted,['app-mixer-shell:demo-app:v1']);
  unrelated=false;await module.disableOfflineShell();assert.equal(unregistered,1);
 } finally{for(const [name,descriptor] of Object.entries(saved)){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}await rm(dir,{recursive:true,force:true});}
});
