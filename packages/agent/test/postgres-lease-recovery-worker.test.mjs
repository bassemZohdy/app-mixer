import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {AgentRunLeaseRecoveryWorker} from '../dist/index.js';
import {PostgresAgentTriggerFoundation} from '../dist/postgres-trigger-foundation.js';
import {PostgresAgentRunLifecycleFoundation} from '../dist/postgres-run-lifecycle-foundation.js';
const transaction=pool=>async operation=>{const client=await pool.connect();try{await client.query('BEGIN');const value=await operation((sql,args)=>client.query(sql,args));await client.query('COMMIT');return value;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}};

test('shared lease recovery respects authorization and cancels in-flight transitions',{skip:!process.env.APP_MIXER_TEST_POSTGRES_URL,timeout:60000},async()=>{
 const schema='shared_recovery_worker_'+randomUUID().replaceAll('-',''),url=process.env.APP_MIXER_TEST_POSTGRES_URL,admin=new pg.Pool({connectionString:url}),pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`}),scope={tenantId:'tenant',agentId:'agent'},config={query:(sql,args)=>pool.query(sql,args),transaction:transaction(pool)};
 try{
  await admin.query(`CREATE SCHEMA "${schema}"`);const triggers=new PostgresAgentTriggerFoundation(config),runs=new PostgresAgentRunLifecycleFoundation(config);await triggers.initialize();await runs.initialize();const {runId}=await triggers.enqueue(scope,{sourceId:'manual',principalId:'person',eventId:'one',eventType:'manual',payload:{}},{definitionVersion:1,maxAttempts:3,deadline:Date.now()+60000,maxPending:10}),claim=await runs.claim(scope,runId,1,'lost',30000,2);await pool.query('UPDATE app_mixer_shared_runs SET lease_until=(extract(epoch from clock_timestamp())*1000)::bigint-1 WHERE tenant_id=$1 AND agent_id=$2 AND run_id=$3',[scope.tenantId,scope.agentId,runId]);
  let entered,release;const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),delayed=new PostgresAgentRunLifecycleFoundation({...config,transaction:async operation=>transaction(pool)(query=>operation(async(sql,args)=>{const value=await query(sql,args);if(sql.startsWith('INSERT INTO app_mixer_shared_run_recovery_audit')){entered();await gate;}return value;}))}),errors=[],worker=new AgentRunLeaseRecoveryWorker({runs:delayed,scope,maxPerPass:5,pollMs:100,clock:()=>0,authorize:()=>true,onError:error=>errors.push(error),evidence:{principalId:'operator',reference:'case'}});
  const pending=worker.runOnce();await ready;const stopping=worker.stop();release();assert.equal(await pending,0);await stopping;assert.equal((await runs.get(scope,runId)).status,'running');assert.deepEqual((await runs.recoveryHistory(scope,runId)).items,[]);assert.deepEqual(errors,[]);
  let checks=0;const recovered=new AgentRunLeaseRecoveryWorker({runs,scope,maxPerPass:5,pollMs:100,clock:()=>0,authorize:lease=>{checks++;assert.equal(Object.hasOwn(lease,'leaseToken'),false);return true;},onError:error=>{throw error;},evidence:{principalId:'operator',reference:'case'}});assert.equal(await recovered.runOnce(),1);assert.equal(checks,2);assert.equal((await runs.get(scope,runId)).status,'uncertain');assert.equal((await runs.recoveryHistory(scope,runId)).items[0].principalId,'operator');assert.equal(await recovered.runOnce(),0);await recovered.stop();assert.equal(claim.revision+1,(await runs.get(scope,runId)).revision);
 }finally{await pool.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end();}
});
