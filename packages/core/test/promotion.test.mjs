import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {generateKeyPairSync} from 'node:crypto';
import {ApplicationStore,SqliteApplicationStore,createPromotionPackage,createControlPlane,createDataPlane,signPromotionPackage,createSignedPromotionVerifier} from '../dist/index.js';
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


test('signed promotion binds package, source, key and target',()=>{
 const source=new ApplicationStore(initial);source.publish(0);const pkg=packageFor(source),{privateKey,publicKey}=generateKeyPairSync('ed25519'),other=generateKeyPairSync('ed25519'),signed=signPromotionPackage(pkg,'production','key-1',privateKey),verify=createSignedPromotionVerifier([{sourceEnvironment:'development',keyId:'key-1',publicKey}],'production');assert.deepEqual(verify(signed,'production','demo'),pkg);
 const variants=[{...signed,signature:signed.signature.slice(0,-1)+(signed.signature.endsWith('A')?'B':'A')},{...signed,keyId:'other'},{...signed,targetEnvironment:'staging'},{...signed,package:{...pkg,definition:{...pkg.definition,id:'other'}}},{...signed,package:{...pkg,sourceEnvironment:'testing'}},{...signed,extra:true}];for(const value of variants)assert.throws(()=>verify(value,'production','demo'),/Invalid signed promotion/);assert.throws(()=>verify(signed,'staging','demo'),/Invalid signed promotion/);assert.throws(()=>verify(signed,'production','other'),/Invalid signed promotion/);assert.throws(()=>createSignedPromotionVerifier([{sourceEnvironment:'development',keyId:'key-1',publicKey},{sourceEnvironment:'development',keyId:'key-1',publicKey:other.publicKey}],'production'),/configuration/);assert.throws(()=>signPromotionPackage(pkg,'production','key-1',publicKey),/configuration/);const wrong=createSignedPromotionVerifier([{sourceEnvironment:'development',keyId:'key-1',publicKey:other.publicKey}],'production');assert.throws(()=>wrong(signed,'production','demo'),/Invalid signed promotion/);
});

test('target control plane enforces signed promotion and preserves optimistic concurrency',async()=>{
 const source=new ApplicationStore(initial),target=new ApplicationStore(initial);source.publish(0);const pkg=packageFor(source),{privateKey,publicKey}=generateKeyPairSync('ed25519'),verify=createSignedPromotionVerifier([{sourceEnvironment:'development',keyId:'key-1',publicKey}],'production'),signed=signPromotionPackage(pkg,'production','key-1',privateKey),token='strong-token-at-least-thirty-two-characters',server=createControlPlane(target,token,undefined,undefined,undefined,{verify});server.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${server.address().port}/promotion/import`,post=(item,targetEnvironment='production')=>fetch(url,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({package:item,targetEnvironment,expectedVersion:0})});try{assert.equal((await post(pkg)).status,403);assert.equal((await post({...signed,signature:'A'.repeat(86)})).status,403);assert.equal((await post(signed,'staging')).status,403);assert.equal(target.getPublished(),undefined);assert.equal((await post(signed)).status,201);assert.equal((await post(signed)).status,409);assert.equal(target.getPublicationProvenance(1).packageDigest,pkg.digest);}finally{await new Promise(r=>server.close(r));}
});


test('verified promotion retains signed evidence atomically across SQLite restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'app-mixer-signed-proof-')),path=join(dir,'target.sqlite'),source=new ApplicationStore(initial);source.publish(0);const pkg=packageFor(source),{privateKey,publicKey}=generateKeyPairSync('ed25519'),verify=createSignedPromotionVerifier([{sourceEnvironment:'development',keyId:'key-1',publicKey}],'production'),signed=signPromotionPackage(pkg,'production','key-1',privateKey);let target,db,server;
 try{target=new SqliteApplicationStore(path,initial);const token='strong-token-at-least-thirty-two-characters';server=createControlPlane(target,token,undefined,undefined,undefined,{verifyWithEvidence:verify.verifyWithEvidence});server.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${server.address().port}/promotion/import`,post=item=>fetch(url,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({package:item,targetEnvironment:'production',expectedVersion:0})});assert.equal((await post(pkg)).status,403);assert.equal((await post(signed)).status,201);const proof=target.getPublicationProvenance(1).signature;assert.equal(proof.keyId,'key-1');assert.equal(proof.signature,signed.signature);assert.match(proof.keyFingerprint,/^[a-f0-9]{64}$/);await new Promise(r=>server.close(r));server=null;target.close();target=new SqliteApplicationStore(path,initial);assert.deepEqual(target.getPublicationProvenance(1).signature,proof);db=new DatabaseSync(path);assert.throws(()=>db.exec('DELETE FROM application_promotion_signatures'),/immutable/);assert.throws(()=>db.exec("UPDATE application_promotion_signatures SET evidence='{}'"),/immutable/);db.exec("CREATE TRIGGER fail_signature BEFORE INSERT ON application_promotion_signatures BEGIN SELECT RAISE(ABORT,'test failure'); END;");const verified=verify.verifyWithEvidence(signed,'production','demo');assert.throws(()=>target.promoteVerified(verified.package,1,'production',verified.evidence),/test failure/);assert.equal(target.getPublished().version,1);assert.equal(target.getPublicationProvenance(2),undefined);const broken={...proof,signature:'A'.repeat(86)};assert.throws(()=>target.promoteVerified(pkg,1,'production',broken),/Invalid promotion evidence/);assert.equal(target.getPublished().version,1);db.exec('DROP TRIGGER promotion_signature_no_update');db.prepare('UPDATE application_promotion_signatures SET evidence=?').run(JSON.stringify(broken));assert.throws(()=>target.getPublicationProvenance(1),/Invalid publication provenance/);}finally{if(server)await new Promise(r=>server.close(r));db?.close();target?.close();rmSync(dir,{recursive:true,force:true});}
});

test('verified promotion retains evidence in memory and requires repository support',async()=>{
 const source=new ApplicationStore(initial),target=new ApplicationStore(initial);source.publish(0);const pkg=packageFor(source),{privateKey,publicKey}=generateKeyPairSync('ed25519'),verify=createSignedPromotionVerifier([{sourceEnvironment:'development',keyId:'key',publicKey}],'production'),signed=signPromotionPackage(pkg,'production','key',privateKey),verified=verify.verifyWithEvidence(signed,'production','demo');target.promoteVerified(verified.package,0,'production',verified.evidence);assert.equal(target.getPublicationProvenance(1).signature.keyId,'key');const copy=target.getPublicationProvenance(1);copy.signature.keyId='changed';assert.equal(target.getPublicationProvenance(1).signature.keyId,'key');assert.throws(()=>new ApplicationStore(initial).promoteVerified(pkg,0,'production'),/Invalid promotion evidence/);
 const unsupported=new ApplicationStore(initial);unsupported.promoteVerified=undefined;const token='strong-token-at-least-thirty-two-characters',server=createControlPlane(unsupported,token,undefined,undefined,undefined,{verifyWithEvidence:verify.verifyWithEvidence});server.listen(0,'127.0.0.1');await once(server,'listening');try{const response=await fetch(`http://127.0.0.1:${server.address().port}/promotion/import`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({package:signed,targetEnvironment:'production',expectedVersion:0})});assert.equal(response.status,501);assert.equal(unsupported.getPublished(),undefined);}finally{await new Promise(r=>server.close(r));}
});
