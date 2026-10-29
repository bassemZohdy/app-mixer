import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {generateKeyPairSync} from 'node:crypto';
import {ApplicationStore,createControlPlane,createRemotePromotionClient,RemotePromotionUncertainError,signPromotionPackage,createSignedPromotionVerifier,createPromotionPackage} from '../dist/index.js';

const initial={id:'demo',schemaVersion:1,revision:0,pages:[{id:'home',route:'/',title:'Source',components:[]}]};
const sourceToken='source-secret-at-least-32-characters-long',targetToken='target-secret-at-least-32-characters-long';
const request={actor:{tenantId:'tenant',principalId:'operator'},applicationId:'demo',sourceEnvironment:'development',sourceVersion:1,targetEnvironment:'production',expectedVersion:0};
async function listen(s){s.listen(0,'127.0.0.1');await once(s,'listening');return `http://127.0.0.1:${s.address().port}`;}
async function close(...servers){await Promise.all(servers.map(s=>new Promise(r=>s.close(r))));}
function options(sourceOrigin,targetOrigin,overrides={}){return {sourceOrigin,targetOrigin,sourceToken,targetToken,allowLoopbackHttp:true,authorize:()=>true,audit:()=>{},...overrides};}

test('remote promotion authenticates both endpoints, verifies the package and records provenance',async()=>{
 const source=new ApplicationStore(initial),target=new ApplicationStore(initial);source.publish(0);const a=createControlPlane(source,sourceToken),b=createControlPlane(target,targetToken),[sourceOrigin,targetOrigin]=await Promise.all([listen(a),listen(b)]),events=[];
 try{const client=createRemotePromotionClient(options(sourceOrigin,targetOrigin,{authorize:(stage,details)=>{assert.equal(details.actor.principalId,'operator');assert.equal(JSON.stringify(details).includes('secret'),false);return true;},audit:event=>events.push(event)}));
 const result=await client.promote(request);assert.equal(result.version,1);assert.equal(target.getPublicationProvenance(1).kind,'promotion');assert.deepEqual(events.map(x=>x.phase),['attempt','source_verified','import_authorized','completed']);assert.equal(events[3].details.digest,target.getPublicationProvenance(1).packageDigest);
 }finally{await close(a,b);}
});

test('authorization is checked twice and denied imports leave the target unchanged',async()=>{
 const source=new ApplicationStore(initial),target=new ApplicationStore(initial);source.publish(0);const a=createControlPlane(source,sourceToken),b=createControlPlane(target,targetToken),[sourceOrigin,targetOrigin]=await Promise.all([listen(a),listen(b)]),stages=[],events=[];
 try{const client=createRemotePromotionClient(options(sourceOrigin,targetOrigin,{authorize:stage=>{stages.push(stage);return stage==='export';},audit:e=>events.push(e.phase)}));await assert.rejects(client.promote(request),/authorization denied/);assert.deepEqual(stages,['export','import']);assert.equal(target.getPublished(),undefined);assert.deepEqual(events,['attempt','source_verified','denied']);
 }finally{await close(a,b);}
});

test('a lost response after commit is reported as uncertain without retrying',async()=>{
 const source=new ApplicationStore(initial),target=new ApplicationStore(initial);source.publish(0);const a=createControlPlane(source,sourceToken);let calls=0;const b=createServer(async(req,res)=>{calls++;const chunks=[];for await(const chunk of req)chunks.push(chunk);const input=JSON.parse(Buffer.concat(chunks));target.promote(input.package,input.expectedVersion,input.targetEnvironment);req.socket.destroy();});const [sourceOrigin,targetOrigin]=await Promise.all([listen(a),listen(b)]),events=[];
 try{const client=createRemotePromotionClient(options(sourceOrigin,targetOrigin,{audit:e=>events.push(e.phase)}));await assert.rejects(client.promote(request),RemotePromotionUncertainError);assert.equal(calls,1);assert.equal(target.getPublished().version,1);assert.equal(events.at(-1),'uncertain');
 }finally{await close(a,b);}
});

test('rejects unsafe configuration and unexpected source identity before import',async()=>{
 assert.throws(()=>createRemotePromotionClient(options('http://example.com','https://target.example')),/origin/);assert.throws(()=>createRemotePromotionClient(options('https://user:pass@example.com','https://target.example')),/origin/);assert.throws(()=>createRemotePromotionClient(options('https://same.example','https://same.example')),/configuration/);
 const source=new ApplicationStore(initial),target=new ApplicationStore(initial);source.publish(0);const a=createControlPlane(source,sourceToken),b=createControlPlane(target,targetToken),[sourceOrigin,targetOrigin]=await Promise.all([listen(a),listen(b)]);
 try{const client=createRemotePromotionClient(options(sourceOrigin,targetOrigin));await assert.rejects(client.promote({...request,applicationId:'other'}),/export failed/);assert.equal(target.getPublished(),undefined);
 }finally{await close(a,b);}
});


test('remote promotion signs a verified export for a signature-enforcing target',async()=>{
 const source=new ApplicationStore(initial),target=new ApplicationStore(initial);source.publish(0);const {privateKey,publicKey}=generateKeyPairSync('ed25519'),verify=createSignedPromotionVerifier([{keyId:'release-key',sourceEnvironment:'development',publicKey}],'production'),a=createControlPlane(source,sourceToken),b=createControlPlane(target,targetToken,undefined,undefined,undefined,{verifyWithEvidence:verify.verifyWithEvidence}),[sourceOrigin,targetOrigin]=await Promise.all([listen(a),listen(b)]);try{const client=createRemotePromotionClient(options(sourceOrigin,targetOrigin,{signPackage:(pkg,details)=>signPromotionPackage(pkg,details.targetEnvironment,'release-key',privateKey)}));assert.equal((await client.promote(request)).version,1);assert.equal(target.getPublicationProvenance(1).sourceEnvironment,'development');assert.equal(target.getPublicationProvenance(1).signature.keyId,'release-key');}finally{await close(a,b);}
});


test('remote client rejects signer substitutions before sending an import',async()=>{
 const source=new ApplicationStore(initial),target=new ApplicationStore(initial);source.publish(0);const {privateKey,publicKey}=generateKeyPairSync('ed25519'),verify=createSignedPromotionVerifier([{keyId:'key',sourceEnvironment:'development',publicKey}],'production'),a=createControlPlane(source,sourceToken),b=createControlPlane(target,targetToken,undefined,undefined,undefined,{verify}),[sourceOrigin,targetOrigin]=await Promise.all([listen(a),listen(b)]);try{const client=createRemotePromotionClient(options(sourceOrigin,targetOrigin,{signPackage:pkg=>{pkg.definition.pages[0].title='substituted';const changed=createPromotionPackage(pkg.sourceEnvironment,{version:pkg.sourceVersion,definition:pkg.definition});return signPromotionPackage(changed,'production','key',privateKey);}}));await assert.rejects(client.promote(request),/signing failed/);assert.equal(target.getPublished(),undefined);}finally{await close(a,b);}
});
