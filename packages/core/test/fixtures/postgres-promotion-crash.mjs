import {createPublicKey,createHash} from 'node:crypto';
import pg from 'pg';
import {PostgresPromotionTarget,PostgresRemoteRollout,createRemoteControlConnector,createSignedPromotionVerifier} from '../../dist/index.js';

const phase=process.env.TEST_PHASE,pool=new pg.Pool({connectionString:process.env.APP_MIXER_TEST_POSTGRES_URL,options:`-c search_path=${process.env.TEST_SCHEMA}`}),publicKey=createPublicKey(process.env.TEST_PUBLIC_KEY),fingerprint=createHash('sha256').update(publicKey.export({type:'spki',format:'der'})).digest('hex');
const hold=()=>new Promise(()=>{});
const target=new PostgresPromotionTarget({enabled:true,tenantId:'tenant',applicationId:'demo',sourceEnvironment:'dev',targetEnvironment:'prod',query:(sql,args)=>pool.query(sql,args),authorizeSignature:evidence=>evidence.keyFingerprint===fingerprint,transaction:async operation=>{
 const client=await pool.connect();try{await client.query('BEGIN');const result=await operation((sql,args)=>client.query(sql,args));if(phase==='before-commit'){process.send(phase);await hold();}await client.query('COMMIT');if(phase==='after-commit'){process.send(phase);await hold();}return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}});
const verifier=createSignedPromotionVerifier([{keyId:'key',sourceEnvironment:'dev',publicKey}],'prod',{requireVersionBound:true}),connector=createRemoteControlConnector({sourceOrigin:process.env.TEST_ORIGIN,sourceToken:process.env.TEST_TOKEN,sourceEnvironment:'dev',targetEnvironment:'prod',applicationId:'demo',repository:target,allowLoopbackHttp:true,authorize:()=>true,audit:()=>{},discovery:{authorize:()=>true,audit:()=>{}},requireAdvancingSource:true,verifyWithEvidence:verifier.verifyWithEvidence}),rollout=new PostgresRemoteRollout({enabled:true,connector,actor:{tenantId:'tenant',principalId:'operator'},query:(sql,args)=>pool.query(sql,args)});
try{await target.initialize();await rollout.initialize();await rollout.runOnce();throw Error('Expected termination');}catch(error){process.send({error:String(error)});process.exitCode=1;await pool.end();}
