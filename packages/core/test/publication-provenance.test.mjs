import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {ApplicationStore,SqliteApplicationStore,createControlPlane,createDataPlane} from '../dist/index.js';
const initial={id:'demo',schemaVersion:1,revision:0,pages:[{id:'home',title:'Original',route:'/',components:[]}]};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('publication provenance identifies publish and rollback without changing publication payloads',()=>{
 for(const make of [()=>new ApplicationStore(initial),()=>new SqliteApplicationStore(':memory:',initial)]){
  const store=make();try{const a=store.publish(0);store.apply(0,[{op:'setPageTitle',pageId:'home',title:'Changed'}]);store.publish(1);const rollback=store.rollback(1,2);
   assert.deepEqual(store.getPublicationProvenance(1),{version:1,kind:'publish',previousVersion:0,definitionSha256:hash(a.definition)});
   assert.deepEqual(store.getPublicationProvenance(3),{version:3,kind:'rollback',previousVersion:2,sourceVersion:1,definitionSha256:hash(a.definition)});
   const record=store.getPublicationProvenance(3);record.sourceVersion=2;assert.equal(store.getPublicationProvenance(3).sourceVersion,1);
   assert.deepEqual(Object.keys(rollback).sort(),['definition','version']);assert.equal(store.getPublicationProvenance(99),undefined);assert.throws(()=>store.getPublicationProvenance(0),/Invalid version/);
  }finally{store.close?.();}
 }
});

test('legacy SQLite versions remain unknown and new provenance persists immutably',()=>{
 const dir=mkdtempSync(join(tmpdir(),'app-mixer-history-')),path=join(dir,'db.sqlite');let store,db;
 try{
  db=new DatabaseSync(path);db.exec('CREATE TABLE application_drafts (app_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, definition TEXT NOT NULL); CREATE TABLE application_publications (app_id TEXT NOT NULL, version INTEGER NOT NULL, definition TEXT NOT NULL, PRIMARY KEY (app_id,version));');db.prepare('INSERT INTO application_drafts VALUES (?,?,?)').run('demo',0,JSON.stringify(initial));db.prepare('INSERT INTO application_publications VALUES (?,?,?)').run('demo',1,JSON.stringify(initial));db.close();db=undefined;
  store=new SqliteApplicationStore(path,initial);assert.deepEqual(store.getPublicationProvenance(1),{version:1,kind:'unknown'});store.publish(0);store.rollback(1,2);store.close();store=undefined;
  store=new SqliteApplicationStore(path,initial);assert.equal(store.getPublicationProvenance(3).sourceVersion,1);assert.equal(store.getPublicationProvenance(2).kind,'publish');
  db=new DatabaseSync(path);assert.throws(()=>db.prepare('UPDATE application_publication_provenance SET source_version=2 WHERE app_id=? AND version=3').run('demo'),/immutable/);assert.throws(()=>db.prepare('DELETE FROM application_publication_provenance WHERE app_id=? AND version=3').run('demo'),/immutable/);assert.throws(()=>db.prepare('INSERT OR REPLACE INTO application_publication_provenance SELECT * FROM application_publication_provenance WHERE app_id=? AND version=3').run('demo'),/immutable/);
 }finally{db?.close();store?.close();rmSync(dir,{recursive:true,force:true});}
});

test('a provenance write failure rolls back the publication atomically',()=>{
 const dir=mkdtempSync(join(tmpdir(),'app-mixer-history-')),path=join(dir,'db.sqlite');let store,db;
 try{store=new SqliteApplicationStore(path,initial);store.publish(0);store.publish(0);db=new DatabaseSync(path);db.exec("CREATE TRIGGER fail_provenance BEFORE INSERT ON application_publication_provenance BEGIN SELECT RAISE(ABORT,'test failure'); END;");
  assert.throws(()=>store.rollback(1,2),/test failure/);assert.equal(store.getPublished().version,2);assert.equal(store.getPublished(3),undefined);assert.equal(store.getPublicationProvenance(3),undefined);
  assert.throws(()=>store.publish(0),/test failure/);assert.equal(store.getPublished().version,2);
 }finally{db?.close();store?.close();rmSync(dir,{recursive:true,force:true});}
});

test('provenance lookup is limited to the authenticated control plane',async()=>{
 const store=new ApplicationStore(initial);store.publish(0);store.publish(0);store.rollback(1,2);const token='a-strong-local-token-at-least-32-characters';const control=createControlPlane(store,token),data=createDataPlane(store);control.listen(0,'127.0.0.1');data.listen(0,'127.0.0.1');await Promise.all([once(control,'listening'),once(data,'listening')]);
 try{const c=`http://127.0.0.1:${control.address().port}`,d=`http://127.0.0.1:${data.address().port}`,path='/publications/3/provenance';assert.equal((await fetch(c+path)).status,401);assert.equal((await fetch(d+path)).status,404);const result=await fetch(c+path,{headers:{authorization:`Bearer ${token}`}});assert.equal(result.status,200);assert.equal((await result.json()).sourceVersion,1);assert.equal((await fetch(c+'/publications/9/provenance',{headers:{authorization:`Bearer ${token}`}})).status,404);}
 finally{await Promise.all([new Promise(r=>control.close(r)),new Promise(r=>data.close(r))]);}
});
