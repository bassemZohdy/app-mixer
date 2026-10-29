import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {ApplicationStore,SqliteApplicationStore,createPromotionPackage,createControlPlane,createDataPlane} from '../dist/index.js';
const initial={id:'demo',schemaVersion:1,revision:0,pages:[{id:'home',route:'/',title:'Source',components:[]}]};
const packageFor=store=>createPromotionPackage('development',store.getPublished(1));

test('promotion validates the package, target, compatibility and optimistic concurrency',()=>{
 for(const make of [guard=>new ApplicationStore(initial,guard),guard=>new SqliteApplicationStore(':memory:',initial,guard)]){
  const source=make(undefined);source.publish(0);const pkg=packageFor(source);let allowed=true;const target=make(()=>{if(!allowed)throw Error('Extension compatibility failed');return true;});
  try{
   const tampered=structuredClone(pkg);tampered.definition.pages[0].title='Tampered';assert.throws(()=>target.promote(tampered,0,'production'),/Invalid promotion package/);
   const wrongApp=createPromotionPackage('development',{version:1,definition:{...initial,id:'other'}});assert.throws(()=>target.promote(wrongApp,0,'production'),/Invalid promotion package/);
   assert.throws(()=>target.promote(pkg,0,'development'),/Invalid promotion package/);assert.throws(()=>target.promote({...pkg,unexpected:1},0,'production'),/Invalid promotion package/);
   allowed=false;assert.throws(()=>target.promote(pkg,0,'production'),/compatibility/);assert.equal(target.getPublished(),undefined);
   allowed=true;const promoted=target.promote(pkg,0,'production');assert.equal(promoted.version,1);assert.equal(promoted.definition.pages[0].title,'Source');assert.equal(target.getDraft().revision,0);assert.throws(()=>target.promote(pkg,0,'production'),/version conflict/);
   const provenance=target.getPublicationProvenance(1);assert.equal(provenance.kind,'promotion');assert.equal(provenance.sourceEnvironment,'development');assert.equal(provenance.targetEnvironment,'production');assert.equal(provenance.sourceVersion,1);assert.equal(provenance.packageDigest,pkg.digest);
   target.apply(0,[{op:'setPageTitle',pageId:'home',title:'Target draft'}]);assert.equal(target.publish(1).version,2);assert.equal(target.rollback(1,2).definition.pages[0].title,'Source');
  }finally{source.close?.();target.close?.();}
 }
});

test('SQLite promotion survives restart and metadata failure does not commit a publication',()=>{
 const dir=mkdtempSync(join(tmpdir(),'app-mixer-promotion-')),path=join(dir,'target.sqlite');let target,db;
 try{const source=new ApplicationStore(initial);source.publish(0);const pkg=packageFor(source);target=new SqliteApplicationStore(path,initial);target.promote(pkg,0,'production');target.close();target=new SqliteApplicationStore(path,initial);assert.equal(target.getPublicationProvenance(1).packageDigest,pkg.digest);
  db=new DatabaseSync(path);assert.throws(()=>db.exec('DELETE FROM application_promotions'),/immutable/);db.exec("CREATE TRIGGER fail_promotion BEFORE INSERT ON application_promotions BEGIN SELECT RAISE(ABORT,'test failure'); END;");assert.throws(()=>target.promote(pkg,1,'production'),/test failure/);assert.equal(target.getPublished().version,1);assert.equal(target.getPublicationProvenance(2),undefined);
 }finally{db?.close();target?.close();rmSync(dir,{recursive:true,force:true});}
});

test('control planes export and import an authenticated package between environments',async()=>{
 const source=new ApplicationStore(initial);source.publish(0);const target=new ApplicationStore(initial),token='a-strong-local-token-at-least-32-characters',a=createControlPlane(source,token),b=createControlPlane(target,token),data=createDataPlane(target);for(const s of [a,b,data])s.listen(0,'127.0.0.1');await Promise.all([a,b,data].map(s=>once(s,'listening')));
 try{const url=s=>`http://127.0.0.1:${s.address().port}`,headers={authorization:`Bearer ${token}`,'content-type':'application/json'},post=value=>({method:'POST',headers,body:JSON.stringify(value)});
  assert.equal((await fetch(url(a)+'/promotion/export',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
  const exported=await fetch(url(a)+'/promotion/export',post({sourceEnvironment:'development',version:1}));assert.equal(exported.status,200);const pkg=await exported.json();
  assert.equal((await fetch(url(b)+'/promotion/import',post({package:{...pkg,digest:'0'.repeat(64)},targetEnvironment:'production',expectedVersion:0}))).status,400);
  assert.equal((await fetch(url(b)+'/promotion/import',post({package:pkg,targetEnvironment:'production',expectedVersion:0}))).status,201);
  assert.equal((await fetch(url(b)+'/promotion/import',post({package:pkg,targetEnvironment:'production',expectedVersion:0}))).status,409);
  assert.equal((await (await fetch(url(data)+'/application')).json()).definition.pages[0].title,'Source');const provenance=await (await fetch(url(b)+'/publications/1/provenance',{headers})).json();assert.equal(provenance.kind,'promotion');
 }finally{await Promise.all([a,b,data].map(s=>new Promise(r=>s.close(r))));}
});
