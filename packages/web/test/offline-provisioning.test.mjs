// A device that has never been online starts from a provisioning grant carried to it out of band: it verifies the
// grant and the signed release locally, seeds its encrypted publication cache and queue, works across a restart
// without any network access, and later delivers its queued work once the server accepts the same grant.
import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto,generateKeyPairSync,createHash,sign} from 'node:crypto';
import {IDBFactory} from 'fake-indexeddb';
import {signPublicationRelease,signOfflineProvisioning,verifyOfflineProvisioning} from '@app-mixer/core';
import {openOfflineProvisioning} from '../dist/offline-provisioning.js';
import {EncryptedPublicationCache} from '../dist/offline-publications.js';
import {EncryptedBrowserQueue} from '../dist/offline.js';

const DAY=86400000,issuedAt=Date.UTC(2026,10,1),device='tablet-7';
const pair=()=>{const keys=generateKeyPairSync('ed25519');return {...keys,raw:keys.publicKey.export({format:'jwk'}).x};};
const provisioning=pair(),release=pair(),stranger=pair();
const definition={id:'demo',schemaVersion:1,revision:0,pages:[]};
const signedRelease=(keys=release,keyId='release-1',app=definition)=>signPublicationRelease({version:3,definition:app},'production',keyId,keys.privateKey);
const grant=(extra={})=>({deviceId:device,tenantId:'tenant',applicationId:'demo',principalId:'field-worker',environment:'production',issuedAt,notAfter:issuedAt+14*DAY,release:signedRelease(),...extra});
const serverKeys={keys:[{keyId:'prov-1',publicKey:provisioning.publicKey}],releaseKeys:[{keyId:'release-1',publicKey:release.publicKey}]};
const deviceKeys={keys:[{keyId:'prov-1',publicKey:provisioning.raw}],releaseKeys:[{keyId:'release-1',publicKey:release.raw}]};
const bundle=(extra={},options={})=>signOfflineProvisioning(grant(extra),{keyId:'prov-1',privateKey:provisioning.privateKey,releaseKeys:[...serverKeys.releaseKeys,{keyId:'release-2',publicKey:stranger.publicKey}],...options});
// Signs any grant, skipping the server's checks, to show the device checks the release itself.
const forged=(content,keys=provisioning)=>({formatVersion:1,keyId:'prov-1',grant:content,signature:sign(null,Buffer.from(JSON.stringify(['app-mixer-offline-provisioning-v1','prov-1',content])),keys.privateKey).toString('base64url')});
const open=(input,extra={})=>openOfflineProvisioning(input,{environment:'production',applicationId:'demo',deviceId:device,...deviceKeys,now:issuedAt+DAY,crypto:webcrypto,...extra});

test('a never-online device verifies its provisioning offline, works across a restart and delivers its work later',async()=>{
 // The grant travels as text (a QR code, file or installer payload).
 const carried=JSON.stringify(bundle());
 const realFetch=globalThis.fetch;let network=0;globalThis.fetch=()=>{network++;throw Error('offline');};
 const db=new IDBFactory(),queueKey=await webcrypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']),cacheKey=await webcrypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
 let opened;
 try{
  opened=await open(JSON.parse(carried));
  assert.deepEqual([opened.tenantId,opened.principalId,opened.publication.version,opened.publication.definition.id],['tenant','field-worker',3,'demo']);
  const cacheOptions={enabled:true,databaseName:'publication',scope:{tenantId:opened.tenantId,principalId:opened.principalId,authorizationKey:'provisioned',applicationId:opened.applicationId,schemaVersion:1},key:cacheKey,maxAgeMs:opened.notAfter-opened.issuedAt,authorize:()=>true,compatible:()=>true,indexedDB:db,crypto:webcrypto,clock:()=>issuedAt+DAY};
  const etag='"'+createHash('sha256').update(JSON.stringify(opened.publication)).digest('hex')+'"';
  let cache=await EncryptedPublicationCache.open(cacheOptions);await cache.store(opened.publication,etag);cache.close();
  const queueOptions={enabled:true,databaseName:'queue',scope:{tenantId:opened.tenantId,applicationId:opened.applicationId,principalId:opened.principalId},key:queueKey,indexedDB:db,crypto:webcrypto};
  let queue=await EncryptedBrowserQueue.open(queueOptions);
  for(const n of [1,2,3])await queue.enqueue('inspection.save','inspection-'+n,{site:'site-'+n,passed:n!==2});
  assert.equal((await queue.enqueue('inspection.save','inspection-1',{site:'site-1',passed:true})).requestKey,'inspection-1','a repeated request deduplicates offline');
  queue.close();
  // The device restarts, still offline: the publication and the queued work are still there.
  cache=await EncryptedPublicationCache.open({...cacheOptions,clock:()=>issuedAt+2*DAY});const cached=await cache.read();assert.deepEqual(cached.publication??cached,opened.publication);cache.close();
  queue=await EncryptedBrowserQueue.open(queueOptions);assert.deepEqual((await queue.list()).map(item=>[item.requestKey,item.status]).sort(),[['inspection-1','pending'],['inspection-2','pending'],['inspection-3','pending']]);
  assert.equal(network,0,'nothing used the network while offline');
  globalThis.fetch=realFetch;
  // Back online: the server accepts the same grant for this device and executes each queued operation once.
  const accepted=verifyOfflineProvisioning(JSON.parse(carried),{environment:'production',applicationId:'demo',deviceId:device,...serverKeys,now:issuedAt+3*DAY});
  assert.equal(accepted.principalId,'field-worker');
  const effects=new Map();
  for(const item of await queue.list()){const claimed=await queue.transition(item.id,item.version,'claim');if(!effects.has(claimed.idempotencyKey))effects.set(claimed.idempotencyKey,{principal:accepted.principalId,...claimed.payload});await queue.transition(claimed.id,claimed.version,'succeed');}
  assert.equal(effects.size,3);assert.deepEqual([...effects.values()].map(effect=>effect.site).sort(),['site-1','site-2','site-3']);
  assert.ok((await queue.list()).every(item=>item.status==='succeeded'));queue.close();
 }finally{globalThis.fetch=realFetch;}
});

test('the device rejects altered, foreign, stale or untrusted provisioning without the network',async()=>{
 const good=bundle();
 const altered=structuredClone(good);altered.grant.principalId='administrator';await assert.rejects(open(altered),/Invalid offline provisioning/);
 const reencoded=structuredClone(good);reencoded.signature=good.signature.slice(0,-1)+(good.signature.at(-1)==='A'?'B':'A');await assert.rejects(open(reencoded),/Invalid offline provisioning/);
 await assert.rejects(open(good,{deviceId:'tablet-8'}),/another device/);
 await assert.rejects(open(good,{applicationId:'other'}),/another device or application|Invalid/);
 await assert.rejects(open(good,{now:issuedAt-1}),/not current/);
 await assert.rejects(open(good,{now:issuedAt+14*DAY}),/not current/);
 await assert.rejects(open(good,{keys:[{keyId:'prov-1',publicKey:stranger.raw}]}),/Invalid offline provisioning/,'a grant signed by another key');
 // The server signs only releases it trusts, but the device checks the release against its own pinned keys too.
 await assert.rejects(open(bundle({release:signedRelease(stranger,'release-2')})),/Invalid offline provisioning release/,'a release key the device does not pin');
 const tamperedRelease=grant();tamperedRelease.release.publication.version=4;await assert.rejects(open(forged(tamperedRelease)),/Invalid offline provisioning release/);
 await assert.rejects(open(forged(grant({release:signedRelease(release,'release-1',{...definition,id:'other'})}))),/Invalid offline provisioning release/,'a release of another application');
 await assert.rejects(open(forged(grant({notAfter:issuedAt+31*DAY}))),/Invalid offline provisioning/,'a window longer than 30 days');
 await assert.rejects(open(forged({...grant(),extra:true})),/Invalid offline provisioning/);
});

test('the server signs only verifiable, bounded grants and checks the device when it connects',()=>{
 assert.throws(()=>bundle({notAfter:issuedAt+31*DAY}),/Invalid offline provisioning/);
 assert.throws(()=>bundle({release:signedRelease(stranger,'release-9')}),/Invalid signed publication/);
 assert.throws(()=>bundle({},{privateKey:provisioning.publicKey}),/signing configuration/);
 const good=bundle(),check=extra=>verifyOfflineProvisioning(good,{environment:'production',applicationId:'demo',deviceId:device,...serverKeys,now:issuedAt+DAY,...extra});
 assert.equal(check().deviceId,device);
 assert.throws(()=>check({deviceId:'tablet-8'}),/another device/);assert.throws(()=>check({now:issuedAt+14*DAY}),/not current/);
 const altered=structuredClone(good);altered.grant.tenantId='other';assert.throws(()=>verifyOfflineProvisioning(altered,{environment:'production',applicationId:'demo',deviceId:device,...serverKeys,now:issuedAt+DAY}),/Invalid offline provisioning/);
});

test('a browser without WebCrypto Ed25519 is told so instead of failing with a raw crypto error',async()=>{
 const unsupported={subtle:{importKey:async()=>{throw new DOMException("Algorithm: Unrecognized name",'NotSupportedError');},verify:async()=>false}};
 await assert.rejects(open(bundle(),{crypto:unsupported}),/requires WebCrypto Ed25519/);
 // A malformed pinned key is still a configuration error, not an unsupported browser.
 await assert.rejects(open(bundle(),{keys:[{keyId:'prov-1',publicKey:'not-a-key'}]}),error=>!/requires WebCrypto/.test(error.message));
});
