import {SqliteApplicationStore,SqliteRemoteRollout,createRemoteControlConnector,createSignedPromotionVerifier} from '../../dist/index.js';
import {createPublicKey} from 'node:crypto';
const definition={id:'demo',schemaVersion:1,revision:0,pages:[]},store=new SqliteApplicationStore(process.env.TEST_TARGET,definition);
const verifier=createSignedPromotionVerifier([{keyId:'key',sourceEnvironment:'dev',publicKey:createPublicKey(process.env.TEST_PUBLIC_KEY)}],'prod',{requireVersionBound:true});
const connector=createRemoteControlConnector({sourceOrigin:process.env.TEST_ORIGIN,sourceToken:process.env.TEST_TOKEN,sourceEnvironment:'dev',targetEnvironment:'prod',applicationId:'demo',repository:store,allowLoopbackHttp:true,authorize:()=>true,audit:async event=>{if(event.phase==='import_authorized'){process.stdout.write('IMPORTING\n');await new Promise(resolve=>setTimeout(resolve,60000));}},discovery:{authorize:()=>true,audit:()=>{}},requireAdvancingSource:true,verifyWithEvidence:verifier.verifyWithEvidence});
const rollout=new SqliteRemoteRollout(process.env.TEST_ROLLOUT,connector,{tenantId:'tenant',principalId:'operator'});await rollout.runOnce();
