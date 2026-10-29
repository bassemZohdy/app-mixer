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
