import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteDataProvider,SqliteApplicationStore} from '../dist/index.js';

test('business records persist separately from publication and isolate tenants and applications',()=>{
 const dir=mkdtempSync(join(tmpdir(),'app-mixer-data-')),path=join(dir,'db.sqlite');
 const scope={tenantId:'tenant-a',applicationId:'app-a'},otherTenant={...scope,tenantId:'tenant-b'},otherApp={...scope,applicationId:'app-b'};
 let provider=new SqliteDataProvider(path);const data={name:'Ada',nested:{score:1}};
 try {
  assert.deepEqual(provider.put(scope,'people','one',data,null),{id:'one',revision:1,value:data});
  data.nested.score=9;assert.equal(provider.get(scope,'people','one').value.nested.score,1);
  const read=provider.get(scope,'people','one');read.value.nested.score=7;assert.equal(provider.get(scope,'people','one').value.nested.score,1);
  assert.equal(provider.get(otherTenant,'people','one'),undefined);assert.equal(provider.get(otherApp,'people','one'),undefined);
  provider.put(otherTenant,'people','one',{name:'Other'},null);
  const definitions=new SqliteApplicationStore(path,{id:'app-a',schemaVersion:1,revision:0,pages:[]});
  definitions.publish(0);definitions.close();assert.equal(provider.get(scope,'people','one').value.name,'Ada');
  provider.close();provider=new SqliteDataProvider(path);
  assert.equal(provider.get(scope,'people','one').value.name,'Ada');assert.equal(provider.get(otherTenant,'people','one').value.name,'Other');
 } finally {provider.close();rmSync(dir,{recursive:true,force:true});}
});

test('optimistic writes reject conflicts and stale revisions across delete and recreate',()=>{
 const provider=new SqliteDataProvider(':memory:'),scope={tenantId:'t',applicationId:'a'};
 try {
  provider.put(scope,'items','x',{n:1},null);
  assert.throws(()=>provider.put(scope,'items','x',{n:2},null),/conflict/);
  assert.throws(()=>provider.delete(scope,'items','x',2),/conflict/);
  assert.equal(provider.put(scope,'items','x',{n:2},1).revision,2);
  assert.throws(()=>provider.put(scope,'items','x',{n:3},1),/conflict/);
  provider.delete(scope,'items','x',2);assert.equal(provider.get(scope,'items','x'),undefined);
  const recreated=provider.put(scope,'items','x',{n:4},null);assert.equal(recreated.revision,4);
  assert.throws(()=>provider.put(scope,'items','x',{n:5},2),/conflict/);
  assert.throws(()=>provider.delete(scope,'items','x',2),/conflict/);
  assert.deepEqual(provider.get(scope,'items','x').value,{n:4});
 } finally {provider.close();}
});

test('invalid data and scope leave records unchanged',()=>{
 const provider=new SqliteDataProvider(':memory:'),scope={tenantId:'t',applicationId:'a'};
 try {
  provider.put(scope,'items','x',{safe:true},null);
  const cycle={};cycle.self=cycle;const sparse=[];sparse.length=2;sparse[0]='x';sparse.extra='y';
  for(const value of [cycle,{sparse},{x:Infinity},{x:undefined},JSON.parse('{"__proto__":{"x":1}}'),{x:new Date()}, {x:'x'.repeat(1024*1024)}])
   assert.throws(()=>provider.put(scope,'items','x',value,1));
  assert.throws(()=>provider.put({...scope,tenantId:''},'items','x',{safe:false},1));
  assert.deepEqual(provider.get(scope,'items','x').value,{safe:true});
 } finally {provider.close();}
});

test('UI and agent access use the same host authorization and tenant scope',async()=>{
 const {CapabilityRegistry}=await import('../dist/index.js');
 const provider=new SqliteDataProvider(':memory:'),audit=[],registry=new CapabilityRegistry(event=>audit.push(event));
 try {
  registry.register({operationId:'savePerson',method:'PUT',path:'/people'}, {
   authorize:({principalId})=>principalId==='allowed',validate:input=>typeof input?.name==='string',
   execute:(input,context)=>provider.put({tenantId:context.tenantId,applicationId:'app'},'people','one',input,null)
  });
  for(const origin of ['ui','agent'])await assert.rejects(registry.invoke('savePerson',{name:'Unsafe'},{tenantId:'t',principalId:'denied',origin}),/forbidden/);
  assert.equal(provider.get({tenantId:'t',applicationId:'app'},'people','one'),undefined);
  await registry.invoke('savePerson',{name:'Ada'},{tenantId:'t',principalId:'allowed',origin:'agent'});
  assert.equal(provider.get({tenantId:'t',applicationId:'app'},'people','one').value.name,'Ada');
  assert.deepEqual(audit.map(event=>event.outcome),['attempt','denied','attempt','denied','attempt','succeeded']);
 } finally {provider.close();}
});


test('separate SQLite connections observe revision conflicts',()=>{
 const dir=mkdtempSync(join(tmpdir(),'app-mixer-connections-')),path=join(dir,'db.sqlite'),scope={tenantId:'t',applicationId:'a'};
 const first=new SqliteDataProvider(path),second=new SqliteDataProvider(path);
 try {
  first.put(scope,'items','one',{value:1},null);
  const revision=second.get(scope,'items','one').revision;
  first.put(scope,'items','one',{value:2},revision);
  assert.throws(()=>second.put(scope,'items','one',{value:3},revision),/conflict/);
  assert.equal(second.get(scope,'items','one').value.value,2);
 } finally {first.close();second.close();rmSync(dir,{recursive:true,force:true});}
});
