import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
import {ApplicationStore,SqliteApplicationStore,SqliteRemoteRollout,RemoteRolloutPoller,createControlPlane,createRemoteControlConnector,signPromotionPackage,createSignedPromotionVerifier,RemoteControlImportUncertainError} from '../dist/index.js';

const definition={id:'demo',schemaVersion:1,revision:0,pages:[]},actor={tenantId:'tenant',principalId:'operator'},token='source-secret-at-least-32-characters-long';
async function fixture(){const dir=mkdtempSync(join(tmpdir(),'rollout-')),source=new ApplicationStore(definition),target=new SqliteApplicationStore(join(dir,'target.sqlite'),definition);source.publish(0);const {privateKey,publicKey}=generateKeyPairSync('ed25519'),signer=(pkg,environment,version)=>signPromotionPackage(pkg,environment,'key',privateKey,version),verifier=createSignedPromotionVerifier([{keyId:'key',sourceEnvironment:'dev',publicKey}],'prod',{requireVersionBound:true}),server=createControlPlane(source,token,undefined,undefined,undefined,undefined,signer);server.listen(0,'127.0.0.1');await once(server,'listening');const config={sourceOrigin:`http://127.0.0.1:${server.address().port}`,sourceToken:token,sourceEnvironment:'dev',targetEnvironment:'prod',applicationId:'demo',repository:target,allowLoopbackHttp:true,authorize:()=>true,audit:()=>{},discovery:{authorize:()=>true,audit:()=>{}},requireAdvancingSource:true,verifyWithEvidence:verifier.verifyWithEvidence};return {dir,source,target,server,config,publicKey,path:join(dir,'rollout.sqlite')};}
async function cleanup(f){f.target.close();if(f.server.listening){f.server.closeAllConnections();await new Promise(resolve=>f.server.close(resolve));}rmSync(f.dir,{recursive:true,force:true});}
async function waitFor(check){for(let i=0;i<300;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Timed out waiting for rollout');}

test('poller backs off on pre-import failure and imports when the source becomes available',async()=>{
 const f=await fixture();let permitted=false;const errors=[],results=[],rollout=new SqliteRemoteRollout(f.path,createRemoteControlConnector({...f.config,discovery:{...f.config.discovery,authorize:()=>permitted}}),actor),poller=new RemoteRolloutPoller({rollout,intervalMs:100,maxBackoffMs:400,onResult:value=>results.push({value,time:performance.now()}),onError:(error,review)=>errors.push({error,review,time:performance.now()})});
 try{poller.start();assert.throws(()=>poller.start(),/already running/);await waitFor(()=>errors.length===1);assert.equal(errors[0].review,false);assert.equal(rollout.getState().phase,'idle');permitted=true;await waitFor(()=>results.length>0);assert.equal(results[0].value.status,'imported');assert.ok(results[0].time-errors[0].time>=190);assert.equal(f.target.getPublished().version,1);await poller.stop();assert.equal(poller.isRunning(),false);}finally{await poller.stop();rollout.close();await cleanup(f);}
});

test('poller stops on an uncertain import until an operator reconciles and restarts it',async()=>{
 const f=await fixture();let failAudit=true;const errors=[],results=[],rollout=new SqliteRemoteRollout(f.path,createRemoteControlConnector({...f.config,audit:event=>{if(failAudit&&event.phase==='completed')throw Error('audit failed')}}),actor),poller=new RemoteRolloutPoller({rollout,intervalMs:100,maxBackoffMs:200,onResult:value=>results.push(value),onError:(error,review)=>errors.push({error,review})});
 try{poller.start();await waitFor(()=>errors.length===1);assert.equal(errors[0].review,true);assert.equal(poller.isRunning(),false);assert.equal(rollout.getState().phase,'uncertain');await new Promise(resolve=>setTimeout(resolve,250));assert.equal(errors.length,1);assert.equal(results.length,0);await poller.stop();await rollout.recover(state=>state.sourceVersion===f.target.getPublicationProvenance(1).sourceVersion);failAudit=false;poller.start();await waitFor(()=>results.length===1);assert.equal(results[0].status,'unchanged');await poller.stop();}finally{await poller.stop();rollout.close();await cleanup(f);}
});

test('poller stop waits for an in-flight pass and prevents another pass',async()=>{
 const f=await fixture();let started,release,passes=0;const ready=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve),rollout=new SqliteRemoteRollout(f.path,createRemoteControlConnector({...f.config,discovery:{...f.config.discovery,authorize:async()=>{passes++;started();await gate;return true;}}}),actor),poller=new RemoteRolloutPoller({rollout,intervalMs:100,maxBackoffMs:100,onResult:()=>{},onError:()=>{}});
 try{poller.start();await ready;let stopped=false;const pending=poller.stop().then(()=>stopped=true);await new Promise(resolve=>setTimeout(resolve,20));assert.equal(stopped,false);release();await pending;await new Promise(resolve=>setTimeout(resolve,150));assert.equal(passes,2);assert.equal(poller.isRunning(),false);}finally{release();await poller.stop();rollout.close();await cleanup(f);}
});

test('scheduled rollout imports signed newer versions and skips an already applied version',async()=>{
 const f=await fixture(),rollout=new SqliteRemoteRollout(f.path,createRemoteControlConnector(f.config),actor);
 try{assert.deepEqual(await rollout.runOnce(),{status:'imported',sourceVersion:1,targetVersion:1});assert.deepEqual(await rollout.runOnce(),{status:'unchanged',sourceVersion:1,targetVersion:1});f.source.publish(0);assert.deepEqual(await rollout.runOnce(),{status:'imported',sourceVersion:2,targetVersion:2});assert.equal(f.target.getPublicationProvenance(2).signature.keyId,'key');assert.equal(rollout.getState().phase,'idle');}finally{rollout.close();await cleanup(f);}
});

test('uncertain import is durably blocked until an authorized recovery inspects it',async()=>{
 const f=await fixture();let rollout;
 try{const connector=createRemoteControlConnector({...f.config,audit:event=>{if(event.phase==='completed')throw Error('audit failed');}});rollout=new SqliteRemoteRollout(f.path,connector,actor);await assert.rejects(rollout.runOnce(),RemoteControlImportUncertainError);assert.equal(f.target.getPublished().version,1);assert.deepEqual({...rollout.getState(),token:'token'},{phase:'uncertain',sourceVersion:1,expectedVersion:0,token:'token'});rollout.close();rollout=new SqliteRemoteRollout(f.path,createRemoteControlConnector(f.config),actor);await assert.rejects(rollout.runOnce(),/recovery/);await assert.rejects(rollout.recover(()=>false),/denied/);assert.equal(rollout.getState().phase,'uncertain');await rollout.recover(state=>state.sourceVersion===f.target.getPublicationProvenance(1).sourceVersion);assert.deepEqual(await rollout.runOnce(),{status:'unchanged',sourceVersion:1,targetVersion:1});}finally{rollout?.close();await cleanup(f);}
});

test('a killed worker leaves a durable import gate for an operator to reconcile',async()=>{
 const f=await fixture(),fixturePath=fileURLToPath(new URL('./fixtures/rollout-crash.mjs',import.meta.url)),env={...process.env,TEST_TARGET:join(f.dir,'target.sqlite'),TEST_ORIGIN:f.config.sourceOrigin,TEST_TOKEN:token,TEST_PUBLIC_KEY:f.publicKey.export({type:'spki',format:'pem'}),TEST_ROLLOUT:f.path},child=spawn(process.execPath,[fixturePath],{env,stdio:['ignore','pipe','pipe']});let rollout;
 try{let output='',errors='';child.stderr.on('data',chunk=>errors+=chunk);await Promise.race([new Promise((resolve,reject)=>{child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('IMPORTING'))resolve();});child.once('exit',()=>reject(Error('worker exited before import: '+errors)));}),new Promise((_,reject)=>setTimeout(()=>reject(Error('worker did not reach import')),10000).unref())]);const exited=once(child,'exit');child.kill();await exited;rollout=new SqliteRemoteRollout(f.path,createRemoteControlConnector(f.config),actor);assert.equal(rollout.getState().phase,'importing');assert.equal(f.target.getPublished(),undefined);await assert.rejects(rollout.runOnce(),/recovery/);await rollout.recover(state=>state.phase==='importing'&&f.target.getPublished()===undefined);assert.equal((await rollout.runOnce()).status,'imported');}finally{if(child.exitCode===null&&child.signalCode===null)child.kill();rollout?.close();await cleanup(f);}
});

test('competing workers cannot overlap',async()=>{
 const f=await fixture();let release,started;const entered=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);const connector=createRemoteControlConnector({...f.config,discovery:{...f.config.discovery,authorize:async()=>{started();await gate;return true;}}}),first=new SqliteRemoteRollout(f.path,connector,actor),second=new SqliteRemoteRollout(f.path,connector,actor);
 try{const pending=first.runOnce();await entered;await assert.rejects(second.runOnce(),/recovery/);assert.throws(()=>first.close(),/active/);release();assert.equal((await pending).status,'imported');assert.equal((await second.runOnce()).status,'unchanged');}finally{release();first.close();second.close();await cleanup(f);}
});

test('source outage releases a live pre-import claim and leaves publication unchanged',async()=>{
 const f=await fixture(),rollout=new SqliteRemoteRollout(f.path,createRemoteControlConnector(f.config),actor);
 try{f.server.closeAllConnections();await new Promise(resolve=>f.server.close(resolve));await assert.rejects(rollout.runOnce(),/discovery failed/);assert.equal(rollout.getState().phase,'idle');assert.equal(f.target.getPublished(),undefined);}finally{rollout.close();await cleanup(f);}
});

test('rollout requires signed advancing imports and refuses a source behind retained history',async()=>{
 const f=await fixture();let rollout;
 try{assert.throws(()=>new SqliteRemoteRollout(f.path,createRemoteControlConnector({...f.config,requireAdvancingSource:false}),actor),/configuration/);f.source.publish(0);const direct=createRemoteControlConnector(f.config);await direct.importPublication({actor,sourceVersion:2,expectedVersion:0});const stale=new ApplicationStore(definition);stale.publish(0);const staleServer=createControlPlane(stale,token);staleServer.listen(0,'127.0.0.1');await once(staleServer,'listening');try{rollout=new SqliteRemoteRollout(f.path,createRemoteControlConnector({...f.config,sourceOrigin:`http://127.0.0.1:${staleServer.address().port}`}),actor);await assert.rejects(rollout.runOnce(),/behind local history/);assert.equal(rollout.getState().phase,'idle');assert.equal(f.target.getPublished().version,1);}finally{staleServer.closeAllConnections();await new Promise(resolve=>staleServer.close(resolve));}}finally{rollout?.close();await cleanup(f);}
});
