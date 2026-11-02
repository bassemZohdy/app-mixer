import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {CapabilityRegistry,SqliteStagedOperations} from '../dist/index.js';
const scope={tenantId:'tenant',applicationId:'app'},ctx={tenantId:'tenant',principalId:'user',origin:'ui'};

test('reconciliation evidence commits with the decision and remains scoped across restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'staged-evidence-')),path=join(dir,'data.sqlite');let store=new SqliteStagedOperations(path);const registry=new CapabilityRegistry(()=>{});registry.register({operationId:'pay',method:'POST',path:'/pay'},{authorize:()=>true,validate:()=>true,execute:()=>{throw Error('lost')}});
 try{
  const op=store.stage(scope,'pay',{secret:'private'});await assert.rejects(store.submit(scope,op.id,registry,ctx),/lost/);
  assert.throws(()=>store.reconcileWithEvidence(scope,op.id,'not_applied',{principalId:'',reference:'ref'}),/Invalid/);assert.equal(store.get(scope,op.id).status,'uncertain');
  store.reconcileWithEvidence(scope,op.id,'not_applied',{principalId:'operator',reference:'case-1'});await assert.rejects(store.submit(scope,op.id,registry,ctx),/lost/);
  const evidence={principalId:'reviewer',reference:'case-2'};assert.equal(await store.verifyAndReconcile(scope,op.id,async()=>{evidence.principalId='other';return 'applied'},evidence),'applied');
  const first=store.listReconciliationEvidence(scope,op.id,{limit:1}),next=store.listReconciliationEvidence(scope,op.id,{after:first[0].revision});assert.equal(first[0].principalId,'operator');assert.equal(first[0].outcome,'not_applied');assert.equal(next[0].principalId,'reviewer');assert.equal(next[0].outcome,'applied');assert.equal(JSON.stringify([...first,...next]).includes('private'),false);assert.deepEqual(store.listReconciliationEvidence({...scope,tenantId:'other'},op.id),[]);
  store.close();store=new SqliteStagedOperations(path);assert.deepEqual(store.listReconciliationEvidence(scope,op.id),[...first,...next]);assert.equal(store.get(scope,op.id).status,'succeeded');
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('evidence write failure rolls back reconciliation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'staged-evidence-fail-')),path=join(dir,'data.sqlite'),store=new SqliteStagedOperations(path),db=new DatabaseSync(path),registry=new CapabilityRegistry(()=>{});registry.register({operationId:'pay',method:'POST',path:'/pay'},{authorize:()=>true,validate:()=>true,execute:()=>{throw Error('lost')}});
 try{const op=store.stage(scope,'pay',{});await assert.rejects(store.submit(scope,op.id,registry,ctx),/lost/);db.exec("CREATE TRIGGER fail_evidence BEFORE INSERT ON staged_reconciliation_evidence BEGIN SELECT RAISE(ABORT,'evidence unavailable'); END;");assert.throws(()=>store.reconcileWithEvidence(scope,op.id,'applied',{principalId:'operator',reference:'case'}),/evidence unavailable/);assert.equal(store.get(scope,op.id).status,'uncertain');await assert.rejects(store.verifyAndReconcile(scope,op.id,()=> 'applied',{principalId:'operator',reference:'case'}),/evidence unavailable/);assert.equal(store.get(scope,op.id).status,'uncertain');assert.deepEqual(store.listReconciliationEvidence(scope,op.id),[]);
 }finally{db.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('submission keeps its original scope when caller mutates it in flight',async()=>{
 const store=new SqliteStagedOperations(':memory:'),mutable={...scope},op=store.stage(mutable,'pay',{}),registry=new CapabilityRegistry(()=>{});let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);registry.register({operationId:'pay',method:'POST',path:'/pay'},{authorize:()=>true,validate:()=>true,execute:async()=>{entered();await gate;return 'done'}});
 try{const pending=store.submit(mutable,op.id,registry,ctx);await started;mutable.tenantId='other';release();assert.equal(await pending,'done');assert.equal(store.get(scope,op.id).status,'succeeded');}finally{store.close();}
});

test('reopening a legacy evidence table protects existing records against update, delete and replacement',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'staged-evidence-upgrade-')),path=join(dir,'data.sqlite');let store=new SqliteStagedOperations(path),db;const registry=new CapabilityRegistry(()=>{});registry.register({operationId:'pay',method:'POST',path:'/pay'},{authorize:()=>true,validate:()=>true,execute:()=>{throw Error('lost')}});
 try{const op=store.stage(scope,'pay',{});await assert.rejects(store.submit(scope,op.id,registry,ctx),/lost/);store.reconcileWithEvidence(scope,op.id,'applied',{principalId:'operator',reference:'case'});const original=store.listReconciliationEvidence(scope,op.id);store.close();
  db=new DatabaseSync(path);db.exec('DROP TRIGGER staged_evidence_no_update; DROP TRIGGER staged_evidence_no_delete; DROP TRIGGER staged_evidence_no_replace');db.close();db=undefined;store=new SqliteStagedOperations(path);db=new DatabaseSync(path);
  assert.throws(()=>db.exec("UPDATE staged_reconciliation_evidence SET reference='forged'"),/immutable/);assert.throws(()=>db.exec('DELETE FROM staged_reconciliation_evidence'),/immutable/);assert.throws(()=>db.exec("INSERT OR REPLACE INTO staged_reconciliation_evidence SELECT tenant_id,application_id,operation_id,revision,'forged',reference,outcome,recorded_at FROM staged_reconciliation_evidence"),/immutable/);assert.deepEqual(store.listReconciliationEvidence(scope,op.id),original);
 }finally{db?.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
