import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto,createHash} from 'node:crypto';
import {IDBFactory} from 'fake-indexeddb';
import {EncryptedBrowserQueue} from '../dist/offline.js';
import {EncryptedPublicationCache} from '../dist/offline-publications.js';
const enc=new TextEncoder(),hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key=()=>webcrypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
const queueScope={tenantId:'tenant',applicationId:'app',principalId:'person'};
const publicationScope={...queueScope,authorizationKey:'v1',schemaVersion:1};
const open=(factory,name,version,upgrade)=>new Promise((resolve,reject)=>{const r=factory.open(name,version);r.onupgradeneeded=()=>upgrade?.(r.result);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
const put=(db,store,value)=>new Promise((resolve,reject)=>{const tx=db.transaction(store,'readwrite');tx.objectStore(store).put(value);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
const cases=[
 {name:'queue',store:'offline',create:db=>{const s=db.createObjectStore('offline',{keyPath:'id'});s.createIndex('partition','partition');},open:(db,k)=>EncryptedBrowserQueue.open({enabled:true,databaseName:'legacy',scope:queueScope,key:k,indexedDB:db,crypto:webcrypto}),make:async k=>{const partition=hash([queueScope.tenantId,queueScope.applicationId,queueScope.principalId]),id=hash([partition,'legacy']);const item={id,version:1,operationId:'save',requestKey:'legacy',idempotencyKey:'legacy-token',payload:{value:'preserved'},status:'pending',attempts:0},iv=webcrypto.getRandomValues(new Uint8Array(12)),ciphertext=await webcrypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:enc.encode(JSON.stringify([partition,id,1]))},k,enc.encode(JSON.stringify(item)));return {row:{id,partition,version:1,iv,ciphertext},check:async cache=>assert.deepEqual(await cache.get(id),item)};}},
 {name:'publication',store:'publications',create:db=>db.createObjectStore('publications',{keyPath:'id'}),open:(db,k)=>EncryptedPublicationCache.open({enabled:true,databaseName:'legacy',scope:publicationScope,key:k,maxAgeMs:1000,authorize:()=>true,compatible:()=>true,indexedDB:db,crypto:webcrypto,clock:()=>100}),make:async k=>{const id=hash([publicationScope.tenantId,publicationScope.principalId,publicationScope.authorizationKey,publicationScope.applicationId,publicationScope.schemaVersion]),publication={version:1,definition:{id:'app',schemaVersion:1,title:'preserved'}},etag='"'+hash(publication)+'"',entry={publication,etag,savedAt:100},iv=webcrypto.getRandomValues(new Uint8Array(12)),ciphertext=await webcrypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:enc.encode(JSON.stringify([id,1]))},k,enc.encode(JSON.stringify(entry)));return {row:{id,revision:1,iv,ciphertext},check:async cache=>assert.deepEqual(await cache.read(),entry)};}}
];
for(const spec of cases){
 test(`${spec.name} upgrades legacy data and fences version-one clients`,async()=>{const factory=new IDBFactory(),k=await key(),legacy=await open(factory,'legacy',1,spec.create),{row,check}=await spec.make(k);await put(legacy,spec.store,row);let versionChanged=false;legacy.onversionchange=()=>{versionChanged=true;legacy.close();};const cache=await spec.open(factory,k);try{assert.equal(versionChanged,true);await check(cache);await assert.rejects(open(factory,'legacy',1),{name:'VersionError'});}finally{cache.close();}});
 test(`${spec.name} aborts a blocked upgrade after reporting failure`,async()=>{const factory=new IDBFactory(),k=await key(),legacy=await open(factory,'legacy',1,spec.create);try{await assert.rejects(spec.open(factory,k),/blocked/);}finally{legacy.close();}const stillLegacy=await open(factory,'legacy',1);assert.equal(stillLegacy.version,1);stillLegacy.close();const cache=await spec.open(factory,k);cache.close();});
}
