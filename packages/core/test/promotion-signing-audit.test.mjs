import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {ApplicationStore,SqlitePromotionSigningAudit,createAuditedPromotionSigner,createPromotionPackage,signPromotionPackage,createSignedPromotionVerifier} from '../dist/index.js';

const definition={id:'demo',schemaVersion:1,revision:0,pages:[]},actor={tenantId:'tenant',principalId:'release-bot'};
const importRecord=(provenance,applicationId='demo')=>({applicationId,sourceEnvironment:provenance.sourceEnvironment,sourceVersion:provenance.sourceVersion,packageDigest:provenance.packageDigest,targetEnvironment:provenance.targetEnvironment,evidence:provenance.signature});

test('audited signer chains every signature and reconciles target imports',()=>{
 const dir=mkdtempSync(join(tmpdir(),'app-mixer-signing-')),path=join(dir,'audit.sqlite');let now=1000;const audit=new SqlitePromotionSigningAudit(path,{clock:()=>now++});
 try{
  const {privateKey,publicKey}=generateKeyPairSync('ed25519'),signer=createAuditedPromotionSigner({audit,actor,keyId:'release',privateKey,signerPrincipal:'release-bot'}),verifier=createSignedPromotionVerifier([{keyId:'release',sourceEnvironment:'dev',publicKey,signerPrincipal:'release-bot'}],'prod',{requireSignerIdentity:true});
  const source=new ApplicationStore(definition);source.publish(0);const target=new ApplicationStore(definition);
  assert.deepEqual(audit.head(),{sequence:0,hash:'0'.repeat(64)});assert.equal(audit.verify().valid,true);
  const pkg=createPromotionPackage('dev',source.getPublished()),signed=signer(structuredClone(pkg),'prod',0),entry=audit.list()[0];
  assert.equal(entry.sequence,1);assert.equal(entry.previousHash,'0'.repeat(64));assert.equal(entry.signature,signed.signature);assert.equal(entry.signerPrincipal,'release-bot');assert.equal(entry.expectedVersion,0);assert.equal(entry.packageDigest,pkg.digest);assert.deepEqual([entry.tenantId,entry.principalId],['tenant','release-bot']);
  const verified=verifier.verifyWithEvidence(signed,'prod','demo',0);target.promoteVerified(verified.package,0,'prod',verified.evidence);
  const checkpoint=audit.head();assert.equal(checkpoint.sequence,1);
  // A second signature by the audited service, and one made with the same key outside it.
  source.apply(0,[{op:'addPage',page:{id:'home',title:'Home',route:'/',components:[]}}]);source.publish(1);const second=signer(createPromotionPackage('dev',source.getPublished()),'prod',1);
  const same=signPromotionPackage(createPromotionPackage('dev',source.getPublished()),'prod','release',privateKey,1,'release-bot');assert.equal(same.signature,second.signature);const rogue=signPromotionPackage(createPromotionPackage('dev',source.getPublished()),'prod','release',privateKey,2,'release-bot');
  const audited=target.getPublicationProvenance(1),forged={...importRecord(audited),evidence:{...audited.signature,signature:rogue.signature}};
  assert.deepEqual(audit.findUnaudited([importRecord(audited)]),[]);
  assert.deepEqual(audit.findUnaudited([importRecord(audited),forged,{...importRecord(audited),sourceVersion:2},{...importRecord(audited),targetEnvironment:'staging'}]),[{index:1,reason:'missing'},{index:2,reason:'mismatch'},{index:3,reason:'mismatch'}]);
  assert.deepEqual(audit.verify(checkpoint),{valid:true,head:audit.head()});assert.equal(audit.head().sequence,2);
  assert.throws(()=>signer(pkg,'prod'),/requires a target version/);assert.equal(audit.head().sequence,2);
  for(const bad of [{...actor,tenantId:'../x'},undefined])assert.throws(()=>audit.record(bad,signed),/Invalid promotion signing audit entry/);
  assert.throws(()=>audit.record(actor,{...signed,signature:'short'}),/Invalid/);
  assert.throws(()=>createAuditedPromotionSigner({audit:{},actor,keyId:'release',privateKey}),/Invalid audited promotion signer/);
  assert.throws(()=>audit.verify({sequence:1,hash:'nope'}),/Invalid promotion signing audit checkpoint/);
  assert.deepEqual(audit.verify({sequence:1,hash:'f'.repeat(64)}).error,'Checkpoint mismatch at 1');
  assert.equal(audit.verify({sequence:9,hash:'f'.repeat(64)}).error,'Checkpoint not found');
  const unsigned=createAuditedPromotionSigner({audit,actor,keyId:'release',privateKey});const v1=unsigned(pkg,'prod');assert.equal(audit.list({after:2})[0].expectedVersion,null);assert.equal(audit.list({after:2})[0].signerPrincipal,null);assert.equal(audit.list({after:2})[0].signature,v1.signature);
 }finally{audit.close();}
 // Triggers block ordinary updates and deletes; direct tampering below them is detected by verification.
 const raw=new DatabaseSync(path);
 try{
  assert.throws(()=>raw.exec("UPDATE promotion_signing_audit SET source_version=9 WHERE sequence=1"),/append-only/);assert.throws(()=>raw.exec('DELETE FROM promotion_signing_audit WHERE sequence=2'),/append-only/);
  raw.exec('DROP TRIGGER promotion_signing_audit_no_update');raw.exec("UPDATE promotion_signing_audit SET source_version=9 WHERE sequence=1");
 }finally{raw.close();}
 let reopened=new SqlitePromotionSigningAudit(path);assert.deepEqual(reopened.verify().error,'Altered entry 1');reopened.close();
 const raw2=new DatabaseSync(path);try{raw2.exec('DROP TRIGGER IF EXISTS promotion_signing_audit_no_update');raw2.exec('UPDATE promotion_signing_audit SET source_version=1 WHERE sequence=1');raw2.exec('DROP TRIGGER promotion_signing_audit_no_delete');raw2.exec('DELETE FROM promotion_signing_audit WHERE sequence=2');}finally{raw2.close();}
 reopened=new SqlitePromotionSigningAudit(path);try{assert.equal(reopened.verify().error,'Missing entry 2');}finally{reopened.close();rmSync(dir,{recursive:true,force:true});}
});
