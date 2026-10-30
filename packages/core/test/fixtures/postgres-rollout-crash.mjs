import {createPublicKey} from 'node:crypto';
import pg from 'pg';
import {SqliteApplicationStore,PostgresRemoteRollout,createRemoteControlConnector,createSignedPromotionVerifier} from '../../dist/index.js';

const store=new SqliteApplicationStore(process.env.TEST_TARGET,{id:'demo',schemaVersion:1,revision:0,pages:[]}),pool=new pg.Pool({connectionString:process.env.APP_MIXER_TEST_POSTGRES_URL,options:`-c search_path=${process.env.TEST_SCHEMA}`});
const verifier=createSignedPromotionVerifier([{keyId:'key',sourceEnvironment:'dev',publicKey:createPublicKey(process.env.TEST_PUBLIC_KEY)}],'prod',{requireVersionBound:true});
const connector=createRemoteControlConnector({sourceOrigin:process.env.TEST_ORIGIN,sourceToken:process.env.TEST_TOKEN,sourceEnvironment:'dev',targetEnvironment:'prod',applicationId:'demo',repository:store,allowLoopbackHttp:true,authorize:()=>true,audit:async event=>{if(event.phase==='import_authorized'){process.send('importing');await new Promise(()=>{});}},discovery:{authorize:()=>true,audit:()=>{}},requireAdvancingSource:true,verifyWithEvidence:verifier.verifyWithEvidence});
const rollout=new PostgresRemoteRollout({enabled:true,connector,actor:{tenantId:'tenant',principalId:'operator'},query:(sql,args)=>pool.query(sql,args)});
try{await rollout.initialize();await rollout.runOnce();throw Error('Expected termination');}catch(error){process.send({error:String(error)});process.exitCode=1;store.close();await pool.end();}
