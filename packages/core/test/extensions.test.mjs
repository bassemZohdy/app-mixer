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

test('registers only approved implementations matching the manifest', async()=>{
 const {ExtensionRegistry}=await import('../dist/index.js');
 const m=manifest(), h=host(), registry=new ExtensionRegistry(h), chart=()=>1, lookup=()=>2;
 const bindings={components:{chart},tools:{lookup},providers:{}};
 registry.register(m,bindings);
 m.components.length=0;h.approved.length=0;bindings.components.chart=()=>3;
 assert.equal(registry.get('components','chart'),chart);
 assert.equal(registry.get('tools','lookup'),lookup);
 assert.equal(registry.get('providers','unknown'),undefined);
 const exported=registry.getManifests();exported[0].components.length=0;
 assert.deepEqual(registry.getManifests()[0].components,['chart']);
});

test('failed registration is atomic and rejects incompatible or undeclared implementations',async()=>{
 const {ExtensionRegistry}=await import('../dist/index.js');
 const registry=new ExtensionRegistry(host()), m=manifest(), fn=()=>{};
 for(const bindings of [
  {components:{chart:fn},tools:{},providers:{}},
  {components:{chart:fn,extra:fn},tools:{lookup:fn},providers:{}},
  {components:{chart:1},tools:{lookup:fn},providers:{}},
 ]) {assert.throws(()=>registry.register(m,bindings),/bindings/);assert.deepEqual(registry.getManifests(),[]);assert.equal(registry.get('components','chart'),undefined);}
 assert.throws(()=>registry.register({...m,scope:'platform'},{components:{chart:fn},tools:{lookup:fn},providers:{}}),/compatibility/);
 registry.register(m,{components:{chart:fn},tools:{lookup:fn},providers:{}});
 assert.throws(()=>registry.register(m,{components:{chart:fn},tools:{lookup:fn},providers:{}}),/compatibility/);
 assert.equal(registry.getManifests().length,1);
 assert.throws(()=>registry.get('__proto__','chart'),/lookup/);
});

test('registration rejects collisions between distinct approved extensions',async()=>{
 const {ExtensionRegistry}=await import('../dist/index.js');const h=host(), first=manifest(), other={...manifest(),id:'other.extension'};
 h.approved.push({...h.approved[0],id:other.id});const registry=new ExtensionRegistry(h), fn=()=>{};
 const bindings={components:{chart:fn},tools:{lookup:fn},providers:{}};
 registry.register(first,bindings);assert.throws(()=>registry.register(other,bindings),/compatibility/);assert.equal(registry.getManifests().length,1);
});

test('validates bounded extension configuration before installing and returns copies',async()=>{
 const {ExtensionRegistry}=await import('../dist/index.js');const m={...manifest(),configSchema:{endpoint:{type:'string',required:true},enabled:{type:'boolean',required:false},limit:{type:'number',required:false}}};
 const registry=new ExtensionRegistry(host()), fn=()=>{}, bindings={components:{chart:fn},tools:{lookup:fn},providers:{}};
 for(const config of [{},{endpoint:4},{endpoint:'x',extra:true},{endpoint:'x',limit:Infinity},{endpoint:'x'.repeat(4097)},{endpoint:'x',enabled:null}]) {
  assert.throws(()=>registry.register(m,bindings,config),/Invalid extension configuration/);assert.deepEqual(registry.getManifests(),[]);
 }
 const config={endpoint:'local',enabled:false,limit:0};registry.register(m,bindings,config);config.endpoint='changed';
 const stored=registry.getConfiguration(m.id);assert.deepEqual(stored,{endpoint:'local',enabled:false,limit:0});stored.endpoint='changed';assert.equal(registry.getConfiguration(m.id).endpoint,'local');assert.equal(registry.getConfiguration('missing'),undefined);
});

test('rejects malformed or unsafe schemas and undeclared configuration',async()=>{
 const {ExtensionRegistry}=await import('../dist/index.js');const fn=()=>{},bindings={components:{chart:fn},tools:{lookup:fn},providers:{}};
 for(const schema of [{port:{type:'integer',required:true}},{port:{type:'number',required:'yes'}},{port:{type:'number',required:true,extra:true}},JSON.parse('{"constructor":{"type":"string","required":true}}')]) {
  assert.throws(()=>check([{...manifest(),configSchema:schema}],host(),required()),/configuration schema/);
 }
 const registry=new ExtensionRegistry(host());assert.throws(()=>registry.register(manifest(),bindings,{undeclared:'x'}),/configuration/);assert.deepEqual(registry.getManifests(),[]);
});
