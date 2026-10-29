import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {ApplicationStore,SqliteApplicationStore,PublishedDefinitionCache,CachedPublishedRepository,createControlPlane,createDataPlane} from '../dist/index.js';
const initial={id:'demo',schemaVersion:1,revision:0,pages:[{id:'home',route:'/',title:'Original',components:[]}]};

test('rollback appends a compatible version and leaves draft and historical publications intact',()=>{
 for(const make of [guard=>new ApplicationStore(initial,guard),guard=>new SqliteApplicationStore(':memory:',initial,guard)]){
  let compatible=true;const store=make(()=>{if(!compatible)throw Error('Extension compatibility failed');return true;});
  try{
   store.publish(0);store.apply(0,[{op:'setPageTitle',pageId:'home',title:'Second'}]);store.publish(1);store.apply(1,[{op:'setPageTitle',pageId:'home',title:'Unpublished'}]);
   assert.throws(()=>store.rollback(1,1),/version conflict/);assert.throws(()=>store.rollback(10,2),/Publication not found/);assert.throws(()=>store.rollback(2,2),/earlier version/);assert.throws(()=>store.rollback(0,2),/Invalid version/);
   compatible=false;assert.throws(()=>store.rollback(1,2),/compatibility failed/);assert.equal(store.getPublished().version,2);
   compatible=true;const result=store.rollback(1,2);assert.equal(result.version,3);assert.equal(result.definition.pages[0].title,'Original');result.definition.pages[0].title='Mutated';
   assert.equal(store.getPublished().definition.pages[0].title,'Original');assert.equal(store.getPublished(2).definition.pages[0].title,'Second');assert.equal(store.getDraft().pages[0].title,'Unpublished');
   assert.throws(()=>store.rollback(1,2),/version conflict/);assert.equal(store.publish(2).version,4);assert.equal(store.getPublished().definition.pages[0].title,'Unpublished');
  }finally{store.close?.();}
 }
});

test('SQLite rollback persists and compares the latest version across connections',()=>{
 const dir=mkdtempSync(join(tmpdir(),'app-mixer-rollback-')),path=join(dir,'db.sqlite');let a,b;
 try{a=new SqliteApplicationStore(path,initial);b=new SqliteApplicationStore(path,initial);a.publish(0);a.apply(0,[{op:'setPageTitle',pageId:'home',title:'Changed'}]);a.publish(1);assert.equal(b.rollback(1,2).version,3);assert.throws(()=>a.rollback(1,2),/version conflict/);a.close();a=undefined;b.close();b=undefined;a=new SqliteApplicationStore(path,initial);assert.equal(a.getPublished().definition.pages[0].title,'Original');assert.equal(a.getDraft().pages[0].title,'Changed');}finally{a?.close();b?.close();rmSync(dir,{recursive:true,force:true});}
});

test('authenticated control rollback propagates through the data plane and its cache',async()=>{
 const store=new ApplicationStore(initial),cache=new PublishedDefinitionCache(),cached=new CachedPublishedRepository(store,{tenantId:'t',authorizationKey:'v1',applicationId:'demo',schemaVersion:1},cache);store.publish(0);store.apply(0,[{op:'setPageTitle',pageId:'home',title:'Changed'}]);store.publish(1);
 const token='a-strong-local-token-at-least-32-characters',control=createControlPlane(store,token),data=createDataPlane(cached);control.listen(0,'127.0.0.1');data.listen(0,'127.0.0.1');await Promise.all([once(control,'listening'),once(data,'listening')]);
 try{
  const c=`http://127.0.0.1:${control.address().port}`,d=`http://127.0.0.1:${data.address().port}`,headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
  const prior=await fetch(d+'/application'),etag=prior.headers.get('etag');assert.equal((await prior.json()).version,2);
  const post=(value,auth=true)=>({method:'POST',headers:auth?headers:{'content-type':'application/json'},body:JSON.stringify(value)});
  assert.equal((await fetch(c+'/rollback',post({sourceVersion:1,expectedVersion:2},false))).status,401);
  assert.equal((await fetch(c+'/rollback',post({sourceVersion:1,expectedVersion:1}))).status,409);
  assert.equal((await fetch(c+'/rollback',post({sourceVersion:9,expectedVersion:2}))).status,404);
  assert.equal((await fetch(c+'/rollback',post({sourceVersion:1,expectedVersion:2,extra:true}))).status,400);
  assert.equal((await fetch(d+'/rollback',post({sourceVersion:1,expectedVersion:2}))).status,404);
  const result=await fetch(c+'/rollback',post({sourceVersion:1,expectedVersion:2}));assert.equal(result.status,201);assert.equal((await result.json()).version,3);
  const current=await fetch(d+'/application',{headers:{'if-none-match':etag}});assert.equal(current.status,200);assert.equal((await current.json()).definition.pages[0].title,'Original');assert.notEqual(current.headers.get('etag'),etag);
  assert.equal((await (await fetch(d+'/application/versions/2')).json()).definition.pages[0].title,'Changed');
 }finally{await Promise.all([new Promise(r=>control.close(r)),new Promise(r=>data.close(r))]);}
});
