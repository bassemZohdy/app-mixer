import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SqliteDataProvider,CapabilityRegistry,registerDataCapability} from '../dist/index.js';
const scope={tenantId:'tenant',applicationId:'app'};
const migration=(preview,overrides={})=>({fromVersion:0,toVersion:1,digest:preview.digest,transform:value=>({fullName:value.name}),validate:value=>typeof value.fullName==='string',...overrides});

test('migration is scoped, versioned and blocks old writers while preserving revision conflicts',()=>{
 const provider=new SqliteDataProvider(':memory:');try{
  provider.put(scope,'people','one',{name:'Ada'},null);provider.put(scope,'people','two',{name:'Lin'},null);provider.put({...scope,tenantId:'other'},'people','one',{name:'Other'},null);
  const before=provider.previewMigration(scope,'people');assert.equal(before.schemaVersion,0);assert.equal(before.count,2);
  const after=provider.migrateCollection(scope,'people',migration(before));assert.equal(after.schemaVersion,1);assert.equal(after.count,2);assert.notEqual(after.digest,before.digest);
  assert.deepEqual(provider.get(scope,'people','one'),{id:'one',revision:2,value:{fullName:'Ada'}});assert.equal(provider.get({...scope,tenantId:'other'},'people','one').value.name,'Other');
  assert.throws(()=>provider.put(scope,'people','one',{name:'old'},2),/schema version conflict/);assert.throws(()=>provider.delete(scope,'people','one',2),/schema version conflict/);
  assert.throws(()=>provider.put(scope,'people','one',{fullName:'new'},1,1),/revision conflict/);assert.equal(provider.put(scope,'people','one',{fullName:'new'},2,1).revision,3);provider.delete(scope,'people','one',3,1);assert.equal(provider.get(scope,'people','one'),undefined);
  assert.throws(()=>provider.migrateCollection(scope,'people',migration(before)),/snapshot conflict/);
 }finally{provider.close();}
});

test('stale preview, invalid transform and validation failure leave all data unchanged',()=>{
 const provider=new SqliteDataProvider(':memory:');try{
  provider.put(scope,'people','a',{name:'Ada'},null);provider.put(scope,'people','b',{name:'Lin'},null);const stale=provider.previewMigration(scope,'people');provider.put(scope,'people','a',{name:'Changed'},1);
  assert.throws(()=>provider.migrateCollection(scope,'people',migration(stale)),/snapshot conflict/);const preview=provider.previewMigration(scope,'people');
  assert.throws(()=>provider.migrateCollection(scope,'people',migration(preview,{transform:(value,id)=>id==='b'?{bad:undefined}:value,validate:()=>true})),/Invalid data value/);
  assert.throws(()=>provider.migrateCollection(scope,'people',migration(preview,{validate:(_value,id)=>id!=='b'})),/validation failed/);
  assert.throws(()=>provider.migrateCollection(scope,'people',migration(preview,{transform:async value=>value})),/Invalid data value/);
  assert.deepEqual(provider.previewMigration(scope,'people'),preview);assert.equal(provider.get(scope,'people','a').revision,2);assert.equal(provider.get(scope,'people','b').revision,1);
 }finally{provider.close();}
});

test('migration persists across connections and history failure rolls back',()=>{
 const dir=mkdtempSync(join(tmpdir(),'app-mixer-schema-')),path=join(dir,'data.sqlite');let a,b,db;
 try{a=new SqliteDataProvider(path);b=new SqliteDataProvider(path);a.put(scope,'people','x',{name:'Ada'},null);const preview=a.previewMigration(scope,'people');b.put(scope,'people','x',{name:'New'},1);assert.throws(()=>a.migrateCollection(scope,'people',migration(preview)),/snapshot conflict/);
  db=new DatabaseSync(path);db.exec("CREATE TRIGGER fail_migration BEFORE INSERT ON business_schema_migrations BEGIN SELECT RAISE(ABORT,'test failure'); END;");const current=a.previewMigration(scope,'people');assert.throws(()=>a.migrateCollection(scope,'people',migration(current)),/test failure/);assert.deepEqual(a.previewMigration(scope,'people'),current);db.exec('DROP TRIGGER fail_migration');a.migrateCollection(scope,'people',migration(current));
  assert.throws(()=>db.exec('DELETE FROM business_schema_migrations'),/immutable/);a.close();a=undefined;b.close();b=undefined;a=new SqliteDataProvider(path);assert.equal(a.getSchemaVersion(scope,'people'),1);assert.equal(a.get(scope,'people','x').value.fullName,'New');
 }finally{db?.close();a?.close();b?.close();rmSync(dir,{recursive:true,force:true});}
});

test('data capabilities pass an explicit schema version through the authorization boundary',async()=>{
 const provider=new SqliteDataProvider(':memory:'),registry=new CapabilityRegistry(()=>{});try{
  const preview=provider.previewMigration(scope,'people');provider.migrateCollection(scope,'people',migration(preview));
  registerDataCapability(registry,provider,{candidate:{operationId:'save',method:'PUT',path:'/people'},applicationId:'app',collection:'people',operation:'put',authorize:()=>true,validate:input=>input.value.fullName==='Ada'});
  const context={tenantId:'tenant',principalId:'user',origin:'ui'};
  await assert.rejects(registry.invoke('save',{id:'x',expectedRevision:null,value:{fullName:'Ada'}},context),/schema version conflict/);
  await registry.invoke('save',{id:'x',expectedRevision:null,expectedSchemaVersion:1,value:{fullName:'Ada'}},context);assert.equal(provider.get(scope,'people','x').value.fullName,'Ada');
 }finally{provider.close();}
});


test('migration snapshots caller configuration and rejects asynchronous validators',()=>{
 const provider=new SqliteDataProvider(':memory:'),mutableScope={...scope};try{
  provider.put(mutableScope,'people','a',{name:'Ada'},null);let preview=provider.previewMigration(mutableScope,'people');
  assert.throws(()=>provider.migrateCollection(mutableScope,'people',migration(preview,{validate:async()=>true})),/validation failed/);
  const spec=migration(preview);spec.transform=value=>{mutableScope.tenantId='other';spec.toVersion=9;return {fullName:value.name};};
  provider.migrateCollection(mutableScope,'people',spec);assert.equal(provider.getSchemaVersion(scope,'people'),1);assert.equal(provider.get(scope,'people','a').value.fullName,'Ada');assert.equal(provider.getSchemaVersion(mutableScope,'people'),0);
 }finally{provider.close();}
});


test('collection migration refuses more than the bounded number of live records',()=>{
 const provider=new SqliteDataProvider(':memory:');try{
  for(let i=0;i<1001;i++)provider.put(scope,'large',String(i),{name:'value'},null);
  assert.throws(()=>provider.previewMigration(scope,'large'),/collection too large/);assert.equal(provider.getSchemaVersion(scope,'large'),0);
 }finally{provider.close();}
});
