import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {ApplicationStore,SqliteApplicationStore,createControlPlane,createDataPlane,createPromotionPackage} from '../dist/index.js';
const initial={id:'demo',schemaVersion:1,revision:0,pages:[{id:'home',title:'Home',route:'/',components:[]}]};

test('version 1 draft migrates explicitly, retains publications and supports editing version 2',()=>{
 for(const make of [()=>new ApplicationStore(initial),()=>new SqliteApplicationStore(':memory:',initial)]){
  const store=make();try{
   store.publish(0);assert.throws(()=>store.migrateDraft(1,2),/Revision conflict/);assert.throws(()=>store.migrateDraft(0,3),/Unsupported/);assert.deepEqual(store.getDraft(),initial);
   const migrated=store.migrateDraft(0,2);assert.equal(migrated.revision,1);assert.equal(migrated.schemaVersion,2);assert.equal(migrated.pages[0].description,'');assert.equal(store.getPublished().definition.schemaVersion,1);
   assert.throws(()=>store.migrateDraft(1,2),/Unsupported/);assert.throws(()=>store.apply(1,[{op:'addPage',page:{id:'new',title:'New',route:'/new',components:[]}}]),/invalid page/i);assert.equal(store.getDraft().revision,1);
   store.apply(1,[{op:'setPageDescription',pageId:'home',description:'A useful page'}]);assert.equal(store.publish(2).definition.pages[0].description,'A useful page');
   const pkg=createPromotionPackage('development',store.getPublished());const destination=make();try{assert.equal(destination.promote(pkg,0,'production').definition.schemaVersion,2);}finally{destination.close?.();}
   assert.equal(store.rollback(1,2).definition.schemaVersion,1);assert.equal(store.getDraft().schemaVersion,2);
  }finally{store.close?.();}
 }
});

test('SQLite draft migration persists and rejects stale competing connections',()=>{
 const dir=mkdtempSync(join(tmpdir(),'app-mixer-schema-draft-')),path=join(dir,'db.sqlite');let a,b;
 try{a=new SqliteApplicationStore(path,initial);b=new SqliteApplicationStore(path,initial);a.migrateDraft(0,2);assert.throws(()=>b.migrateDraft(0,2),/Revision conflict/);a.close();a=undefined;b.close();b=undefined;a=new SqliteApplicationStore(path,initial);assert.equal(a.getDraft().schemaVersion,2);assert.equal(a.getDraft().revision,1);}finally{a?.close();b?.close();rmSync(dir,{recursive:true,force:true});}
});

test('control plane protects migration and data plane continues serving the prior version until publish',async()=>{
 const store=new ApplicationStore(initial);store.publish(0);const token='a-strong-local-token-at-least-32-characters',control=createControlPlane(store,token),data=createDataPlane(store);control.listen(0,'127.0.0.1');data.listen(0,'127.0.0.1');await Promise.all([once(control,'listening'),once(data,'listening')]);
 try{const c=`http://127.0.0.1:${control.address().port}`,d=`http://127.0.0.1:${data.address().port}`,headers={authorization:`Bearer ${token}`,'content-type':'application/json'},post=value=>({method:'POST',headers,body:JSON.stringify(value)});
  assert.equal((await fetch(c+'/draft/migrate',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
  assert.equal((await fetch(c+'/draft/migrate',post({expectedRevision:0,targetVersion:3}))).status,409);
  assert.equal((await fetch(c+'/draft/migrate',post({expectedRevision:0,targetVersion:2}))).status,200);
  assert.equal((await (await fetch(d+'/application')).json()).definition.schemaVersion,1);
  assert.equal((await fetch(c+'/draft/patches',post({baseRevision:1,patches:[{op:'setPageDescription',pageId:'home',description:'Description'}]}))).status,200);
  assert.equal((await fetch(c+'/publish',post({expectedRevision:2}))).status,201);
  const latest=await (await fetch(d+'/application')).json();assert.equal(latest.definition.schemaVersion,2);assert.equal(latest.definition.pages[0].description,'Description');assert.equal((await (await fetch(d+'/application/versions/1')).json()).definition.schemaVersion,1);
 }finally{await Promise.all([control,data].map(s=>new Promise(r=>s.close(r))));}
});
