// Replication to a disconnected target: signed promotion documents are carried on removable media (files here) to a
// target with no connection to the source. Each is verified, applied in order exactly once, and a replayed, older,
// altered, foreign or mis-ordered document is refused, as is a target restored behind its host-held floor.
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ApplicationStore,signPromotionPackage,createSignedPromotionVerifier,exportDisconnectedPromotion,createDisconnectedPromotionImporter} from '../dist/index.js';

const definition={id:'demo',schemaVersion:1,revision:0,pages:[]},actor={tenantId:'tenant',principalId:'operator'};
const signing=generateKeyPairSync('ed25519'),stranger=generateKeyPairSync('ed25519');
const signer=keys=>(pkg,environment,expectedVersion)=>signPromotionPackage(pkg,environment,'key',keys.privateKey,expectedVersion);
const verifier=createSignedPromotionVerifier([{keyId:'key',sourceEnvironment:'dev',publicKey:signing.publicKey}],'prod',{requireVersionBound:true});

test('signed promotions carried to a disconnected target apply in order once and refuse replays and tampering',async()=>{
 const media=await mkdtemp(join(tmpdir(),'disconnected-')),realFetch=globalThis.fetch;let network=0,carried=0;
 try{
  // Source side (connected to nothing but the media): five published versions, each exported for the version it must follow.
  const source=new ApplicationStore(definition);for(let i=0;i<5;i++)source.publish(0);
  const carry=async(sourceVersion,expectedVersion,options={})=>{const document=exportDisconnectedPromotion(source,{applicationId:'demo',sourceEnvironment:'dev',targetEnvironment:'prod',sourceVersion,expectedVersion,sign:signer(signing),...options});const path=join(media,`demo-v${sourceVersion}-after-${expectedVersion}-${++carried}.json`);await writeFile(path,JSON.stringify(document));return path;};
  const files=[];for(let v=1;v<=4;v++)files[v]=await carry(v,v-1);
  // Target side: no network at all.
  globalThis.fetch=()=>{network++;throw Error('disconnected');};
  const events=[],target=new ApplicationStore(definition);let allowed=true;
  const importer=(repository=target,extra={})=>createDisconnectedPromotionImporter({applicationId:'demo',sourceEnvironment:'dev',targetEnvironment:'prod',repository,verifyWithEvidence:verifier.verifyWithEvidence,authorize:()=>allowed,audit:event=>events.push([event.phase,event.details.sourceVersion]),...extra});
  const load=async path=>importer().importDocument({actor,document:await readFile(path,'utf8')});
  // Out of order: version 3 must follow target version 2, so it is refused and nothing changes.
  await assert.rejects(load(files[3]),/Target version does not match/);assert.equal(target.getPublished(),undefined);
  for(const v of [1,2,3])assert.equal((await load(files[v])).version,v);
  // Replaying any document already applied is refused by the promotion floor.
  for(const v of [1,2,3])await assert.rejects(load(files[v]),/not newer than the promotion floor/);
  // Altered, foreign and wrongly signed documents are refused and consume nothing.
  const altered=JSON.parse(await readFile(files[4],'utf8'));altered.signed.package.definition.title='altered';
  await assert.rejects(importer().importDocument({actor,document:altered}),/verification failed/);
  const relabelled=JSON.parse(await readFile(files[4],'utf8'));relabelled.sourceVersion=5;
  await assert.rejects(importer().importDocument({actor,document:relabelled}),/verification failed/,'the cover sheet must match the signed package');
  await assert.rejects(load(await carry(4,3,{sign:signer(stranger)})),/verification failed/,'an untrusted signing key');
  await assert.rejects(load(await carry(4,3,{targetEnvironment:'staging'})),/Invalid disconnected promotion document/,'a document for another target');
  await assert.rejects(importer().importDocument({actor,document:'{not json'}),/Invalid disconnected promotion document/);
  allowed=false;await assert.rejects(load(files[4]),/denied/);allowed=true;
  assert.equal((await load(files[4])).version,4,'the genuine document still applies after the refused ones');
  assert.ok(target.getPublicationProvenance(4),'the promotion is recorded with provenance');
  assert.equal(network,0,'the target never used the network');
  // A target restored from an older backup falls behind the floor the host keeps outside it, and is refused.
  let held=0;const anchor={read:()=>held,advance:value=>{held=Math.max(held,value);}};
  const anchored=new ApplicationStore(definition);for(const v of [1,2,3,4])await importer(anchored,{promotionFloorAnchor:anchor}).importDocument({actor,document:await readFile(files[v],'utf8')});
  assert.equal(held,4);
  const restored=new ApplicationStore(definition);await importer(restored).importDocument({actor,document:await readFile(files[1],'utf8')});
  const fifth=await carry(5,1);
  await assert.rejects(importer(restored,{promotionFloorAnchor:anchor}).importDocument({actor,document:await readFile(fifth,'utf8')}),/rollback detected/);
  assert.equal(restored.getPublished().version,1,'nothing was applied to the restored target');
  assert.ok(events.some(([phase])=>phase==='floor_rejected')&&events.some(([phase])=>phase==='denied')&&events.filter(([phase])=>phase==='completed').length===9);
 }finally{globalThis.fetch=realFetch;await rm(media,{recursive:true,force:true});}
});

test('disconnected promotion configuration and export are validated',()=>{
 const source=new ApplicationStore(definition);source.publish(0);
 assert.throws(()=>createDisconnectedPromotionImporter({applicationId:'demo',sourceEnvironment:'dev',targetEnvironment:'dev'}),/configuration/);
 assert.throws(()=>createDisconnectedPromotionImporter({applicationId:'demo',sourceEnvironment:'dev',targetEnvironment:'prod',repository:{promote(){}},authorize(){},audit(){},verifyWithEvidence:verifier.verifyWithEvidence}),/configuration/,'the repository must enforce an advancing source');
 assert.throws(()=>exportDisconnectedPromotion(source,{applicationId:'demo',sourceEnvironment:'dev',targetEnvironment:'prod',sourceVersion:2,expectedVersion:0,sign:signer(signing)}),/Source version unavailable/);
 assert.throws(()=>exportDisconnectedPromotion(source,{applicationId:'other',sourceEnvironment:'dev',targetEnvironment:'prod',sourceVersion:1,expectedVersion:0,sign:signer(signing)}),/Source version unavailable/);
});
