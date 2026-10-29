import {test} from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {IDBFactory} from 'fake-indexeddb';
import {EncryptedBrowserQueue} from '../dist/offline.js';
const scope={tenantId:'tenant',applicationId:'app',principalId:'alice'};
const key=()=>webcrypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
const options=(indexedDB,key,scopeValue=scope)=>({enabled:true,databaseName:'offline-test',scope:scopeValue,key,indexedDB,crypto:webcrypto});
const request=req=>new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
const done=tx=>new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});

test('requires explicit opt-in and a non-extractable encryption key',async()=>{
 const db=new IDBFactory(),good=await key(),extractable=await webcrypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);
 for(const value of [{...options(db,good),enabled:false},{...options(db,extractable)},{...options(db,good),scope:{...scope,principalId:''}}])await assert.rejects(EncryptedBrowserQueue.open(value),/configuration/);
});

test('persists encrypted intents and deduplicates within the identity partition',async()=>{
 const factory=new IDBFactory(),secret=await key(),queue=await EncryptedBrowserQueue.open(options(factory,secret));
 const item=await queue.enqueue('orders.create','request-1',{customer:'sensitive',nested:{b:2,a:1}});
 assert.equal((await queue.enqueue('orders.create','request-1',{nested:{a:1,b:2},customer:'sensitive'})).id,item.id);
 await assert.rejects(queue.enqueue('orders.create','request-1',{customer:'different'}),/conflict/);
 const other=await EncryptedBrowserQueue.open(options(factory,secret,{...scope,principalId:'bob'}));
 assert.notEqual((await other.enqueue('orders.create','request-1',{customer:'other'})).id,item.id);assert.equal(await other.get(item.id),undefined);
 const rawdb=await request(factory.open('offline-test',1)),tx=rawdb.transaction('offline','readonly'),ended=done(tx),rows=await request(tx.objectStore('offline').getAll());await ended;
 assert.equal(rows.length,2);assert.doesNotMatch(JSON.stringify(rows),/sensitive|orders.create|request-1|alice/);rawdb.close();
 queue.close();const reopened=await EncryptedBrowserQueue.open(options(factory,secret));assert.equal((await reopened.get(item.id)).payload.customer,'sensitive');
 const wrong=await EncryptedBrowserQueue.open(options(factory,await key()));await assert.rejects(wrong.get(item.id),/authenticate/);
 reopened.close();other.close();wrong.close();
});

test('two tabs cannot claim the same intent and ambiguous results require reconciliation',async()=>{
 const factory=new IDBFactory(),secret=await key(),a=await EncryptedBrowserQueue.open(options(factory,secret)),b=await EncryptedBrowserQueue.open(options(factory,secret));
 try{
  const item=await a.enqueue('save','key',{value:1});
  const claims=await Promise.allSettled([a.transition(item.id,1,'claim'),b.transition(item.id,1,'claim')]);
  assert.equal(claims.filter(x=>x.status==='fulfilled').length,1);assert.equal(claims.filter(x=>x.status==='rejected').length,1);
  const running=await a.get(item.id);assert.equal(running.status,'running');assert.equal(running.attempts,1);
  const uncertain=await a.transition(item.id,running.version,'uncertain');
  await assert.rejects(a.transition(item.id,uncertain.version,'claim'),/transition/);
  const reconciled=await b.transition(item.id,uncertain.version,'reconcileNotApplied');assert.equal(reconciled.status,'pending');
  const replay=await a.transition(item.id,reconciled.version,'claim');assert.equal(replay.idempotencyKey,item.idempotencyKey);assert.equal(replay.attempts,2);
  assert.equal((await b.transition(item.id,replay.version,'succeed')).status,'succeeded');
 }finally{a.close();b.close();}
});

test('ciphertext and authenticated metadata tampering are rejected',async()=>{
 const factory=new IDBFactory(),secret=await key(),queue=await EncryptedBrowserQueue.open(options(factory,secret)),item=await queue.enqueue('save','key',{value:'secret'});
 const db=await request(factory.open('offline-test',1)),tx=db.transaction('offline','readwrite'),ended=done(tx),store=tx.objectStore('offline'),entry=await request(store.get(item.id));
 new Uint8Array(entry.ciphertext)[0]^=1;store.put(entry);await ended;
 try{await assert.rejects(queue.get(item.id),/authenticate/);await assert.rejects(queue.list(),/authenticate/);}
 finally{db.close();queue.close();}
});

test('browser queue snapshots its scope before asynchronous initialization',async()=>{
 const factory=new IDBFactory(),secret=await key(),mutable={...scope};
 const opening=EncryptedBrowserQueue.open({enabled:true,databaseName:'scope-snapshot',scope:mutable,key:secret,indexedDB:factory,crypto:webcrypto});
 mutable.principalId='other';const queue=await opening;
 try{assert.deepEqual(queue.getScope(),scope);const exposed=queue.getScope();exposed.tenantId='changed';assert.deepEqual(queue.getScope(),scope);}
 finally{queue.close();}
});

test('conflict replacement atomically links a new intent and is safe to retry',async()=>{
 const factory=new IDBFactory(),secret=await key(),a=await EncryptedBrowserQueue.open(options(factory,secret)),b=await EncryptedBrowserQueue.open(options(factory,secret));
 try{
  const original=await a.enqueue('save','first',{name:'stale'}),running=await a.transition(original.id,1,'claim'),conflict=await a.transition(original.id,running.version,'conflict');
  await assert.rejects(a.resolveConflict(original.id,conflict.version,'first',{name:'new'}),/Invalid/);
  const resolved=await a.resolveConflict(original.id,conflict.version,'replacement',{name:'merged'});
  assert.notEqual(resolved.id,original.id);assert.notEqual(resolved.idempotencyKey,original.idempotencyKey);assert.equal(resolved.status,'pending');
  const archived=await b.get(original.id);assert.equal(archived.status,'discarded');assert.equal(archived.replacementId,resolved.id);
  assert.equal((await b.resolveConflict(original.id,conflict.version,'replacement',{name:'merged'})).id,resolved.id);
  await assert.rejects(b.resolveConflict(original.id,conflict.version,'replacement',{name:'different'}),/conflict/);
  await assert.rejects(b.resolveConflict(original.id,conflict.version,'different',{name:'merged'}),/version conflict/);
  assert.equal((await a.list()).length,2);
 }finally{a.close();b.close();}
});

test('competing conflict resolutions create only one replacement',async()=>{
 const factory=new IDBFactory(),secret=await key(),a=await EncryptedBrowserQueue.open(options(factory,secret)),b=await EncryptedBrowserQueue.open(options(factory,secret));
 try{
  const item=await a.enqueue('save','first',{}),running=await a.transition(item.id,1,'claim'),conflict=await a.transition(item.id,running.version,'conflict');
  const results=await Promise.allSettled([a.resolveConflict(item.id,conflict.version,'one',{a:1}),b.resolveConflict(item.id,conflict.version,'two',{a:2})]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(results.filter(result=>result.status==='rejected').length,1);
  const entries=await a.list();assert.equal(entries.length,2);assert.equal(entries.filter(entry=>entry.status==='pending').length,1);assert.equal(entries.find(entry=>entry.id===item.id).status,'discarded');
 }finally{a.close();b.close();}
});
