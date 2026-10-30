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

test('declared extensions require compatible publication policy in both repositories',async()=>{
 const {ApplicationStore,SqliteApplicationStore,createExtensionPublicationGuard}=await import('../dist/index.js');
 const initial={id:'demo',schemaVersion:1,revision:0,pages:[]};
 const ref={id:'example.chart',version:'1.0.0',scope:'application'};
 for(const create of [guard=>new ApplicationStore(initial,guard),guard=>new SqliteApplicationStore(':memory:',initial,guard)]) {
  const unguarded=create(undefined);
  try {
   unguarded.apply(0,[{op:'setExtensions',extensions:[ref]}]);
   assert.throws(()=>unguarded.publish(1),/Extension compatibility failed/);assert.equal(unguarded.getPublished(),undefined);
   unguarded.apply(1,[{op:'setExtensions',extensions:[]}]);assert.equal(unguarded.publish(2).version,1);
  } finally {unguarded.close?.();}
  const guard=createExtensionPublicationGuard([manifest()],host(),()=>({components:[],tools:[],providers:[]}));
  const guarded=create(guard);
  try {
   guarded.apply(0,[{op:'setExtensions',extensions:[ref]}]);assert.deepEqual(guarded.publish(1).definition.extensions,[ref]);
   for(const invalid of [{...ref,version:'2.0.0'},{...ref,scope:'platform'},{...ref,id:'unknown'}]){
    const revision=guarded.getDraft().revision;guarded.apply(revision,[{op:'setExtensions',extensions:[invalid]}]);
    assert.throws(()=>guarded.publish(revision+1),/Extension compatibility failed/);assert.equal(guarded.getPublished().version,1);
   }
  } finally {guarded.close?.();}
 }
});

test('extension references are bounded, exact and unique in patches and definitions',async()=>{
 const {ApplicationStore}=await import('../dist/index.js');
 const {isValidPatch}=await import('../dist/planes.js');
 const initial={id:'demo',schemaVersion:1,revision:0,pages:[]};
 const ref={id:'example.chart',version:'1.0.0',scope:'application'};
 for(const refs of [[ref,ref],[{...ref,version:'1.0'}],[{...ref,scope:'unknown'}],[{...ref,extra:true}],Array(257).fill(ref),null]){
  assert.equal(isValidPatch({op:'setExtensions',extensions:refs}),false);
  assert.throws(()=>new ApplicationStore({...initial,extensions:refs}),/Invalid manifest/);
  const store=new ApplicationStore(initial);assert.throws(()=>store.apply(0,[{op:'setExtensions',extensions:refs}]),/Invalid manifest/);assert.equal(store.getDraft().revision,0);
 }
 assert.equal(isValidPatch({op:'setExtensions',extensions:[ref]}),true);
 assert.equal(isValidPatch({op:'setExtensions',extensions:[ref],extra:true}),false);
 const store=new ApplicationStore(initial);assert.throws(()=>store.apply(0,[{op:'setExtensions'}]),/Invalid manifest/);assert.equal(store.getDraft().revision,0);
});

test('publication checks each extension component against its declared owning extension',async()=>{
 const {ApplicationStore,SqliteApplicationStore,createExtensionPublicationGuard}=await import('../dist/index.js');
 const {isValidPatch}=await import('../dist/planes.js');
 const initial={id:'demo',schemaVersion:1,revision:0,pages:[{id:'home',title:'Home',route:'/',components:[]}]};
 const ref={id:'example.chart',version:'1.0.0',scope:'application'};
 const component={id:'chart1',type:'Extension',extensionId:ref.id,name:'chart',props:{label:'Sales'}};
 assert.equal(isValidPatch({op:'addComponent',pageId:'home',component}),true);
 for(const invalid of [{...component,name:'Chart'}, {...component,extensionId:'bad/id'}, {...component,extra:true}])assert.equal(isValidPatch({op:'addComponent',pageId:'home',component:invalid}),false);
 const guard=createExtensionPublicationGuard([manifest()],host(),()=>({components:[],tools:[],providers:[]}));
 for(const create of [policy=>new ApplicationStore(initial,policy),policy=>new SqliteApplicationStore(':memory:',initial,policy)]){
  const noGuard=create(undefined);
  try {noGuard.apply(0,[{op:'addComponent',pageId:'home',component}]);assert.throws(()=>noGuard.publish(1),/compatibility/);} finally {noGuard.close?.();}
  const store=create(guard);
  try {
   store.apply(0,[{op:'addComponent',pageId:'home',component}]);assert.throws(()=>store.publish(1),/compatibility/);
   store.apply(1,[{op:'setExtensions',extensions:[ref]}]);assert.equal(store.publish(2).definition.pages[0].components[0].name,'chart');
   store.apply(2,[{op:'addComponent',pageId:'home',component:{...component,id:'missing',name:'missing'}}]);
   assert.throws(()=>store.publish(3),/compatibility/);assert.equal(store.getPublished().version,1);
  } finally {store.close?.();}
 }
});

test('publication validates declared tool and provider requirements against their owner',async()=>{
 const {ApplicationStore,SqliteApplicationStore,createExtensionPublicationGuard}=await import('../dist/index.js');
 const {isValidPatch}=await import('../dist/planes.js');
 const initial={id:'demo',schemaVersion:1,revision:0,pages:[]};
 const m={...manifest(),providers:['records']},ref={id:m.id,version:m.version,scope:m.scope};
 const operations=[{extensionId:m.id,kind:'tool',name:'lookup'},{extensionId:m.id,kind:'provider',name:'records'}];
 const guard=createExtensionPublicationGuard([m],host(),()=>({components:[],tools:[],providers:[]}));
 assert.equal(isValidPatch({op:'setExtensionOperations',operations}),true);
 for(const invalid of [[operations[0],operations[0]],[{...operations[0],kind:'other'}],[{...operations[0],extra:true}],Array(257).fill(operations[0]),null])assert.equal(isValidPatch({op:'setExtensionOperations',operations:invalid}),false);
 for(const create of [policy=>new ApplicationStore(initial,policy),policy=>new SqliteApplicationStore(':memory:',initial,policy)]){
  const unguarded=create(undefined);
  try{unguarded.apply(0,[{op:'setExtensionOperations',operations}]);assert.throws(()=>unguarded.publish(1),/compatibility/);}finally{unguarded.close?.();}
  const store=create(guard);
  try{
   store.apply(0,[{op:'setExtensionOperations',operations}]);assert.throws(()=>store.publish(1),/compatibility/);
   store.apply(1,[{op:'setExtensions',extensions:[ref]}]);assert.deepEqual(store.publish(2).definition.extensionOperations,operations);
   for(const bad of [{...operations[0],name:'missing'},{...operations[1],kind:'tool'},{...operations[0],extensionId:'other'}]){
    const revision=store.getDraft().revision;store.apply(revision,[{op:'setExtensionOperations',operations:[bad]}]);
    assert.throws(()=>store.publish(revision+1),/compatibility/);assert.equal(store.getPublished().version,1);
   }
  }finally{store.close?.();}
 }
});

test('declared provider capabilities preserve authorization validation and audit',async()=>{
 const {ExtensionRegistry,CapabilityRegistry,registerDeclaredExtensionCapability}=await import('../dist/index.js');
 const m={...manifest(),providers:['records']},ref={id:m.id,version:m.version,scope:m.scope};
 const registry=new ExtensionRegistry(host()),calls=[];
 registry.register(m,{components:{chart:()=>{}},tools:{lookup:()=>{}},providers:{records:(input,context)=>{calls.push({input,context});return 'data';}}});
 const operation={extensionId:m.id,kind:'provider',name:'records'},application={id:'demo',schemaVersion:1,revision:0,pages:[],extensions:[ref],extensionOperations:[operation]};
 const outcomes=[],target=new CapabilityRegistry(event=>outcomes.push(event.outcome)),candidate={operationId:'records',method:'GET',path:'/records'};
 const policy={authorize:context=>context.principalId==='allowed',validate:input=>input?.ok===true};
 assert.throws(()=>registerDeclaredExtensionCapability(target,registry,{...application,extensionOperations:[]},operation,candidate,policy),/not declared/);
 assert.throws(()=>registerDeclaredExtensionCapability(target,registry,application,{...operation,extensionId:'other'},candidate,policy),/not declared/);
 assert.throws(()=>registerDeclaredExtensionCapability(target,registry,application,operation,{...candidate,operationId:'other'},policy),/not declared/);
 registerDeclaredExtensionCapability(target,registry,application,operation,candidate,policy);
 const context={tenantId:'tenant',principalId:'denied',origin:'ui'};
 await assert.rejects(()=>target.invoke('records',{ok:true},context),/forbidden/);assert.equal(calls.length,0);
 context.principalId='allowed';await assert.rejects(()=>target.invoke('records',{ok:false},context),/Invalid capability input/);assert.equal(calls.length,0);
 assert.equal(await target.invoke('records',{ok:true},context),'data');
 assert.deepEqual(calls,[{input:{ok:true},context:{tenantId:'tenant',principalId:'allowed'}}]);assert.deepEqual(outcomes,['attempt','denied','attempt','invalid','attempt','succeeded']);
 const ownerless={...operation,name:'unknown'};
 assert.throws(()=>registerDeclaredExtensionCapability(new CapabilityRegistry(()=>{}),registry,{...application,extensionOperations:[ownerless]},ownerless,{...candidate,operationId:'unknown'},policy),/not available/);
 const other={...m,id:'other.extension',components:[],tools:[],providers:[]},otherRef={id:other.id,version:other.version,scope:other.scope};
 const approved=host();approved.approved.push({...otherRef,permissions:other.permissions});
 const two=new ExtensionRegistry(approved);two.register(m,{components:{chart:()=>{}},tools:{lookup:()=>{}},providers:{records:()=>{}}});two.register(other,{components:{},tools:{},providers:{}});
 const wrongOwner={...operation,extensionId:other.id};
 assert.throws(()=>registerDeclaredExtensionCapability(new CapabilityRegistry(()=>{}),two,{...application,extensions:[ref,otherRef],extensionOperations:[wrongOwner]},wrongOwner,candidate,policy),/not available/);
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

test('enforces configuration bounds and enumerated values before registration',async()=>{
 const {ExtensionRegistry}=await import('../dist/index.js');const fn=()=>{},bindings={components:{chart:fn},tools:{lookup:fn},providers:{}};
 const m={...manifest(),configSchema:{region:{type:'string',required:true,minLength:2,maxLength:4,enum:['us','eu']},limit:{type:'number',required:true,minimum:0,maximum:10,enum:[0,5,10]},enabled:{type:'boolean',required:true,enum:[true]}}};
 for(const config of [
  {region:'u',limit:0,enabled:true},{region:'other',limit:0,enabled:true},{region:'uk',limit:0,enabled:true},
  {region:'us',limit:-1,enabled:true},{region:'us',limit:11,enabled:true},{region:'us',limit:1,enabled:true},
  {region:'us',limit:10,enabled:false}
 ]) {
  const registry=new ExtensionRegistry(host());assert.throws(()=>registry.register(m,bindings,config),/Invalid extension configuration/);
  assert.deepEqual(registry.getManifests(),[]);assert.equal(registry.get('components','chart'),undefined);
 }
 for(const limit of [0,5,10]) {const registry=new ExtensionRegistry(host());registry.register(m,bindings,{region:'eu',limit,enabled:true});assert.equal(registry.getConfiguration(m.id).limit,limit);}
});

test('rejects invalid or contradictory configuration constraints',()=>{
 const rules=[
  {type:'string',required:true,minLength:-1},{type:'string',required:true,maxLength:4097},
  {type:'string',required:true,minLength:4,maxLength:3},{type:'string',required:true,minimum:0},
  {type:'number',required:true,minimum:Infinity},{type:'number',required:true,minimum:2,maximum:1},
  {type:'number',required:true,minLength:1},{type:'boolean',required:true,maximum:1},
  {type:'string',required:true,enum:[]},{type:'string',required:true,enum:['x','x']},
  {type:'string',required:true,minLength:2,enum:['x']},{type:'number',required:true,maximum:2,enum:[3]},
  {type:'boolean',required:true,enum:[1]},{type:'number',required:true,enum:Array.from({length:65},(_,i)=>i)}
 ];
 for(const rule of rules)assert.throws(()=>check([{...manifest(),configSchema:{option:rule}}],host(),required()),/configuration schema/);
});

test('materializes nested configuration defaults without retaining caller objects',async()=>{
 const {ExtensionRegistry}=await import('../dist/index.js');const fn=()=>{},bindings={components:{chart:fn},tools:{lookup:fn},providers:{}};
 const m={...manifest(),configSchema:{
  connection:{type:'object',required:true,properties:{host:{type:'string',required:true},port:{type:'number',required:false,minimum:1,maximum:65535,default:443}}},
  tags:{type:'array',required:false,maxItems:2,items:{type:'string',required:true,maxLength:8},default:['default']},
  flags:{type:'object',required:false,properties:{enabled:{type:'boolean',required:false,default:true}},default:{}}
 }};
 const registry=new ExtensionRegistry(host()),input={connection:{host:'local'}};registry.register(m,bindings,input);
 assert.deepEqual(registry.getConfiguration(m.id),{connection:{host:'local',port:443},tags:['default'],flags:{enabled:true}});
 input.connection.host='changed';m.configSchema.tags.default.push('mutated');
 const result=registry.getConfiguration(m.id);result.tags.push('changed');result.connection.host='changed';
 assert.deepEqual(registry.getConfiguration('example.chart'),{connection:{host:'local',port:443},tags:['default'],flags:{enabled:true}});
});

test('rejects invalid nested schemas and configurations atomically',async()=>{
 const {ExtensionRegistry}=await import('../dist/index.js');const fn=()=>{},bindings={components:{chart:fn},tools:{lookup:fn},providers:{}};
 const rule={type:'object',required:true,properties:{name:{type:'string',required:true},values:{type:'array',required:false,maxItems:2,items:{type:'number',required:true,minimum:0}}}};
 const m={...manifest(),configSchema:{settings:rule}};
 const cycle={name:'safe'};cycle.self=cycle;
 for(const settings of [{},{name:'safe',extra:true},{name:'safe',values:[-1]},{name:'safe',values:[1,2,3]},{name:'safe',values:[,1]},cycle,JSON.parse('{"name":"safe","constructor":1}')]){
  const registry=new ExtensionRegistry(host());assert.throws(()=>registry.register(m,bindings,{settings}),/Invalid extension configuration/);assert.deepEqual(registry.getManifests(),[]);
 }
 const invalidRules=[
  {type:'object',required:true},{type:'array',required:true},{type:'array',required:true,maxItems:257,items:{type:'string',required:true}},
  {type:'boolean',required:true,default:true},{type:'string',required:false,minLength:2,default:'x'},
  {type:'object',required:false,properties:{name:{type:'string',required:true}},default:{}},
  {type:'array',required:false,items:{type:'number',required:true},default:[false]}
 ];
 for(const invalid of invalidRules)assert.throws(()=>check([{...manifest(),configSchema:{settings:invalid}}],host(),required()),/configuration schema/);
 const recursive={type:'object',required:true,properties:{}};recursive.properties.next=recursive;
 assert.throws(()=>check([{...manifest(),configSchema:{settings:recursive}}],host(),required()),/configuration schema/);
 let deep={type:'string',required:true};for(let i=0;i<11;i++)deep={type:'object',required:true,properties:{child:deep}};
 assert.throws(()=>check([{...manifest(),configSchema:{settings:deep}}],host(),required()),/configuration schema/);
 const wide=Object.fromEntries(Array.from({length:5},(_,i)=>['group'+i,{type:'object',required:true,properties:Object.fromEntries(Array.from({length:60},(_,j)=>['item'+j,{type:'boolean',required:true}]))}]));
 assert.throws(()=>check([{...manifest(),configSchema:wide}],host(),required()),/configuration schema/);
 const matrix={...manifest(),configSchema:{rows:{type:'array',required:true,items:{type:'array',required:true,items:{type:'number',required:true}}}}};
 const registry=new ExtensionRegistry(host());
 assert.throws(()=>registry.register(matrix,bindings,{rows:Array.from({length:50},()=>Array(220).fill(1))}),/Invalid extension configuration/);
 assert.deepEqual(registry.getManifests(),[]);
});

test('extension runtime bridges require declared references and preserve capability policy',async()=>{
 const {ExtensionRegistry,CapabilityRegistry,registerExtensionComponent,registerExtensionCapability}=await import('../dist/index.js');
 const {basicRegistry,A2UIRenderer,BASIC_CATALOG}=await import('@app-mixer/web');
 const registry=new ExtensionRegistry(host()),m=manifest(),calls=[];
 const chart=(component,_child,_data,doc)=>{const element=doc.createElement('p');element.textContent=component.text;return element;};
 const lookup=(input,context)=>{calls.push({input,context});return 'result';};
 registry.register(m,{components:{chart},tools:{lookup},providers:{}});
 const ref={id:m.id,version:m.version,scope:m.scope};
 assert.equal(registry.getForApplication([], 'components','chart'),undefined);
 assert.throws(()=>registry.getForApplication([{...ref,version:'2.0.0'}],'components','chart'),/compatibility/);
 assert.throws(()=>registry.getForApplication([ref,ref],'components','chart'),/references/);
 const renderers=basicRegistry();assert.throws(()=>registerExtensionComponent(renderers,registry,[],'chart'),/not available/);
 registerExtensionComponent(renderers,registry,[ref],'chart',component=>{if(typeof component.text!=='string')throw Error('Invalid chart');});
 const doc={createElement(tag){return {tagName:tag,ownerDocument:doc,children:[],dataset:{},style:{},textContent:'',appendChild(child){this.children.push(child);},replaceChildren(...children){this.children=children;}};}},root=doc.createElement('main');
 const renderer=new A2UIRenderer(root,renderers);renderer.apply({version:'v0.9.1',createSurface:{surfaceId:'main',catalogId:BASIC_CATALOG}});
 renderer.apply({version:'v0.9.1',updateComponents:{surfaceId:'main',components:[{id:'root',component:'chart',text:'Rendered'}]}});
 assert.equal(root.children[0].children[0].textContent,'Rendered');
 assert.throws(()=>renderer.apply({version:'v0.9.1',updateComponents:{surfaceId:'main',components:[{id:'unused',component:'chart',text:1}]}}),/Invalid chart/);
 assert.equal(root.children[0].children[0].textContent,'Rendered');
 const audits=[],capabilities=new CapabilityRegistry(event=>audits.push(event.outcome));
 const candidate={operationId:'lookup',method:'GET',path:'/lookup'};
 assert.throws(()=>registerExtensionCapability(capabilities,registry,[],candidate,{authorize:()=>true,validate:()=>true}),/not available/);
 assert.throws(()=>registerExtensionCapability(capabilities,registry,[ref],candidate,{authorize:()=>true,validate:()=>true,authorizeExtension:()=>false}),/requires a declared/);
 registerExtensionCapability(capabilities,registry,[ref],candidate,{authorize:context=>context.principalId==='allowed',validate:input=>input?.valid===true});
 const context={tenantId:'tenant',principalId:'denied',origin:'ui'};
 await assert.rejects(()=>capabilities.invoke('lookup',{valid:true},context),/forbidden/);assert.equal(calls.length,0);
 context.principalId='allowed';await assert.rejects(()=>capabilities.invoke('lookup',{valid:false},context),/Invalid capability input/);assert.equal(calls.length,0);
 assert.equal(await capabilities.invoke('lookup',{valid:true},context),'result');assert.deepEqual(calls,[{input:{valid:true},context:{tenantId:'tenant',principalId:'allowed'}}]);
 assert.deepEqual(audits,['attempt','denied','attempt','invalid','attempt','succeeded']);
});

test('runtime assembly registers declared components and operations with explicit host policies',async()=>{
 const {ExtensionRegistry,createExtensionRuntime}=await import('../dist/index.js');
 const {A2UIRenderer,APP_MIXER_CATALOG}=await import('@app-mixer/web');
 const m={...manifest(),providers:['records']},ref={id:m.id,version:m.version,scope:m.scope},calls=[];
 const chart=(c,_child,_data,doc)=>{const node=doc.createElement('p');node.textContent=c.label;return node;};
 const registry=new ExtensionRegistry(host());registry.register(m,{components:{chart},tools:{lookup:(input,context)=>{calls.push({input,context});return 'ok';}},providers:{records:()=>['record']}});
 const application={id:'demo',schemaVersion:1,revision:0,extensions:[ref],pages:[{id:'home',title:'Home',route:'/',components:[{id:'one',type:'Extension',extensionId:ref.id,name:'chart'},{id:'two',type:'Extension',extensionId:ref.id,name:'chart'}]}],extensionOperations:[{extensionId:ref.id,kind:'tool',name:'lookup'},{extensionId:ref.id,kind:'provider',name:'records'}]};
 const audit=[],policy={authorize:context=>context.principalId==='allowed',validate:input=>input?.ok===true};
 const bindings={componentValidators:{chart:c=>{if(typeof c.label!=='string')throw Error('Invalid chart');}},operations:{lookup:{candidate:{operationId:'lookup',method:'GET',path:'/lookup'},...policy},records:{candidate:{operationId:'records',method:'GET',path:'/records'},...policy}}};
 assert.throws(()=>createExtensionRuntime(application,registry,undefined,bindings),/Audit sink/);
 const runtime=createExtensionRuntime(application,registry,event=>audit.push(event.outcome),bindings);
 const doc={createElement(){return {ownerDocument:doc,children:[],dataset:{},style:{},textContent:'',appendChild(child){this.children.push(child);},replaceChildren(...children){this.children=children;}};}},hostNode=doc.createElement();
 const renderer=new A2UIRenderer(hostNode,runtime.components);
 renderer.apply({version:'v0.9.1',createSurface:{surfaceId:'main',catalogId:APP_MIXER_CATALOG}});
 renderer.apply({version:'v0.9.1',updateComponents:{surfaceId:'main',components:[{id:'root',component:'chart',label:'Sales'}]}});
 assert.equal(hostNode.children[0].children[0].textContent,'Sales');
 const context={tenantId:'tenant',principalId:'denied',origin:'ui'};
 await assert.rejects(()=>runtime.capabilities.invoke('lookup',{ok:true},context),/forbidden/);
 context.principalId='allowed';await assert.rejects(()=>runtime.capabilities.invoke('lookup',{ok:false},context),/Invalid capability input/);
 assert.equal(await runtime.capabilities.invoke('lookup',{ok:true},context),'ok');assert.deepEqual(await runtime.capabilities.invoke('records',{ok:true},context),['record']);
 assert.deepEqual(calls,[{input:{ok:true},context:{tenantId:'tenant',principalId:'allowed'}}]);
 assert.deepEqual(audit,['attempt','denied','attempt','invalid','attempt','succeeded','attempt','succeeded']);
 for(const [app,options] of [
  [{...application,extensions:[{...ref,version:'2.0.0'}]},bindings],
  [{...application,extensions:[]},bindings],
  [application,{...bindings,operations:{lookup:bindings.operations.lookup}}],
  [application,{...bindings,operations:{...bindings.operations,lookup:{...bindings.operations.lookup,candidate:{...bindings.operations.lookup.candidate,operationId:'other'}}}}],
  [{...application,extensionOperations:[...application.extensionOperations,{extensionId:ref.id,kind:'provider',name:'lookup'}]},bindings]
 ])assert.throws(()=>createExtensionRuntime(app,registry,()=>{},options));
});

test('native extension bridge installs only the declared approved owner',async()=>{
 const {ExtensionRegistry,registerDeclaredNativeExtensionComponent}=await import('../dist/index.js');
 const {NativeComponentRegistry,NativeSurfaceStore,APP_MIXER_CATALOG}=await import('../../native/dist/index.js');
 const m={...manifest(),renderers:['react-native']},h={...host(),renderer:'react-native'},ref={id:m.id,version:m.version,scope:m.scope};
 const extensions=new ExtensionRegistry(h),render=()=>null;
 extensions.register(m,{components:{chart:render},tools:{lookup:()=>{}},providers:{}});
 const component={id:'chart',type:'Extension',extensionId:ref.id,name:'chart'};
 const application={id:'demo',schemaVersion:1,revision:0,extensions:[ref],pages:[{id:'home',title:'Home',route:'/',components:[component]}]};
 const registry=new NativeComponentRegistry();
 assert.throws(()=>registerDeclaredNativeExtensionComponent(registry,extensions,application,ref.id,'other',()=>true),/not declared/);
 assert.throws(()=>registerDeclaredNativeExtensionComponent(registry,extensions,{...application,extensions:[]},ref.id,'chart',()=>true),/not available/);
 registerDeclaredNativeExtensionComponent(registry,extensions,application,ref.id,'chart',c=>typeof c.label==='string');
 const store=new NativeSurfaceStore(registry);store.apply({version:'v0.9.1',createSurface:{surfaceId:'main',catalogId:APP_MIXER_CATALOG}});
 store.apply({version:'v0.9.1',updateComponents:{surfaceId:'main',components:[{id:'root',component:'chart',label:'Sales'}]}});
 assert.equal(store.snapshot()[0].root.extensionProps.label,'Sales');
 assert.throws(()=>store.apply({version:'v0.9.1',updateComponents:{surfaceId:'main',components:[{id:'root',component:'chart',label:1}]}}),/Invalid native extension/);
 assert.equal(store.snapshot()[0].root.extensionProps.label,'Sales');
});


test('Flutter extension plans contain only approved declared owners and match the Dart fixture', async () => {
 const {createFlutterExtensionPlan}=await import('../dist/index.js');
 const {readFileSync}=await import('node:fs');
 const m={...manifest(),renderers:['flutter']},h={...host(),renderer:'flutter'};
 const ref={id:m.id,version:m.version,scope:m.scope};
 const component={id:'one',type:'Extension',extensionId:ref.id,name:'chart'};
 const app={id:'demo',schemaVersion:1,revision:0,extensions:[ref],pages:[{id:'home',title:'Home',route:'/',components:[component,{...component,id:'two'}]}]};
 const expected=JSON.parse(readFileSync(new URL('../../../adapters/flutter/test/fixtures/extension-plan.json',import.meta.url),'utf8'));
 assert.deepEqual(createFlutterExtensionPlan(app,[m],h),expected);
 for(const [a,ms,hostValue] of [
  [{...app,extensions:[]},[m],h],
  [{...app,extensions:[{...ref,version:'2.0.0'}]},[m],h],
  [app,[{...m,components:[]}],h],
  [app,[m],{...h,approved:[]}],
  [app,[m],{...h,renderer:'react'}],
  [app,[{...m,permissions:['admin']}],h],
 ])assert.throws(()=>createFlutterExtensionPlan(a,ms,hostValue));
});

test('signed Flutter plans bind the checked plan to the target and validity window',async()=>{
 const {signFlutterExtensionPlan}=await import('../dist/index.js'),{generateKeyPairSync,verify,createPublicKey}=await import('node:crypto'),{readFileSync}=await import('node:fs');const m={...manifest(),renderers:['flutter']},h={...host(),renderer:'flutter'},ref={id:m.id,version:m.version,scope:m.scope},app={id:'demo',schemaVersion:1,revision:0,extensions:[ref],pages:[{id:'home',title:'Home',route:'/',components:[{id:'one',type:'Extension',extensionId:ref.id,name:'chart'}]}]},keys=generateKeyPairSync('ed25519'),options={tenantId:'tenant',environment:'production',keyId:'key-1',privateKey:keys.privateKey,issuedAt:100,expiresAt:10000};const signed=signFlutterExtensionPlan(app,[m],h,options),message=Buffer.from(`app-mixer-flutter-plan-v1.${signed.keyId}.${signed.payload}`),payload=JSON.parse(Buffer.from(signed.payload,'base64url'));assert.equal(verify(null,message,keys.publicKey,Buffer.from(signed.signature,'base64url')),true);assert.equal(verify(null,Buffer.from(message.toString().replace('key-1','key-2')),keys.publicKey,Buffer.from(signed.signature,'base64url')),false);assert.deepEqual([payload.tenantId,payload.environment,payload.issuedAt,payload.expiresAt,payload.plan.applicationId,payload.plan.revision],['tenant','production',100,10000,'demo',0]);for(const invalid of [{keyId:'bad key'},{tenantId:'../tenant'},{environment:'Other'},{privateKey:keys.publicKey},{expiresAt:100},{expiresAt:100+86400001}])assert.throws(()=>signFlutterExtensionPlan(app,[m],h,{...options,...invalid}),/Invalid/);assert.throws(()=>signFlutterExtensionPlan(app,[m],{...h,approved:[]},options),/compatibility/i);
 const fixture=JSON.parse(readFileSync(new URL('../../../adapters/flutter/test/fixtures/signed-extension-plan.json',import.meta.url),'utf8')),key=createPublicKey({key:{kty:'OKP',crv:'Ed25519',x:fixture.publicKey},format:'jwk'}),envelope=fixture.envelope;assert.equal(verify(null,Buffer.from(`app-mixer-flutter-plan-v1.${envelope.keyId}.${envelope.payload}`),key,Buffer.from(envelope.signature,'base64url')),true);assert.deepEqual(JSON.parse(Buffer.from(envelope.payload,'base64url')).plan,payload.plan);
});
