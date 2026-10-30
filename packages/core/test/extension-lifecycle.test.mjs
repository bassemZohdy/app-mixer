import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ExtensionRegistry,SqliteApplicationStore,createExtensionPublicationGuard,createExtensionRuntime} from '../dist/index.js';

test('approved extension publication survives repository reopening and is rechecked when rebuilding the runtime',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'app-mixer-extension-lifecycle-'));
 const manifest={manifestVersion:1,id:'example.report',version:'1.0.0',scope:'application',runtimeVersions:['0.1.0'],renderers:['react'],components:['report'],tools:['lookup'],providers:[],permissions:['read.data']};
 const reference={id:manifest.id,version:manifest.version,scope:manifest.scope};
 const host={runtimeVersion:'0.1.0',renderer:'react',approved:[{...reference,permissions:['read.data']}]};
 const implementation={components:{report:()=>null},tools:{lookup:input=>({value:input.value})},providers:{}};
 const initial={id:'demo',schemaVersion:1,revision:0,pages:[{id:'home',title:'Home',route:'/',components:[]}]};
 const requirements=()=>({components:[],tools:[],providers:[]});
 const registry=new ExtensionRegistry(host);registry.register(manifest,implementation);
 const guard=createExtensionPublicationGuard(registry.getManifests(),host,requirements),path=join(dir,'application.sqlite');
 try{
  let store=new SqliteApplicationStore(path,initial,guard);
  try{
   store.apply(0,[{op:'setExtensions',extensions:[reference]},{op:'addComponent',pageId:'home',component:{id:'report1',type:'Extension',extensionId:reference.id,name:'report'}},{op:'setExtensionOperations',operations:[{extensionId:reference.id,kind:'tool',name:'lookup'}]}]);
   assert.equal(store.publish(1).version,1);
  }finally{store.close();}
  store=new SqliteApplicationStore(path,initial,guard);
  try{
   const publication=store.getPublished();assert.equal(publication.version,1);
   const events=[],runtime=createExtensionRuntime(publication.definition,registry,event=>events.push(event.outcome),{operations:{lookup:{candidate:{operationId:'lookup',method:'GET',path:'/lookup'},authorize:context=>context.principalId==='allowed',validate:input=>typeof input?.value==='string'}}});
   const context={tenantId:'tenant',principalId:'denied',origin:'ui'};
   await assert.rejects(()=>runtime.capabilities.invoke('lookup',{value:'sales'},context),/forbidden/);
   context.principalId='allowed';assert.deepEqual(await runtime.capabilities.invoke('lookup',{value:'sales'},context),{value:'sales'});assert.deepEqual(events,['attempt','denied','attempt','succeeded']);
  }finally{store.close();}
  const revoked={...host,approved:[]},newRegistry=new ExtensionRegistry(revoked);
  assert.throws(()=>newRegistry.register(manifest,implementation),/compatib/i);
  const newGuard=createExtensionPublicationGuard([manifest],revoked,requirements);store=new SqliteApplicationStore(path,initial,newGuard);
  try{assert.throws(()=>store.publish(1),/compatibility/i);assert.equal(store.getPublished().version,1);assert.throws(()=>createExtensionRuntime(store.getPublished().definition,newRegistry,()=>{},{operations:{}}));}finally{store.close();}
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('runtime rechecks live extension approval after validation and isolates policy inputs',async()=>{
 const manifest={manifestVersion:1,id:'example.report',version:'1.0.0',scope:'application',runtimeVersions:['0.1.0'],renderers:['react'],components:[],tools:['lookup'],providers:[],permissions:['read.data']},reference={id:manifest.id,version:manifest.version,scope:manifest.scope},host={runtimeVersion:'0.1.0',renderer:'react',approved:[{...reference,permissions:['read.data']}]},registry=new ExtensionRegistry(host),calls=[],events=[],seen=[];registry.register(manifest,{components:{},tools:{lookup:input=>{calls.push(input);return 'ok';}},providers:{}});const application={id:'demo',schemaVersion:1,revision:0,pages:[],extensions:[reference],extensionOperations:[{extensionId:reference.id,kind:'tool',name:'lookup'}]};let approved=true,block=false,entered,release;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r),bindings={authorizeExtension:(actor,ref,op)=>{seen.push({actor:{...actor},ref:{...ref},op:{...op}});ref.version='forged';op.name='forged';actor.principalId='forged';return approved;},operations:{lookup:{candidate:{operationId:'lookup',method:'GET',path:'/lookup'},authorize:actor=>actor.tenantId==='tenant'&&actor.principalId==='allowed',authorizeExtension:(actor,ref,op)=>actor.principalId==='allowed'&&ref.version==='1.0.0'&&op.name==='lookup',validate:async input=>{if(block){entered();await gate;}return input?.ok===true;}}}},runtime=createExtensionRuntime(application,registry,event=>events.push(event.outcome),bindings),context={tenantId:'tenant',principalId:'allowed',origin:'agent'};reference.version='forged';bindings.authorizeExtension=()=>false;assert.equal(await runtime.capabilities.invoke('lookup',{ok:true},context),'ok');assert.deepEqual(calls,[{ok:true}]);assert.ok(seen.every(item=>item.ref.version==='1.0.0'&&item.op.name==='lookup'&&item.actor.principalId==='allowed'));block=true;const pending=runtime.capabilities.invoke('lookup',{ok:true},context);await ready;approved=false;release();await assert.rejects(pending,/forbidden/);assert.equal(calls.length,1);assert.deepEqual(events,['attempt','succeeded','attempt','denied']);await assert.rejects(runtime.capabilities.invoke('lookup',{ok:true},{...context,tenantId:'other'}),/forbidden/);assert.equal(calls.length,1);
});
