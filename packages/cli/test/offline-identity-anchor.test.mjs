import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {webcrypto} from 'node:crypto';
import {IDBFactory} from 'fake-indexeddb';
import {createProject} from '../dist/index.js';

const scope={tenantId:'tenant',applicationId:'demo-app',principalId:'local'};
async function runtime(){const dir=await mkdtemp(join(tmpdir(),'identity-anchor-')),target=await createProject('demo-app',dir);return {dir,module:await import(pathToFileURL(join(target,'offline-runtime.mjs')).href)};}
// A host floor kept outside the browser profile; it only ever moves forward.
function anchor(){const state={floor:0,fail:false,advance:async counter=>{if(state.fail)throw Error('anchor offline');state.floor=Math.max(state.floor,counter);},read:async()=>state.floor};return state;}
// Raw access to the IndexedDB store, standing in for a restored or edited browser profile.
const raw=(indexedDB,name,store,body)=>new Promise((resolve,reject)=>{const request=indexedDB.open(name);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,tx=db.transaction(store,'readwrite'),objects=tx.objectStore(store);let result;body(objects,value=>{result=value;});tx.oncomplete=()=>{db.close();resolve(result);};tx.onerror=tx.onabort=()=>{db.close();reject(tx.error);};};});
const dump=(indexedDB,name,store)=>raw(indexedDB,name,store,(objects,done)=>{const all=objects.getAll();all.onsuccess=()=>done(all.result);});
const load=(indexedDB,name,store,rows)=>raw(indexedDB,name,store,objects=>{objects.clear();for(const row of rows)objects.put(row);});
const put=(indexedDB,name,store,row)=>raw(indexedDB,name,store,objects=>{objects.put(row);});

test('anchored request identities detect a restored profile, substitution and a deleted counter',async()=>{
 const s=await runtime(),{createPersistentOfflineRequestKeys}=s.module;let store;try{
  const indexedDB=new IDBFactory(),host=anchor(),options={databaseName:'ids',scope,indexedDB,crypto:webcrypto,rollbackAnchor:host},open=()=>createPersistentOfflineRequestKeys(options);
  store=await open();const first=await store.getOrCreate('order','items.update',{value:1});assert.equal(await store.getOrCreate('order','items.update',{value:1}),first,'a repeat does not write');assert.equal(host.floor,1);
  const backup=await dump(indexedDB,'ids','request-identities');assert.equal(JSON.stringify(backup).includes('items.update'),false);
  await store.reset('order');const second=await store.getOrCreate('order','items.update',{value:1});assert.notEqual(second,first);assert.equal(host.floor,3);store.close();store=undefined;
  // The old profile would hand the new intent the first request key, which the server has already applied.
  await load(indexedDB,'ids','request-identities',backup);await assert.rejects(open(),/Offline request identity rollback detected/);
  // Substituting one old row into the current state, keeping the current counter, is caught by the digest.
  const fresh=new IDBFactory(),freshHost=anchor(),freshOptions={...options,indexedDB:fresh,rollbackAnchor:freshHost};store=await createPersistentOfflineRequestKeys(freshOptions);
  const key=await store.getOrCreate('order','items.update',{value:1});await store.getOrCreate('other','items.update',{value:2});const old=(await dump(fresh,'ids','request-identities')).find(row=>row.key===key);
  await store.reset('order');await store.getOrCreate('order','items.update',{value:1});await put(fresh,'ids','request-identities',old);
  await assert.rejects(store.getOrCreate('order','items.update',{value:1}),/tampering detected/,'an open store checks the digest before using a row');
  await assert.rejects(store.reset('other'),/tampering detected/);store.close();store=undefined;
  // Deleting the counter record does not reset the fence.
  await raw(fresh,'ids','request-identities',objects=>{objects.delete('rollback-anchor');});await assert.rejects(createPersistentOfflineRequestKeys(freshOptions),/rollback detected/);
 }finally{store?.close();await rm(s.dir,{recursive:true,force:true});}
});

test('the identity anchor fails closed, adopts unanchored data once and retries a failed advance',async()=>{
 const s=await runtime(),{createPersistentOfflineRequestKeys}=s.module;let store,other;try{
  const indexedDB=new IDBFactory(),base={databaseName:'ids',scope,indexedDB,crypto:webcrypto};
await assert.rejects(createPersistentOfflineRequestKeys({...base,rollbackAnchor:{read:()=>0}}),/Invalid request identity rollback anchor/);
  await assert.rejects(createPersistentOfflineRequestKeys({...base,rollbackAnchor:{read:async()=>{throw Error('down');},advance:async()=>{}}}),/rollback detected/);
  for(const value of [-1,1.5,'2',null])await assert.rejects(createPersistentOfflineRequestKeys({...base,rollbackAnchor:{read:async()=>value,advance:async()=>{}}}),/rollback detected/,String(value));
  // Rows written before the anchor existed are adopted at floor zero, never once the host has a floor.
  store=await createPersistentOfflineRequestKeys(base);const legacy=await store.getOrCreate('order','items.update',{value:1});store.close();
  const late=anchor();late.floor=4;await assert.rejects(createPersistentOfflineRequestKeys({...base,rollbackAnchor:late}),/rollback detected/);
  const host=anchor();store=await createPersistentOfflineRequestKeys({...base,rollbackAnchor:host});assert.equal(await store.getOrCreate('order','items.update',{value:1}),legacy);
  // A failed advance keeps the committed write and is retried.
  host.fail=true;const next=await store.getOrCreate('order','items.update',{value:2});assert.notEqual(next,legacy);assert.equal(store.hasPendingRollbackAnchor(),true);await assert.rejects(store.syncRollbackAnchor(),/anchor unavailable/);
  host.fail=false;await store.syncRollbackAnchor();assert.equal(store.hasPendingRollbackAnchor(),false);assert.equal(host.floor,1);
  // Tabs sharing the anchor serialize their counters; an unanchored writer is reported as tampering.
  other=await createPersistentOfflineRequestKeys({...base,rollbackAnchor:host});
  const keys=await Promise.all(Array.from({length:12},(_,i)=>(i%2?store:other).getOrCreate('slot-'+(i%4),'items.update',{value:i%4})));assert.equal(new Set(keys).size,4);
  const counter=(await dump(indexedDB,'ids','request-identities')).find(row=>row.id==='rollback-anchor').counter;assert.equal(counter,5);assert.equal(host.floor,5);
  const unanchored=await createPersistentOfflineRequestKeys(base);await unanchored.reset('slot-0');unanchored.close();await assert.rejects(store.getOrCreate('slot-1','items.update',{value:1}),/tampering detected/);
 }finally{store?.close();other?.close();await rm(s.dir,{recursive:true,force:true});}
});

test('anchored shared identity stores detect a restored generation database',async()=>{
 const s=await runtime(),{createSharedOfflineIdentityStore}=s.module;let store;try{
  const slots=new Map(),requests=new Map();
  const invoke=async(_operation,input)=>{let current=slots.get(input.slot);if(input.action==='open'){if(!current){current=webcrypto.randomUUID();slots.set(input.slot,current);}return {requestKey:current};}if(input.expectedRequestKey!==current)throw Error('Shared offline slot conflict');if(input.action==='reset'){const next=webcrypto.randomUUID();slots.set(input.slot,next);return {requestKey:next};}if(input.action==='allocate'){const value=requests.get(current)??{idempotencyKey:webcrypto.randomUUID()};requests.set(current,value);return {requestKey:current,idempotencyKey:value.idempotencyKey};}throw Error('Invalid');};
  const indexedDB=new IDBFactory(),host=anchor(),config={databaseName:'generations',scope,operations:[{id:'items.update',slotCapability:'slot.capability'}],invoke,resolveActor:()=>scope,indexedDB,crypto:webcrypto,rollbackAnchor:host};
  store=await createSharedOfflineIdentityStore(config);const first=await store.getOrCreate('form','items.update',{value:'one'});const backup=await dump(indexedDB,'generations','shared-slots');
  await store.reset('form','items.update');const second=await store.getOrCreate('form','items.update',{value:'one'});assert.notEqual(second.requestKey,first.requestKey);assert.equal(host.floor,2);store.close();store=undefined;
  // Without the anchor the restored device would quietly lose its fence; with it, opening fails.
  await load(indexedDB,'generations','shared-slots',backup);await assert.rejects(createSharedOfflineIdentityStore(config),/Offline shared identity rollback detected/);
  const {rollbackAnchor,...unanchored}=config;void rollbackAnchor;store=await createSharedOfflineIdentityStore(unanchored);assert.equal(typeof store.hasPendingRollbackAnchor,'function');assert.equal(store.hasPendingRollbackAnchor(),false);
 }finally{store?.close();await rm(s.dir,{recursive:true,force:true});}
});
