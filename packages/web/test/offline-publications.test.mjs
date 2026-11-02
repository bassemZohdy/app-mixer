import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto,createHash} from 'node:crypto';
import {IDBFactory} from 'fake-indexeddb';
import {EncryptedPublicationCache} from '../dist/offline-publications.js';
const scope={tenantId:'tenant',principalId:'user',authorizationKey:'permissions-v1',applicationId:'app',schemaVersion:1};
const publication=(version,title='private title')=>({version,definition:{id:'app',schemaVersion:1,title}});
const tag=p=>'"'+createHash('sha256').update(JSON.stringify(p)).digest('hex')+'"';
const key=()=>webcrypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
const options=(db,k,extra={})=>({enabled:true,databaseName:'test',scope,key:k,maxAgeMs:1000,authorize:()=>true,compatible:()=>true,indexedDB:db,crypto:webcrypto,...extra});

test('encrypted publications require authorization, compatible content, matching ETags and bounded age',async()=>{
 const db=new IDBFactory(),k=await key();let now=100,allowed=true;
 const opts=options(db,k,{clock:()=>now,authorize:()=>allowed});const cache=await EncryptedPublicationCache.open(opts);
 const p=publication(1);await cache.store(p,tag(p));p.definition.title='mutated';assert.equal((await cache.read()).publication.definition.title,'private title');
 const rawdb=await new Promise((resolve,reject)=>{const r=db.open('test');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 const rows=await new Promise((resolve,reject)=>{const r=rawdb.transaction('publications').objectStore('publications').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});assert.equal(JSON.stringify(rows).includes('private title'),false);rawdb.close();
 allowed=false;await assert.rejects(cache.read(),/access denied/);allowed=true;
 const other=await EncryptedPublicationCache.open(options(db,await key()));await assert.rejects(other.read(),/authenticate/);other.close();
 const otherScope=await EncryptedPublicationCache.open(options(db,k,{scope:{...scope,principalId:'another'}}));assert.equal(await otherScope.read(),undefined);otherScope.close();
 await assert.rejects(cache.store(publication(2),'"'+'0'.repeat(64)+'"'),/ETag mismatch/);
 await assert.rejects(cache.store(publication(1,'changed'),tag(publication(1,'changed'))),/version conflict/);
 now=1101;assert.equal(await cache.read(),undefined);const p2=publication(2);await cache.store(p2,tag(p2));assert.equal((await cache.read()).publication.version,2);
 await assert.rejects(cache.store(publication(1),tag(publication(1))),/version conflict/);await cache.clear();assert.equal(await cache.read(),undefined);cache.close();
});

test('new compatible versions can replace an older incompatible cached version',async()=>{
 const db=new IDBFactory(),k=await key(),a=await EncryptedPublicationCache.open(options(db,k));const p1=publication(1);await a.store(p1,tag(p1));a.close();
 const b=await EncryptedPublicationCache.open(options(db,k,{compatible:d=>d.title==='new'}));await assert.rejects(b.read(),/authenticate/);const p2=publication(2,'new');await b.store(p2,tag(p2));assert.equal((await b.read()).publication.version,2);b.close();
});

test('a clear in another instance prevents an in-flight store from restoring data',async()=>{
 const db=new IDBFactory(),k=await key();let resume,started;const gate=new Promise(r=>resume=r),ready=new Promise(r=>started=r);
 const slow={subtle:{digest:webcrypto.subtle.digest.bind(webcrypto.subtle),decrypt:webcrypto.subtle.decrypt.bind(webcrypto.subtle),encrypt:async(...args)=>{started();await gate;return webcrypto.subtle.encrypt(...args);}},getRandomValues:webcrypto.getRandomValues.bind(webcrypto)};
 const a=await EncryptedPublicationCache.open(options(db,k,{crypto:slow})),b=await EncryptedPublicationCache.open(options(db,k));const p=publication(1);const pending=a.store(p,tag(p));await ready;await b.clear();resume();await assert.rejects(pending,/cache changed/);assert.equal(await b.read(),undefined);a.close();b.close();
});

test('a clear during a read authorization check prevents a stale result',async()=>{
 const db=new IDBFactory(),k=await key();let calls=0,resume,started;const gate=new Promise(r=>resume=r),ready=new Promise(r=>started=r);
 const a=await EncryptedPublicationCache.open(options(db,k,{authorize:async(_s,action)=>{if(action==='read'&&++calls===2){started();await gate;}return true;}})),b=await EncryptedPublicationCache.open(options(db,k));const p=publication(1);await a.store(p,tag(p));const pending=a.read();await ready;await b.clear();resume();await assert.rejects(pending,/cache changed/);a.close();b.close();
});


test('publication key rotation preserves the entry and closes the old handle',async()=>{
 const db=new IDBFactory(),oldKey=await key(),newKey=await key();let now=100;const old=await EncryptedPublicationCache.open(options(db,oldKey,{clock:()=>now})),p=publication(2);await old.store(p,tag(p));now=500;assert.equal(await old.rotateKey(newKey),true);await assert.rejects(old.read(),/cache changed/);
 await assert.rejects(EncryptedPublicationCache.open(options(db,oldKey,{clock:()=>now})),/authenticate/);
 const fresh=await EncryptedPublicationCache.open(options(db,newKey,{clock:()=>now})),entry=await fresh.read();assert.deepEqual(entry.publication,p);assert.equal(entry.savedAt,100);assert.equal(entry.etag,tag(p));now=1101;assert.equal(await fresh.read(),undefined);fresh.close();
});

test('rotation fails closed on policy and bad keys',async()=>{
 const db=new IDBFactory(),oldKey=await key(),newKey=await key();let allowed=true;const cache=await EncryptedPublicationCache.open(options(db,oldKey,{authorize:()=>allowed}));const p=publication(1);await cache.store(p,tag(p));allowed=false;await assert.rejects(cache.rotateKey(newKey),/access denied/);allowed=true;const extractable=await webcrypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);await assert.rejects(cache.rotateKey(extractable),/Invalid offline publication key/);assert.deepEqual((await cache.read()).publication,p);await cache.clear();cache.close();
});

test('concurrent publication writes or clears prevent stale key rotation',async()=>{
 for(const action of ['store','clear']){const db=new IDBFactory(),oldKey=await key(),newKey=await key();let armed=false,resume,started;const gate=new Promise(r=>resume=r),ready=new Promise(r=>started=r),slow={subtle:{digest:webcrypto.subtle.digest.bind(webcrypto.subtle),decrypt:webcrypto.subtle.decrypt.bind(webcrypto.subtle),encrypt:async(...args)=>{if(armed){started();await gate;}return webcrypto.subtle.encrypt(...args);}},getRandomValues:webcrypto.getRandomValues.bind(webcrypto)};const rotating=await EncryptedPublicationCache.open(options(db,oldKey,{crypto:slow})),other=await EncryptedPublicationCache.open(options(db,oldKey)),p=publication(1);await rotating.store(p,tag(p));armed=true;const pending=rotating.rotateKey(newKey);await ready;if(action==='store'){const p2=publication(2,'new');await other.store(p2,tag(p2));}else await other.clear();resume();await assert.rejects(pending,/cache changed/);const current=await other.read();if(action==='store')assert.equal(current.publication.version,2);else assert.equal(current,undefined);rotating.close();other.close();}
});


test('permission revocation during rotation leaves the old key and data intact',async()=>{
 const db=new IDBFactory(),oldKey=await key(),newKey=await key();let reads=0,deny=false,armed=false;const cache=await EncryptedPublicationCache.open(options(db,oldKey,{authorize:(_scope,action)=>{if(armed&&action==='read'&&++reads===2)deny=true;return !deny;}})),p=publication(1);await cache.store(p,tag(p));armed=true;await assert.rejects(cache.rotateKey(newKey),/access denied/);armed=false;deny=false;assert.deepEqual((await cache.read()).publication,p);const wrong=await EncryptedPublicationCache.open(options(db,newKey));await assert.rejects(wrong.read(),/authenticate/);wrong.close();cache.close();
});


test('key rotation fences stale tabs after empty and cleared scopes',async()=>{
 for(const cleared of [false,true]){const db=new IDBFactory(),oldKey=await key(),newKey=await key(),rotating=await EncryptedPublicationCache.open(options(db,oldKey)),stale=await EncryptedPublicationCache.open(options(db,oldKey)),p=publication(1);try{if(cleared){await rotating.store(p,tag(p));await rotating.clear();}assert.equal(await rotating.rotateKey(newKey),false);await assert.rejects(stale.clear(),/cache changed/);await assert.rejects(stale.store(p,tag(p)),/cache changed/);await assert.rejects(stale.read(),/cache changed/);await assert.rejects(EncryptedPublicationCache.open(options(db,oldKey)),/authenticate/);const fresh=await EncryptedPublicationCache.open(options(db,newKey));try{assert.equal(await fresh.read(),undefined);await fresh.store(p,tag(p));assert.deepEqual((await fresh.read()).publication,p);await fresh.clear();await fresh.store(p,tag(p));assert.deepEqual((await fresh.read()).publication,p);}finally{fresh.close();}}finally{rotating.close();stale.close();}}
});

test('a stale tab cannot clear an entry after rotation',async()=>{
 const db=new IDBFactory(),oldKey=await key(),newKey=await key(),rotating=await EncryptedPublicationCache.open(options(db,oldKey)),stale=await EncryptedPublicationCache.open(options(db,oldKey)),p=publication(1);try{await rotating.store(p,tag(p));assert.equal(await rotating.rotateKey(newKey),true);await assert.rejects(stale.clear(),/cache changed/);const fresh=await EncryptedPublicationCache.open(options(db,newKey));try{assert.deepEqual((await fresh.read()).publication,p);}finally{fresh.close();}}finally{rotating.close();stale.close();}
});

test('a store delayed before commit cannot restore an old key after rotation',async()=>{
 const db=new IDBFactory(),oldKey=await key(),newKey=await key();let armed=false,resume,started;const gate=new Promise(r=>resume=r),ready=new Promise(r=>started=r),slow={subtle:{digest:webcrypto.subtle.digest.bind(webcrypto.subtle),decrypt:webcrypto.subtle.decrypt.bind(webcrypto.subtle),encrypt:async(...args)=>{if(armed){started();await gate;}return webcrypto.subtle.encrypt(...args);}},getRandomValues:webcrypto.getRandomValues.bind(webcrypto)};const stale=await EncryptedPublicationCache.open(options(db,oldKey,{crypto:slow})),rotating=await EncryptedPublicationCache.open(options(db,oldKey)),p=publication(1);try{armed=true;const pending=stale.store(p,tag(p));await ready;assert.equal(await rotating.rotateKey(newKey),false);resume();await assert.rejects(pending,/cache changed/);const fresh=await EncryptedPublicationCache.open(options(db,newKey));try{assert.equal(await fresh.read(),undefined);}finally{fresh.close();}}finally{resume();stale.close();rotating.close();}
});

test('a read delayed during decryption cannot return a pre-rotation publication',async()=>{
 const db=new IDBFactory(),oldKey=await key(),newKey=await key();let armed=false,resume,started;const gate=new Promise(r=>resume=r),ready=new Promise(r=>started=r),slow={subtle:{digest:webcrypto.subtle.digest.bind(webcrypto.subtle),encrypt:webcrypto.subtle.encrypt.bind(webcrypto.subtle),decrypt:async(...args)=>{if(armed){started();await gate;}return webcrypto.subtle.decrypt(...args);}},getRandomValues:webcrypto.getRandomValues.bind(webcrypto)};const stale=await EncryptedPublicationCache.open(options(db,oldKey,{crypto:slow})),rotating=await EncryptedPublicationCache.open(options(db,oldKey)),p=publication(1);try{await rotating.store(p,tag(p));armed=true;const pending=stale.read();await ready;assert.equal(await rotating.rotateKey(newKey),true);resume();await assert.rejects(pending,/cache changed/);}finally{resume();stale.close();rotating.close();}
});


test('successive rotations preserve scope isolation and reject a tampered key marker',async()=>{
 const db=new IDBFactory(),first=await key(),second=await key(),third=await key(),a=await EncryptedPublicationCache.open(options(db,first)),other=await EncryptedPublicationCache.open(options(db,first,{scope:{...scope,principalId:'other'}})),p=publication(1);try{await a.store(p,tag(p));await other.store(p,tag(p));assert.equal(await a.rotateKey(second),true);const b=await EncryptedPublicationCache.open(options(db,second));assert.equal(await b.rotateKey(third),true);await assert.rejects(EncryptedPublicationCache.open(options(db,second)),/authenticate/);const c=await EncryptedPublicationCache.open(options(db,third));try{assert.deepEqual((await c.read()).publication,p);assert.deepEqual((await other.read()).publication,p);const rawdb=await new Promise((resolve,reject)=>{const r=db.open('test');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});const tx=rawdb.transaction('publications','readwrite'),store=tx.objectStore('publications');const rows=await new Promise((resolve,reject)=>{const r=store.getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});const marker=rows.find(x=>x.id.startsWith('@publication-key:'));new Uint8Array(marker.ciphertext)[0]^=1;store.put(marker);await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});rawdb.close();await assert.rejects(c.read(),/cache changed/);await assert.rejects(EncryptedPublicationCache.open(options(db,third)),/authenticate/);assert.deepEqual((await other.read()).publication,p);}finally{c.close();}}finally{a.close();other.close();}
});

test('revoked access can clear a cached publication but clearing resets its local version floor',async()=>{
 const db=new IDBFactory(),k=await key();let allowed=true;const cache=await EncryptedPublicationCache.open(options(db,k,{authorize:()=>allowed})),newer=publication(3),older=publication(1);try{await cache.store(newer,tag(newer));allowed=false;await assert.rejects(cache.read(),/access denied/);await assert.rejects(cache.store(older,tag(older)),/access denied/);await cache.clear();allowed=true;assert.equal(await cache.read(),undefined);await cache.store(older,tag(older));assert.deepEqual((await cache.read()).publication,older);
 }finally{cache.close();}
});
async function publicationRows(factory){const database=await new Promise((resolve,reject)=>{const r=factory.open('test');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});try{return await new Promise((resolve,reject)=>{const r=database.transaction('publications').objectStore('publications').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}finally{database.close();}}
async function replacePublicationRows(factory,rows){const database=await new Promise((resolve,reject)=>{const r=factory.open('test');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});try{await new Promise((resolve,reject)=>{const tx=database.transaction('publications','readwrite'),store=tx.objectStore('publications');store.clear();for(const row of rows)store.put(row);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});}finally{database.close();}}

test('publication rollback anchor detects restoration after a clear and preserves scope isolation',async()=>{
 const db=new IDBFactory(),k=await key();let floor=0;const anchor={async read(){return floor;},async advance(value){floor=Math.max(floor,value);}},cache=await EncryptedPublicationCache.open(options(db,k,{rollbackAnchor:anchor})),other=await EncryptedPublicationCache.open(options(db,k,{scope:{...scope,principalId:'other'}}));try{const p=publication(2);await cache.store(p,tag(p));await other.store(p,tag(p));assert.equal(floor,1);const old=await publicationRows(db);await cache.clear();assert.equal(floor,2);assert.equal(await cache.read(),undefined);cache.close();await replacePublicationRows(db,old);await assert.rejects(EncryptedPublicationCache.open(options(db,k,{rollbackAnchor:anchor})),/rollback detected/);assert.deepEqual((await other.read()).publication,p);
 }finally{cache.close();other.close();}
});

test('publication rollback anchor survives key rotation and fences restored older snapshots',async()=>{
 const db=new IDBFactory(),oldKey=await key(),newKey=await key();let floor=0;const anchor={async read(){return floor;},async advance(value){floor=Math.max(floor,value);}},old=await EncryptedPublicationCache.open(options(db,oldKey,{rollbackAnchor:anchor})),p=publication(1);try{await old.store(p,tag(p));const snapshot=await publicationRows(db);assert.equal(await old.rotateKey(newKey),true);assert.equal(floor,2);const current=await EncryptedPublicationCache.open(options(db,newKey,{rollbackAnchor:anchor}));assert.deepEqual((await current.read()).publication,p);current.close();await replacePublicationRows(db,snapshot);await assert.rejects(EncryptedPublicationCache.open(options(db,oldKey,{rollbackAnchor:anchor})),/rollback detected/);
 }finally{old.close();}
});

test('publication rollback anchors detect tampering, missing counters, and invalid external floors',async()=>{
 const db=new IDBFactory(),k=await key();let floor=0;const anchor={async read(){return floor;},async advance(value){floor=Math.max(floor,value);}},cache=await EncryptedPublicationCache.open(options(db,k,{rollbackAnchor:anchor}));try{const p=publication(1);await cache.store(p,tag(p));const saved=await publicationRows(db);cache.close();const counter=saved.find(row=>row.id.startsWith('@publication-counter:'));assert.ok(counter);const corrupt=structuredClone(saved),target=corrupt.find(row=>row.id===counter.id);new Uint8Array(target.ciphertext)[0]^=1;await replacePublicationRows(db,corrupt);await assert.rejects(EncryptedPublicationCache.open(options(db,k,{rollbackAnchor:anchor})),/Invalid offline publication counter/);await replacePublicationRows(db,saved.filter(row=>row.id!==counter.id));await assert.rejects(EncryptedPublicationCache.open(options(db,k,{rollbackAnchor:anchor})),/rollback detected/);await replacePublicationRows(db,saved);floor=-1;await assert.rejects(EncryptedPublicationCache.open(options(db,k,{rollbackAnchor:anchor})),/Invalid offline publication rollback anchor/);await assert.rejects(EncryptedPublicationCache.open(options(db,k,{rollbackAnchor:{read:()=>0}})),/configuration/);
 }finally{cache.close();}
});

test('publication rollback anchor exposes failed advances and can synchronize later',async()=>{
 const db=new IDBFactory(),k=await key();let floor=0,failed=false;const anchor={async read(){return floor;},async advance(value){if(failed)throw Error('offline');floor=Math.max(floor,value);}},cache=await EncryptedPublicationCache.open(options(db,k,{rollbackAnchor:anchor}));try{failed=true;const p=publication(1);await cache.store(p,tag(p));assert.equal(cache.hasPendingRollbackAnchor(),true);assert.equal(floor,0);await assert.rejects(cache.syncRollbackAnchor(),/offline/);failed=false;assert.equal(await cache.syncRollbackAnchor(),1);assert.equal(cache.hasPendingRollbackAnchor(),false);assert.equal(floor,1);cache.close();const reopened=await EncryptedPublicationCache.open(options(db,k,{rollbackAnchor:anchor}));try{assert.deepEqual((await reopened.read()).publication,p);}finally{reopened.close();}
 }finally{cache.close();}
});

test('anchored concurrent writes cannot advance the counter without the corresponding publication',async()=>{
 const db=new IDBFactory(),k=await key();let floor=0,entered,release,armed=false;const anchor={async read(){return floor;},async advance(value){floor=Math.max(floor,value);}},gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>entered=resolve),slow={subtle:{digest:webcrypto.subtle.digest.bind(webcrypto.subtle),decrypt:webcrypto.subtle.decrypt.bind(webcrypto.subtle),encrypt:async(...args)=>{if(armed&&new TextDecoder().decode(args[2])==='publication-counter-v1'){entered();await gate;}return webcrypto.subtle.encrypt(...args);}},getRandomValues:webcrypto.getRandomValues.bind(webcrypto)},first=await EncryptedPublicationCache.open(options(db,k,{rollbackAnchor:anchor,crypto:slow})),second=await EncryptedPublicationCache.open(options(db,k,{rollbackAnchor:anchor}));try{armed=true;const older=publication(1),newer=publication(2),pending=first.store(older,tag(older));await ready;await second.store(newer,tag(newer));release();await assert.rejects(pending,/cache changed/);assert.equal(floor,1);assert.deepEqual((await second.read()).publication,newer);
 }finally{release?.();first.close();second.close();}
});

test('a failed anchor advance during key rotation is reconciled when the new key reopens',async()=>{
 const db=new IDBFactory(),oldKey=await key(),newKey=await key();let floor=0,failed=false;const anchor={async read(){return floor;},async advance(value){if(failed)throw Error('anchor offline');floor=Math.max(floor,value);}},cache=await EncryptedPublicationCache.open(options(db,oldKey,{rollbackAnchor:anchor})),p=publication(1);try{await cache.store(p,tag(p));failed=true;assert.equal(await cache.rotateKey(newKey),true);assert.equal(cache.hasPendingRollbackAnchor(),true);assert.equal(floor,1);await assert.rejects(EncryptedPublicationCache.open(options(db,newKey,{rollbackAnchor:anchor})),/anchor offline/);failed=false;const reopened=await EncryptedPublicationCache.open(options(db,newKey,{rollbackAnchor:anchor}));try{assert.equal(floor,2);assert.deepEqual((await reopened.read()).publication,p);}finally{reopened.close();}
 }finally{cache.close();}
});

test('publication rollback anchor callbacks are snapshotted and bound to their host',async()=>{
 const db=new IDBFactory(),k=await key(),anchor={floor:0,async read(){return this.floor;},async advance(value){this.floor=Math.max(this.floor,value);}},cache=await EncryptedPublicationCache.open(options(db,k,{rollbackAnchor:anchor}));try{anchor.advance=async()=>{throw Error('replaced');};const p=publication(1);await cache.store(p,tag(p));assert.equal(anchor.floor,1);assert.equal(cache.hasPendingRollbackAnchor(),false);
 }finally{cache.close();}
});

test('explicit publication anchor synchronization detects a newer external floor',async()=>{
 const db=new IDBFactory(),k=await key();let floor=0;const anchor={async read(){return floor;},async advance(value){floor=Math.max(floor,value);}},cache=await EncryptedPublicationCache.open(options(db,k,{rollbackAnchor:anchor}));try{const p=publication(1);await cache.store(p,tag(p));floor=2;await assert.rejects(cache.syncRollbackAnchor(),/rollback detected/);assert.equal(floor,2);floor=-1;await assert.rejects(cache.syncRollbackAnchor(),/Invalid offline publication rollback anchor/);
 }finally{cache.close();}
});
