// Data written by retained builds of older offline clients migrates to the current client, and those builds are then
// fenced out. The builds in legacy-clients/ are the compiled offline sources at the commits in their directory names:
// the first and last clients that opened IndexedDB version 1, and the last that opened version 2.
import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto,createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {IDBFactory} from 'fake-indexeddb';
import {EncryptedBrowserQueue} from '../dist/offline.js';
import {EncryptedPublicationCache} from '../dist/offline-publications.js';

const key=()=>webcrypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scope={tenantId:'tenant',applicationId:'app',principalId:'person'},publicationScope={...scope,authorizationKey:'v1',schemaVersion:1};
const byRequest=items=>[...items].sort((a,b)=>a.requestKey.localeCompare(b.requestKey));
const builds=[['v1-first-10deb32a',1],['v1-last-1acdff71',1],['v2-last-d968546e',2]];

for(const [build,version] of builds){
 test(`queue and publication data written by the retained ${build} client migrate to the current client`,{timeout:20000},async()=>{
  const dir=new URL(`./legacy-clients/${build}/`,import.meta.url),legacy=await import(new URL('offline.js',dir)),legacyPublications=existsSync(new URL('offline-publications.js',dir))?await import(new URL('offline-publications.js',dir)):null;
  const factory=new IDBFactory(),queueKey=await key(),publicationKey=await key(),rotatedKey=await key();
  const queueOptions={enabled:true,databaseName:'app-queue',scope,key:queueKey,indexedDB:factory,crypto:webcrypto};
  const publicationOptions={enabled:true,databaseName:'app-publications',scope:publicationScope,key:publicationKey,maxAgeMs:1000,authorize:()=>true,compatible:()=>true,indexedDB:factory,crypto:webcrypto,clock:()=>100};

  // The legacy client queues work in each state a user could leave behind, and caches a publication.
  const old=await legacy.EncryptedBrowserQueue.open(queueOptions);
  await old.enqueue('save','request-pending',{value:'pending'});
  let uncertain=await old.enqueue('save','request-uncertain',{value:'uncertain'});uncertain=await old.transition(uncertain.id,uncertain.version,'claim');uncertain=await old.transition(uncertain.id,uncertain.version,'uncertain');
  let conflict=await old.enqueue('save','request-conflict',{value:'conflict'});conflict=await old.transition(conflict.id,conflict.version,'claim');conflict=await old.transition(conflict.id,conflict.version,'conflict');
  const written=byRequest(await old.list());
  assert.deepEqual(written.map(item=>[item.requestKey,item.status]),[['request-conflict','conflict'],['request-pending','pending'],['request-uncertain','uncertain']]);
  let oldCache,cached;if(legacyPublications){oldCache=await legacyPublications.EncryptedPublicationCache.open(publicationOptions);const publication={version:4,definition:{id:'app',schemaVersion:1,title:'cached'}};await oldCache.store(publication,'"'+hash(publication)+'"');cached=await oldCache.read();assert.deepEqual(cached.publication,publication);}

  // The legacy tab is still open when the current client starts: it is asked to close and the upgrade proceeds.
  const current=await EncryptedBrowserQueue.open(queueOptions);
  try{
   await assert.rejects(old.list(),'the legacy connection was closed by the upgrade');
   assert.deepEqual(byRequest(await current.list()),written,'every queued item survives with its state, version and keys');
   // The current client resumes each item from where the legacy client left it.
   const pending=written.find(item=>item.status==='pending');let next=await current.transition(pending.id,pending.version,'claim');next=await current.transition(next.id,next.version,'succeed');assert.equal(next.status,'succeeded');
   const stuck=written.find(item=>item.status==='uncertain');assert.equal((await current.transition(stuck.id,stuck.version,'reconcileApplied')).status,'succeeded');
   const conflicted=written.find(item=>item.status==='conflict');const replacement=await current.resolveConflict(conflicted.id,conflicted.version,'request-conflict-2',{value:'resolved'});assert.equal(replacement.payload.value,'resolved');
   assert.equal((await current.enqueue('save','request-pending',{value:'pending'})).id,pending.id,'a repeated request still deduplicates against legacy data');
   // The migrated partition rotates to a new key like any other.
   assert.equal(await current.rotateKey(rotatedKey),4);
  }finally{current.close();}
  const reopened=await EncryptedBrowserQueue.open({...queueOptions,key:rotatedKey});try{assert.equal((await reopened.get(written[0].id)).status,'discarded');}finally{reopened.close();}
  await assert.rejects(legacy.EncryptedBrowserQueue.open(queueOptions),'the legacy client cannot reopen the upgraded database');
  await new Promise((resolve,reject)=>{const request=factory.open('app-queue');request.onsuccess=()=>{assert.equal(request.result.version,3);request.result.close();resolve();};request.onerror=()=>reject(request.error);});

  if(legacyPublications){
   const cache=await EncryptedPublicationCache.open(publicationOptions);
   try{await assert.rejects(oldCache.read(),'the legacy cache connection was closed');assert.deepEqual(await cache.read(),cached);}finally{cache.close();}
   await assert.rejects(legacyPublications.EncryptedPublicationCache.open(publicationOptions),'the legacy cache cannot reopen');
  }
  assert.ok(version===1||version===2);
 });
}
