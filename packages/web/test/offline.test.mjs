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

test('separate browser stores preserve a host-issued shared key and reject replacement',async()=>{
 const secret=await key(),first=await EncryptedBrowserQueue.open(options(new IDBFactory(),secret)),second=await EncryptedBrowserQueue.open(options(new IDBFactory(),secret));try{const a=await first.enqueue('save','logical',{value:1},{idempotencyKey:'shared-key'}),b=await second.enqueue('save','logical',{value:1},{idempotencyKey:'shared-key'});assert.equal(a.idempotencyKey,b.idempotencyKey);assert.equal((await first.enqueue('save','logical',{value:1})).idempotencyKey,'shared-key');await assert.rejects(first.enqueue('save','logical',{value:1},{idempotencyKey:'other'}),/conflict/);await assert.rejects(first.enqueue('save','other',{value:1},{idempotencyKey:''}),/Invalid/);}finally{first.close();second.close();}
});

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
 const rawdb=await request(factory.open('offline-test',3)),tx=rawdb.transaction('offline','readonly'),ended=done(tx),rows=await request(tx.objectStore('offline').getAll());await ended;
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
 const db=await request(factory.open('offline-test',3)),tx=db.transaction('offline','readwrite'),ended=done(tx),store=tx.objectStore('offline'),entry=await request(store.get(item.id));
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


test('queue key rotation preserves intents, links and idempotent conflict retries',async()=>{
 const factory=new IDBFactory(),oldKey=await key(),newKey=await key(),queue=await EncryptedBrowserQueue.open(options(factory,oldKey)),other=await EncryptedBrowserQueue.open(options(factory,oldKey,{...scope,principalId:'bob'}));
 try{const original=await queue.enqueue('save','first',{name:'old'}),running=await queue.transition(original.id,1,'claim'),conflict=await queue.transition(original.id,running.version,'conflict'),replacement=await queue.resolveConflict(original.id,conflict.version,'next',{name:'new'}),otherItem=await other.enqueue('save','other',{value:2}),before=await queue.list();assert.equal(await queue.rotateKey(newKey),2);await assert.rejects(EncryptedBrowserQueue.open(options(factory,oldKey)),/authenticate/);const reopened=await EncryptedBrowserQueue.open(options(factory,newKey));try{const after=await reopened.list();for(const item of before){const changed=after.find(x=>x.id===item.id);assert.deepEqual(changed,{...item,version:item.version+1});}assert.equal((await reopened.resolveConflict(original.id,conflict.version,'next',{name:'new'})).id,replacement.id);await assert.rejects(reopened.resolveConflict(original.id,conflict.version,'next',{name:'wrong'}),/conflict/);assert.equal((await other.get(otherItem.id)).payload.value,2);}finally{reopened.close();}}
 finally{queue.close();other.close();}
});

test('rotation rejects active operations and invalid keys',async()=>{
 const factory=new IDBFactory(),oldKey=await key(),newKey=await key(),queue=await EncryptedBrowserQueue.open(options(factory,oldKey));try{const item=await queue.enqueue('save','one',{}),running=await queue.transition(item.id,1,'claim');await assert.rejects(queue.rotateKey(newKey),/running operations/);assert.equal((await queue.get(item.id)).version,running.version);const extractable=await webcrypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);await assert.rejects(queue.rotateKey(extractable),/Invalid offline queue key/);await queue.transition(item.id,running.version,'uncertain');assert.equal(await queue.rotateKey(newKey),1);}finally{queue.close();}
});

test('rotation rejects concurrent queue changes without partial re-encryption',async()=>{
 for(const action of ['claim','enqueue']){const factory=new IDBFactory(),oldKey=await key(),newKey=await key();let armed=false,resume,started;const gate=new Promise(r=>resume=r),ready=new Promise(r=>started=r),slow={subtle:{digest:webcrypto.subtle.digest.bind(webcrypto.subtle),decrypt:webcrypto.subtle.decrypt.bind(webcrypto.subtle),encrypt:async(...args)=>{if(armed){started();await gate;}return webcrypto.subtle.encrypt(...args);}},getRandomValues:webcrypto.getRandomValues.bind(webcrypto),randomUUID:webcrypto.randomUUID.bind(webcrypto)};const rotating=await EncryptedBrowserQueue.open({...options(factory,oldKey),crypto:slow}),other=await EncryptedBrowserQueue.open(options(factory,oldKey));try{const first=await rotating.enqueue('save','one',{value:1});await rotating.enqueue('save','two',{value:2});armed=true;const pending=rotating.rotateKey(newKey);await ready;if(action==='claim')await other.transition(first.id,1,'claim');else await other.enqueue('save','three',{value:3});resume();await assert.rejects(pending,/changed during rotation/);const entries=await other.list();assert.equal(entries.length,action==='claim'?2:3);assert.equal(entries.find(item=>item.id===first.id).status,action==='claim'?'running':'pending');const wrong=await EncryptedBrowserQueue.open(options(factory,newKey));try{await assert.rejects(wrong.list(),/authenticate/);}finally{wrong.close();}}finally{rotating.close();other.close();}}
});

test('encryption failure during rotation leaves the original partition intact',async()=>{
 const factory=new IDBFactory(),oldKey=await key(),newKey=await key();let armed=false,count=0;const failing={subtle:{digest:webcrypto.subtle.digest.bind(webcrypto.subtle),decrypt:webcrypto.subtle.decrypt.bind(webcrypto.subtle),encrypt:async(...args)=>{if(armed&&++count===2)throw Error('encryption failed');return webcrypto.subtle.encrypt(...args);}},getRandomValues:webcrypto.getRandomValues.bind(webcrypto),randomUUID:webcrypto.randomUUID.bind(webcrypto)},queue=await EncryptedBrowserQueue.open({...options(factory,oldKey),crypto:failing});try{await queue.enqueue('save','one',{value:1});await queue.enqueue('save','two',{value:2});const before=await queue.list();armed=true;await assert.rejects(queue.rotateKey(newKey),/encryption failed/);assert.deepEqual(await queue.list(),before);}finally{queue.close();}
});


test('rotation fences stale tabs and authenticates the key even for an empty partition',async()=>{
 const factory=new IDBFactory(),oldKey=await key(),newKey=await key(),rotating=await EncryptedBrowserQueue.open(options(factory,oldKey)),stale=await EncryptedBrowserQueue.open(options(factory,oldKey));
 try{assert.equal(await rotating.rotateKey(newKey),0);await assert.rejects(stale.enqueue('save','stale',{}),/key changed/);await assert.rejects(stale.list(),/key changed/);await assert.rejects(EncryptedBrowserQueue.open(options(factory,oldKey)),/authenticate/);const fresh=await EncryptedBrowserQueue.open(options(factory,newKey));try{const item=await fresh.enqueue('save','fresh',{});assert.equal((await fresh.get(item.id)).requestKey,'fresh');assert.equal((await fresh.list()).length,1);}finally{fresh.close();}}finally{rotating.close();stale.close();}
});

test('an enqueue delayed before its transaction cannot write after rotation',async()=>{
 const factory=new IDBFactory(),oldKey=await key(),newKey=await key();let armed=false,resume,started;const gate=new Promise(r=>resume=r),ready=new Promise(r=>started=r),slow={subtle:{digest:webcrypto.subtle.digest.bind(webcrypto.subtle),decrypt:webcrypto.subtle.decrypt.bind(webcrypto.subtle),encrypt:async(...args)=>{if(armed){started();await gate;}return webcrypto.subtle.encrypt(...args);}},getRandomValues:webcrypto.getRandomValues.bind(webcrypto),randomUUID:webcrypto.randomUUID.bind(webcrypto)};const stale=await EncryptedBrowserQueue.open({...options(factory,oldKey),crypto:slow}),rotating=await EncryptedBrowserQueue.open(options(factory,oldKey));
 try{await rotating.enqueue('save','original',{});armed=true;const pending=stale.enqueue('save','late',{});await ready;assert.equal(await rotating.rotateKey(newKey),1);resume();await assert.rejects(pending,/key changed/);const fresh=await EncryptedBrowserQueue.open(options(factory,newKey));try{assert.deepEqual((await fresh.list()).map(x=>x.requestKey),['original']);}finally{fresh.close();}}finally{resume();stale.close();rotating.close();}
});

test('a read delayed during decryption is rejected after rotation',async()=>{
 const factory=new IDBFactory(),oldKey=await key(),newKey=await key();let armed=false,resume,started;const gate=new Promise(r=>resume=r),ready=new Promise(r=>started=r),slow={subtle:{digest:webcrypto.subtle.digest.bind(webcrypto.subtle),encrypt:webcrypto.subtle.encrypt.bind(webcrypto.subtle),decrypt:async(...args)=>{if(armed){started();await gate;}return webcrypto.subtle.decrypt(...args);}},getRandomValues:webcrypto.getRandomValues.bind(webcrypto),randomUUID:webcrypto.randomUUID.bind(webcrypto)};const stale=await EncryptedBrowserQueue.open({...options(factory,oldKey),crypto:slow}),rotating=await EncryptedBrowserQueue.open(options(factory,oldKey));
 try{await rotating.enqueue('save','original',{});armed=true;const pending=stale.list();await ready;await rotating.rotateKey(newKey);resume();await assert.rejects(pending,/key changed/);}finally{resume();stale.close();rotating.close();}
});

test('rollback anchor detects restored queue snapshots and tolerates concurrent tabs and anchor outages',async()=>{
 const factory=new IDBFactory(),queueKey=await key(),floor={value:0,fail:false,calls:0},anchor={read:async()=>floor.value,advance:async n=>{floor.calls++;if(floor.fail)throw Error('anchor offline');floor.value=Math.max(floor.value,n);}},open=(k=queueKey,a=anchor)=>EncryptedBrowserQueue.open({...options(factory,k),rollbackAnchor:a});
 const snapshot=async()=>{const db=await request(factory.open('offline-test'));try{const tx=db.transaction('offline','readonly'),all=request(tx.objectStore('offline').getAll());await done(tx);return await all;}finally{db.close();}};
 const restore=async records=>{const db=await request(factory.open('offline-test'));try{const tx=db.transaction('offline','readwrite'),store=tx.objectStore('offline');store.clear();for(const value of records)store.put(value);await done(tx);}finally{db.close();}};
 for(const bad of [{},{read:async()=>0},{read:1,advance:async()=>{}}])await assert.rejects(EncryptedBrowserQueue.open({...options(factory,queueKey),rollbackAnchor:bad}),/Invalid encrypted offline storage configuration/);
 let queue=await open(),tab=await open();
 const first=await queue.enqueue('save','one',{n:1});assert.equal(floor.value,1);assert.deepEqual(await queue.enqueue('save','one',{n:1}),first);assert.equal(floor.value,1);
 const old=await snapshot();
 const [claimed,second]=await Promise.all([queue.transition(first.id,1,'claim'),tab.enqueue('save','two',{n:2})]);assert.equal(claimed.status,'running');assert.equal(second.status,'pending');assert.equal(floor.value,3);
 await queue.transition(first.id,claimed.version,'succeed');assert.equal(floor.value,4);queue.close();tab.close();
 const current=await snapshot();await restore(old);await assert.rejects(open(),/rollback detected/);
 await restore(current.filter(value=>!String(value.id).startsWith('@queue-counter:')));await assert.rejects(open(),/rollback detected/);
 const counter=current.find(value=>String(value.id).startsWith('@queue-counter:'));await restore(current.map(value=>value===counter?{...value,counter:9}:value));await assert.rejects(open(),/Invalid offline queue counter/);
 await restore(current);queue=await open();assert.equal((await queue.get(first.id)).status,'succeeded');
 floor.fail=true;const third=await queue.enqueue('save','three',{n:3});assert.equal(third.status,'pending');assert.equal(queue.hasPendingRollbackAnchor(),true);assert.equal(floor.value,4);await assert.rejects(queue.syncRollbackAnchor(),/anchor offline/);
 floor.fail=false;assert.equal(await queue.syncRollbackAnchor(),5);assert.equal(queue.hasPendingRollbackAnchor(),false);assert.equal(floor.value,5);
 const nextKey=await key();await queue.rotateKey(nextKey);assert.equal(floor.value,6);await assert.rejects(open(queueKey),/Cannot authenticate/);queue=await open(nextKey);assert.equal((await queue.list()).length,3);queue.close();
 floor.value=50;await assert.rejects(open(nextKey),/rollback detected/);
 const plain=await EncryptedBrowserQueue.open(options(factory,nextKey));const before=(await snapshot()).find(value=>String(value.id).startsWith('@queue-counter:')).counter;await plain.enqueue('save','four',{n:4});assert.equal((await snapshot()).find(value=>String(value.id).startsWith('@queue-counter:')).counter,before);plain.close();
 await assert.rejects(EncryptedBrowserQueue.open({...options(factory,nextKey),rollbackAnchor:{read:async()=>-1,advance:async()=>{}}}),/Invalid offline rollback anchor/);
 await assert.rejects(EncryptedBrowserQueue.open({...options(factory,nextKey),rollbackAnchor:{read:async()=>{throw Error('down');},advance:async()=>{}}}),/down/);
});

test('rollback counter serializes contending tabs without losing writes',async()=>{
 const factory=new IDBFactory(),queueKey=await key();let floor=0;const anchor={read:async()=>floor,advance:async n=>{floor=Math.max(floor,n);}},tabs=await Promise.all(Array.from({length:4},()=>EncryptedBrowserQueue.open({...options(factory,queueKey),rollbackAnchor:anchor})));
 try{const results=await Promise.all(Array.from({length:24},(_,i)=>tabs[i%4].enqueue('save','request-'+i,{i})));assert.equal(new Set(results.map(item=>item.id)).size,24);assert.equal(floor,24);assert.equal((await tabs[0].list()).length,24);}finally{for(const tab of tabs)tab.close();}
});

test('rollback anchor detects selective substitution and deletion of item envelopes',async()=>{
 const factory=new IDBFactory(),queueKey=await key(),floor={value:0},anchor={read:async()=>floor.value,advance:async n=>{floor.value=Math.max(floor.value,n);}},open=(k=queueKey)=>EncryptedBrowserQueue.open({...options(factory,k),rollbackAnchor:anchor});
 const snapshot=async()=>{const db=await request(factory.open('offline-test'));try{const tx=db.transaction('offline','readonly'),all=request(tx.objectStore('offline').getAll());await done(tx);return await all;}finally{db.close();}};
 const write=async(put,remove=[])=>{const db=await request(factory.open('offline-test'));try{const tx=db.transaction('offline','readwrite'),store=tx.objectStore('offline');for(const value of put)store.put(value);for(const id of remove)store.delete(id);await done(tx);}finally{db.close();}};
 let queue=await open();const first=await queue.enqueue('save','one',{n:1}),second=await queue.enqueue('save','two',{n:2});
 const oldFirst=(await snapshot()).find(value=>value.id===first.id);
 await queue.transition(first.id,1,'claim');await queue.transition(first.id,2,'succeed');queue.close();
 const current=await snapshot(),currentFirst=current.find(value=>value.id===first.id);
 // An older envelope for one item, kept beside the current counter record, decrypts and authenticates on its own; the state digest exposes it.
 await write([oldFirst]);await assert.rejects(open(),/tampering detected/);
 await write([currentFirst],[second.id]);await assert.rejects(open(),/tampering detected/);
 await write(current);queue=await open();assert.equal((await queue.list()).length,2);
 // Substitution while a queue is open is caught by the next list or write.
 await write([oldFirst]);await assert.rejects(queue.list(),/tampering detected/);await assert.rejects(queue.enqueue('save','three',{n:3}),/tampering detected/);await assert.rejects(queue.transition(second.id,1,'claim'),/tampering detected/);
 await write([currentFirst]);assert.equal((await queue.enqueue('save','three',{n:3})).status,'pending');
 // Rotation reseals the digest with the new key, and the protection still holds afterwards.
 const nextKey=await key();assert.equal(await queue.rotateKey(nextKey),3);queue=await open(nextKey);const rotated=await snapshot();assert.equal((await queue.list()).length,3);queue.close();
 const rotatedSecond=rotated.find(value=>value.id===second.id);await write([{...rotatedSecond,iv:new Uint8Array(12)}]);await assert.rejects(open(nextKey),/tampering detected/);await write([rotatedSecond]);(await open(nextKey)).close();
});

test('a legacy counter without a state digest is accepted and upgraded by the next write',async()=>{
 const factory=new IDBFactory(),queueKey=await key(),floor={value:0},anchor={read:async()=>floor.value,advance:async n=>{floor.value=Math.max(floor.value,n);}},open=()=>EncryptedBrowserQueue.open({...options(factory,queueKey),rollbackAnchor:anchor});
 const snapshot=async()=>{const db=await request(factory.open('offline-test'));try{const tx=db.transaction('offline','readonly'),all=request(tx.objectStore('offline').getAll());await done(tx);return await all;}finally{db.close();}};
 const write=async put=>{const db=await request(factory.open('offline-test'));try{const tx=db.transaction('offline','readwrite'),store=tx.objectStore('offline');for(const value of put)store.put(value);await done(tx);}finally{db.close();}};
 let queue=await open();const item=await queue.enqueue('save','one',{n:1});const oldItem=(await snapshot()).find(value=>value.id===item.id);await queue.transition(item.id,1,'claim');queue.close();
 const counter=(await snapshot()).find(value=>String(value.id).startsWith('@queue-counter:')),partition=counter.partition.slice('@meta:'.length),iv=webcrypto.getRandomValues(new Uint8Array(12));
 assert.match(counter.state,/^[a-f0-9]{64}$/);
 const legacy={id:counter.id,partition:counter.partition,counter:counter.counter,iv,ciphertext:await webcrypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(JSON.stringify(['queue-counter-v1',partition,counter.counter]))},queueKey,new TextEncoder().encode('queue-counter-v1'))};
 // A counter written before state digests existed carries no digest, so a substitution made before the upgrade is not detected.
 await write([legacy,oldItem]);queue=await open();assert.equal((await queue.get(item.id)).status,'pending');
 await queue.transition(item.id,1,'claim');const upgraded=(await snapshot()).find(value=>String(value.id).startsWith('@queue-counter:'));assert.match(upgraded.state,/^[a-f0-9]{64}$/);assert.equal(upgraded.counter,counter.counter+1);queue.close();
 await write([oldItem]);await assert.rejects(open(),/tampering detected/);
 // The digest is authenticated: changing it on the counter record fails authentication.
 await write([{...upgraded,state:'0'.repeat(64)}]);await assert.rejects(open(),/Invalid offline queue counter/);
});

test('an instance without the anchor makes anchored instances report tampering',async()=>{
 const factory=new IDBFactory(),queueKey=await key(),floor={value:0},anchor={read:async()=>floor.value,advance:async n=>{floor.value=Math.max(floor.value,n);}};
 const anchored=await EncryptedBrowserQueue.open({...options(factory,queueKey),rollbackAnchor:anchor}),plain=await EncryptedBrowserQueue.open(options(factory,queueKey));
 try{await anchored.enqueue('save','one',{n:1});await plain.enqueue('save','two',{n:2});await assert.rejects(anchored.list(),/tampering detected/);}finally{anchored.close();plain.close();}
});

test('purge frees a full queue of settled items, keeps live work and stays consistent with the rollback anchor',{timeout:120000},async()=>{
 const factory=new IDBFactory(),secret=await key();let floor=0;const anchor={read:async()=>floor,advance:async value=>{floor=Math.max(floor,value);}};
 const open=()=>EncryptedBrowserQueue.open({...options(factory,secret),rollbackAnchor:anchor});
 let queue=await open();
 try{
  const items=[];for(let n=0;n<1000;n++)items.push(await queue.enqueue('orders.create','request-'+n,{n}));
  await assert.rejects(queue.enqueue('orders.create','one-too-many',{}),/Offline queue (full|too large)/);
  // Settle three: two succeed, one is discarded while still pending.
  for(const item of items.slice(0,2)){const claimed=await queue.transition(item.id,1,'claim');await queue.transition(item.id,claimed.version,'succeed');}
  await queue.transition(items[2].id,1,'discard');
  for(const bad of [{statuses:[],limit:1},{statuses:['pending'],limit:1},{statuses:['succeeded','succeeded'],limit:1},{statuses:['succeeded'],limit:0},{statuses:['succeeded'],limit:1001},{statuses:'succeeded',limit:1},null])await assert.rejects(queue.purge(bad),/Invalid offline retention query/);
  const rawStore=async mode=>{const db=await new Promise((resolve,reject)=>{const open=factory.open('offline-test');open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(open.error);});const tx=db.transaction('offline',mode);return {store:tx.objectStore('offline'),tx,db};};
  const saved=await (async()=>{const {store,tx,db}=await rawStore('readonly');const value=await request(store.get(items[0].id));await done(tx);db.close();return value;})();
  assert.equal(await queue.purge({statuses:['succeeded','discarded'],limit:2}),2,'the limit bounds one pass');
  const room=await queue.enqueue('orders.create','after-purge',{});assert.equal(room.status,'pending','a purged queue accepts work again');
  assert.equal(await queue.purge({statuses:['succeeded','discarded','exhausted'],limit:1000}),1,'the remaining settled item');assert.equal(await queue.purge({statuses:['succeeded'],limit:1000}),0);
  assert.equal((await queue.list()).length,998,'997 live items and the new one remain: live work was never removed');
  assert.ok(floor>1000,'every write, purge included, advanced the host floor');
  // The counter and state digest describe the purged queue, so a reopen succeeds.
  queue.close();queue=await open();assert.equal((await queue.list()).length,998);
  // Putting a purged envelope back (an attacker restoring old state) no longer matches the authenticated state digest.
  {const {store,tx,db}=await rawStore('readwrite');store.put(saved);await done(tx);db.close();}
  await assert.rejects(queue.list(),/tampering|counter|rollback/i);
 }finally{queue.close();}
});
