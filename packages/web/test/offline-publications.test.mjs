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
