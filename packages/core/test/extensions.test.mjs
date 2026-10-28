import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkExtensionCompatibility as check } from '../dist/index.js';
const manifest=()=>({manifestVersion:1,id:'example.chart',version:'1.0.0',scope:'application',runtimeVersions:['0.1.0'],renderers:['react'],components:['chart'],tools:['lookup'],providers:[],permissions:['read.data']});
const host=()=>({runtimeVersion:'0.1.0',renderer:'react',approved:[{id:'example.chart',version:'1.0.0',scope:'application',permissions:['read.data']}]});
const required=()=>({components:['chart'],tools:['lookup'],providers:[]});
test('accepts approved compatible static registrations',()=>assert.deepEqual(check([manifest()],host(),required()),{compatible:true,errors:[]}));
test('rejects unapproved permissions, scope, version, and incompatible runtime or renderer',()=>{
 for(const change of [m=>m.permissions.push('write.data'),m=>m.scope='platform',m=>m.version='2.0.0',m=>m.runtimeVersions=['0.2.0'],m=>m.renderers=['flutter']]) {const m=manifest();change(m);assert.equal(check([m],host(),required()).compatible,false);}
});
test('reports missing and duplicate registrations',()=>{
 const m=manifest(), other={...manifest(),id:'example.other'}; const h=host();h.approved.push({...h.approved[0],id:other.id});
 const result=check([m,other],h,{...required(),providers:['storage']});assert.equal(result.compatible,false);assert.ok(result.errors.some(e=>e.includes('Duplicate components')));assert.ok(result.errors.some(e=>e.includes('Missing providers')));
 assert.equal(check([m,m],h,required()).compatible,false);
});
test('rejects malformed manifests, approvals, and ambiguous versions',()=>{
 for(const m of [{...manifest(),extra:true},{...manifest(),version:'1.0'},{...manifest(),components:['chart','chart']},{...manifest(),permissions:['*']}]) assert.throws(()=>check([m],host(),required()),/Invalid/);
 const h=host();h.approved.push(h.approved[0]);assert.throws(()=>check([manifest()],h,required()),/Invalid extension approval/);
});

test('publication guards enforce compatibility atomically in memory and SQLite', async () => {
 const { ApplicationStore, SqliteApplicationStore, createExtensionPublicationGuard } = await import('../dist/index.js');
 const initial={id:'demo',schemaVersion:1,revision:0,pages:[{id:'home',title:'Home',route:'/',components:[]}]};
 for (const create of [guard=>new ApplicationStore(initial,guard),guard=>new SqliteApplicationStore(':memory:',initial,guard)]) {
  let needed=['chart']; const m=manifest(), h=host();
  const guard=createExtensionPublicationGuard([m],h,draft=>{draft.pages[0].title='mutated';return {components:needed,tools:[],providers:[]}});
  m.components.length=0; h.approved.length=0;
  const store=create(guard);
  try {
   assert.equal(store.publish(0).definition.pages[0].title,'Home');
   needed=['missing']; assert.throws(()=>store.publish(0),/Extension compatibility failed/);
   assert.equal(store.getPublished().version,1);
   assert.equal(store.getPublished(2),undefined);
   assert.throws(()=>store.publish(1),/Revision conflict/);
   needed=['chart']; assert.equal(store.publish(0).version,2);
  } finally {store.close?.();}
 }
});

test('invalid publication policy fails closed', async()=>{
 const {ApplicationStore,createExtensionPublicationGuard}=await import('../dist/index.js');
 const initial={id:'demo',schemaVersion:1,revision:0,pages:[]};
 const store=new ApplicationStore(initial,createExtensionPublicationGuard([manifest()],host(),()=>({components:null,tools:[],providers:[]})));
 assert.throws(()=>store.publish(0),/Invalid/);assert.equal(store.getPublished(),undefined);
 assert.throws(()=>createExtensionPublicationGuard([manifest()],host(),null),/Invalid/);
 const asyncStore=new ApplicationStore(initial,async()=>true);assert.throws(()=>asyncStore.publish(0),/synchronously return true/);assert.equal(asyncStore.getPublished(),undefined);
});
