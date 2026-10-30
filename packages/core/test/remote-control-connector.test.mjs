import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
import {ApplicationStore,SqliteApplicationStore,createControlPlane,createDataPlane,createRemoteControlConnector,RemoteControlImportUncertainError,signPromotionPackage,createSignedPromotionVerifier,createPromotionPackage} from '../dist/index.js';

const definition={id:'demo',schemaVersion:1,revision:0,pages:[{id:'home',route:'/',title:'Home',components:[]}]},token='source-secret-at-least-32-characters-long',request={actor:{tenantId:'t',principalId:'admin'},sourceVersion:1,expectedVersion:0};
async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${server.address().port}`;}
async function close(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
function config(sourceOrigin,repository,extra={}){return {sourceOrigin,sourceToken:token,sourceEnvironment:'development',targetEnvironment:'production',applicationId:'demo',repository,allowLoopbackHttp:true,authorize:()=>true,audit:()=>{},...extra};}

test('imports authenticated publications locally and keeps serving during source outage',async()=>{
 const source=new ApplicationStore(definition),target=new ApplicationStore(definition);source.publish(0);const remote=createControlPlane(source,token),local=createDataPlane(target),[url,localUrl]=await Promise.all([listen(remote),listen(local)]),events=[];
 try{const connector=createRemoteControlConnector(config(url,target,{audit:event=>events.push(event.phase)}));const result=await connector.importPublication(request);assert.equal(result.version,1);assert.equal(target.getPublicationProvenance(1).sourceEnvironment,'development');assert.deepEqual(events,['attempt','source_verified','import_authorized','completed']);assert.equal((await (await fetch(localUrl+'/application')).json()).version,1);await close(remote);await assert.rejects(connector.importPublication({...request,expectedVersion:1}),/export failed/);assert.equal((await (await fetch(localUrl+'/application')).json()).version,1);}finally{if(remote.listening)await close(remote);await close(local);}
});

test('checks authorization before fetching and before local import',async()=>{
 const source=new ApplicationStore(definition),target=new ApplicationStore(definition);source.publish(0);const remote=createControlPlane(source,token),url=await listen(remote),stages=[],events=[];
 try{const connector=createRemoteControlConnector(config(url,target,{authorize:(stage,details)=>{stages.push(stage);assert.equal(details.actor.principalId,'admin');assert.equal(JSON.stringify(details).includes(token),false);return stage==='export';},audit:event=>events.push(event.phase)}));await assert.rejects(connector.importPublication(request),/authorization denied/);assert.deepEqual(stages,['export','import']);assert.deepEqual(events,['attempt','source_verified','denied']);assert.equal(target.getPublished(),undefined);}finally{await close(remote);}
});

test('SQLite publication and provenance survive restart without the remote source',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'remote-control-')),path=join(dir,'app.sqlite'),source=new ApplicationStore(definition);source.publish(0);const remote=createControlPlane(source,token),url=await listen(remote);let target=new SqliteApplicationStore(path,definition);
 try{await createRemoteControlConnector(config(url,target)).importPublication(request);await close(remote);target.close();target=new SqliteApplicationStore(path,definition);assert.equal(target.getPublished().version,1);assert.equal(target.getPublicationProvenance(1).sourceEnvironment,'development');}finally{target.close();if(remote.listening)await close(remote);rmSync(dir,{recursive:true,force:true});}
});

test('bad source, redirects, configuration and uncertain local writes fail closed',async()=>{
 const target=new ApplicationStore(definition),redirect=createServer((_req,res)=>{res.writeHead(302,{location:'http://example.com'});res.end();}),url=await listen(redirect);
 try{assert.throws(()=>createRemoteControlConnector(config('http://example.com',target)),/configuration/);assert.throws(()=>createRemoteControlConnector(config('https://user@example.com',target)),/configuration/);await assert.rejects(createRemoteControlConnector(config(url,target)).importPublication(request),/export failed/);assert.equal(target.getPublished(),undefined);}finally{await close(redirect);}
 const source=new ApplicationStore(definition);source.publish(0);const remote=createControlPlane(source,token),base=await listen(remote),events=[];
 try{const connector=createRemoteControlConnector(config(base,target,{audit:event=>{events.push(event.phase);if(event.phase==='completed')throw Error('audit unavailable');}}));await assert.rejects(connector.importPublication(request),RemoteControlImportUncertainError);assert.equal(target.getPublished().version,1);assert.equal(events.at(-1),'uncertain');}finally{await close(remote);}
});

test('rejects wrong publication identity and oversized responses without changing local state',async()=>{
 const source=new ApplicationStore({...definition,id:'other'}),target=new ApplicationStore(definition);source.publish(0);const remote=createControlPlane(source,token),url=await listen(remote);
 try{await assert.rejects(createRemoteControlConnector(config(url,target)).importPublication(request),/export failed/);assert.equal(target.getPublished(),undefined);}finally{await close(remote);}
 const large=createServer((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(' '.repeat(2*1024*1024+1));}),base=await listen(large);
 try{await assert.rejects(createRemoteControlConnector(config(base,target)).importPublication(request),/export failed/);assert.equal(target.getPublished(),undefined);}finally{await close(large);}
});

test('stale target versions and denied publication guards never overwrite local data',async()=>{
 const source=new ApplicationStore(definition),target=new ApplicationStore(definition,()=>false);source.publish(0);const remote=createControlPlane(source,token),url=await listen(remote);
 try{const connector=createRemoteControlConnector(config(url,target));await assert.rejects(connector.importPublication(request),RemoteControlImportUncertainError);assert.equal(target.getPublished(),undefined);const other=new ApplicationStore(definition);other.publish(0);await assert.rejects(createRemoteControlConnector(config(url,other)).importPublication(request),RemoteControlImportUncertainError);assert.equal(other.getPublished().version,1);}finally{await close(remote);}
});

test('signed remote import binds target version and stores verifiable signer evidence',async()=>{
 const source=new ApplicationStore(definition),target=new SqliteApplicationStore(':memory:',definition);source.publish(0);const {privateKey,publicKey}=generateKeyPairSync('ed25519'),signer=(pkg,env,version)=>signPromotionPackage(pkg,env,'release',privateKey,version),verifier=createSignedPromotionVerifier([{keyId:'release',sourceEnvironment:'development',publicKey}],'production',{requireVersionBound:true}),remote=createControlPlane(source,token,undefined,undefined,undefined,undefined,signer),url=await listen(remote);
 try{const connector=createRemoteControlConnector(config(url,target,{verifyWithEvidence:verifier.verifyWithEvidence}));assert.equal((await connector.importPublication(request)).version,1);const proof=target.getPublicationProvenance(1).signature;assert.equal(proof.keyId,'release');assert.equal(proof.expectedVersion,0);await assert.rejects(connector.importPublication(request),RemoteControlImportUncertainError);assert.equal(target.getPublished().version,1);}finally{target.close();await close(remote);}
});

test('signed mode rejects unsigned exports and untrusted signing keys before local writes',async()=>{
 const source=new ApplicationStore(definition),target=new ApplicationStore(definition);source.publish(0);const {privateKey}=generateKeyPairSync('ed25519'),trusted=generateKeyPairSync('ed25519'),verify=createSignedPromotionVerifier([{keyId:'release',sourceEnvironment:'development',publicKey:trusted.publicKey}],'production',{requireVersionBound:true}),unsigned=createControlPlane(source,token),signed=createControlPlane(source,token,undefined,undefined,undefined,undefined,(pkg,env,version)=>signPromotionPackage(pkg,env,'release',privateKey,version)),[a,b]=await Promise.all([listen(unsigned),listen(signed)]);
 try{for(const url of [a,b])await assert.rejects(createRemoteControlConnector(config(url,target,{verifyWithEvidence:verify.verifyWithEvidence})).importPublication(request),/export failed/);assert.equal(target.getPublished(),undefined);}finally{await Promise.all([close(unsigned),close(signed)]);}
});

test('signed mode rejects package tampering and replay at another target version',async()=>{
 const source=new ApplicationStore(definition),target=new ApplicationStore(definition);source.publish(0);const {privateKey,publicKey}=generateKeyPairSync('ed25519'),verify=createSignedPromotionVerifier([{keyId:'release',sourceEnvironment:'development',publicKey}],'production',{requireVersionBound:true}),signed=signPromotionPackage(createPromotionPackage('development',source.getPublished()),'production','release',privateKey,0);let document=structuredClone(signed);
 const remote=createServer((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(document));}),url=await listen(remote),connector=createRemoteControlConnector(config(url,target,{verifyWithEvidence:verify.verifyWithEvidence}));
 try{document.package.definition.pages[0].title='Tampered';await assert.rejects(connector.importPublication(request),/export failed/);assert.equal(target.getPublished(),undefined);document=structuredClone(signed);await assert.rejects(connector.importPublication({...request,expectedVersion:1}),/export failed/);assert.equal(target.getPublished(),undefined);}finally{await close(remote);}
});

test('authorized discovery returns the latest exact application without importing it',async()=>{
 const source=new ApplicationStore(definition),target=new ApplicationStore(definition);source.publish(0);source.publish(0);const remote=createControlPlane(source,token),url=await listen(remote),events=[];
 try{const actor={tenantId:'t',principalId:'admin'},discovery={authorize:details=>{assert.equal(details.actor.principalId,'admin');details.actor.principalId='mutated';return true;},audit:event=>events.push(event)};const connector=createRemoteControlConnector(config(url,target,{discovery}));assert.deepEqual(await connector.discoverLatest(actor),{applicationId:'demo',sourceVersion:2});assert.equal(actor.principalId,'admin');assert.deepEqual(events.map(e=>e.phase),['attempt','completed']);assert.equal(events[1].details.actor.principalId,'admin');assert.equal(events[1].details.sourceVersion,2);assert.equal(target.getPublished(),undefined);assert.equal((await connector.importPublication({...request,sourceVersion:2})).version,1);}finally{await close(remote);}
});

test('discovery requires authorization and rejects mismatched or malformed responses',async()=>{
 let calls=0,body=JSON.stringify({applicationId:'other',version:1});const remote=createServer((_req,res)=>{calls++;res.writeHead(200,{'content-type':'application/json'});res.end(body);}),url=await listen(remote),target=new ApplicationStore(definition),actor={tenantId:'t',principalId:'user'};
 try{await assert.rejects(createRemoteControlConnector(config(url,target)).discoverLatest(actor),/discovery/);const events=[],deny=createRemoteControlConnector(config(url,target,{discovery:{authorize:()=>false,audit:e=>events.push(e.phase)}}));await assert.rejects(deny.discoverLatest(actor),/denied/);assert.equal(calls,0);assert.deepEqual(events,['attempt','denied']);const allow=createRemoteControlConnector(config(url,target,{discovery:{authorize:()=>true,audit:()=>{}}}));for(const value of [{applicationId:'other',version:1},{applicationId:'demo',version:0},{applicationId:'demo',version:1,extra:true}]){body=JSON.stringify(value);await assert.rejects(allow.discoverLatest(actor),/discovery failed/);}assert.equal(target.getPublished(),undefined);}finally{await close(remote);}
});

test('discovery rechecks permission before returning a remotely observed version',async()=>{
 const source=new ApplicationStore(definition),target=new ApplicationStore(definition);source.publish(0);const remote=createControlPlane(source,token),url=await listen(remote),events=[];let checks=0;
 try{const connector=createRemoteControlConnector(config(url,target,{discovery:{authorize:()=>++checks===1,audit:e=>events.push(e.phase)}}));await assert.rejects(connector.discoverLatest({tenantId:'t',principalId:'u'}),/denied/);assert.equal(checks,2);assert.deepEqual(events,['attempt','denied']);}finally{await close(remote);}
});
