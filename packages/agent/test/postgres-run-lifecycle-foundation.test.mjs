import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {PostgresAgentTriggerFoundation} from '../dist/postgres-trigger-foundation.js';
import {PostgresAgentRunLifecycleFoundation} from '../dist/postgres-run-lifecycle-foundation.js';
const transaction=pool=>async operation=>{const client=await pool.connect();try{await client.query('BEGIN');const result=await operation((sql,args)=>client.query(sql,args));await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}};

test('shared lifecycle serializes claims and fences stale or expired leases',{skip:!process.env.APP_MIXER_TEST_POSTGRES_URL,timeout:30000},async()=>{
 const schema='shared_lifecycle_'+randomUUID().replaceAll('-',''),url=process.env.APP_MIXER_TEST_POSTGRES_URL,admin=new pg.Pool({connectionString:url}),a=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`}),b=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
 const scope={tenantId:'tenant',agentId:'agent'},other={...scope,tenantId:'other'},options={definitionVersion:1,maxAttempts:3,deadline:Date.now()+60000,maxPending:10};
 const config=pool=>({query:(sql,args)=>pool.query(sql,args),transaction:transaction(pool)});
 try{
  await admin.query(`CREATE SCHEMA "${schema}"`);const triggers=new PostgresAgentTriggerFoundation(config(a));await triggers.initialize();const first=new PostgresAgentRunLifecycleFoundation(config(a)),second=new PostgresAgentRunLifecycleFoundation(config(b));await first.initialize();await second.initialize();
  const add=(s,eventId)=>triggers.enqueue(s,{sourceId:'manual',principalId:'person',eventId,eventType:'manual',payload:{}},options);
  const one=(await add(scope,'one')).runId,two=(await add(scope,'two')).runId,foreign=(await add(other,'one')).runId;
  assert.equal((await first.get(scope,one)).status,'queued');assert.equal(await first.get(other,one),undefined);
  const race=await Promise.allSettled([first.claim(scope,one,1,'worker-a',30000,1,1),second.claim(scope,two,1,'worker-b',30000,1,1)]);assert.equal(race.filter(result=>result.status==='fulfilled').length,1);assert.match(race.find(result=>result.status==='rejected').reason.message,/concurrency limit/);
  let active=race.find(result=>result.status==='fulfilled').value;const waiting=active.runId===one?two:one;assert.equal(active.revision,2);assert.equal(active.attempts,1);assert.ok(active.leaseToken);assert.equal((await first.claim(other,foreign,1,'worker-c',30000,1,1)).status,'running');
  const sameScope={...scope,agentId:'same'},same=(await add(sameScope,'one')).runId,sameRace=await Promise.allSettled([first.claim(sameScope,same,1,'worker-a',30000,2),second.claim(sameScope,same,1,'worker-b',30000,2)]);assert.equal(sameRace.filter(result=>result.status==='fulfilled').length,1);assert.match(sameRace.find(result=>result.status==='rejected').reason.message,/revision conflict/);
  await assert.rejects(second.renew(scope,active.runId,active.revision,'wrong-token',30000),/expired lease/);await assert.rejects(second.recoverExpired(scope,active.runId,active.revision),/Lease is active/);
  const stale=active;active=await second.renew(scope,active.runId,active.revision,active.leaseToken,30000);assert.equal(active.revision,3);await assert.rejects(first.renew(scope,active.runId,stale.revision,stale.leaseToken,30000),/revision conflict/);
  await a.query('UPDATE app_mixer_shared_runs SET lease_until=(extract(epoch from clock_timestamp())*1000)::bigint-1 WHERE tenant_id=$1 AND agent_id=$2 AND run_id=$3',[scope.tenantId,scope.agentId,active.runId]);
  await assert.rejects(first.renew(scope,active.runId,active.revision,active.leaseToken,30000),/expired lease/);const recovered=await second.recoverExpired(scope,active.runId,active.revision);assert.equal(recovered.status,'uncertain');assert.equal(recovered.leaseToken,null);assert.equal(recovered.revision,4);await assert.rejects(first.renew(scope,active.runId,active.revision,active.leaseToken,30000),/revision conflict/);
  await assert.rejects(first.claim(scope,waiting,1,'worker-a',30000,1,1),/daily run limit/);assert.equal((await first.get(scope,waiting)).status,'queued');
  const isolated=await first.get(other,foreign);assert.equal(isolated.status,'running');
  const rollbackScope={...scope,agentId:'rollback'},rollbackRun=(await add(rollbackScope,'one')).runId;
  const failing=new PostgresAgentRunLifecycleFoundation({...config(a),transaction:async operation=>transaction(a)(query=>operation((sql,args)=>{if(sql.startsWith('UPDATE app_mixer_shared_runs'))throw Error('injected failure');return query(sql,args);}))});
  await assert.rejects(failing.claim(rollbackScope,rollbackRun,1,'worker-a',30000,1,1),/injected failure/);assert.equal((await first.get(rollbackScope,rollbackRun)).status,'queued');assert.equal((await a.query('SELECT count(*)::int AS n FROM app_mixer_shared_run_starts WHERE tenant_id=$1 AND agent_id=$2',[rollbackScope.tenantId,rollbackScope.agentId])).rows[0].n,0);
  await a.query('UPDATE app_mixer_shared_runs SET lease_token=$4 WHERE tenant_id=$1 AND agent_id=$2 AND run_id=$3',[rollbackScope.tenantId,rollbackScope.agentId,rollbackRun,'stray']);await assert.rejects(first.get(rollbackScope,rollbackRun),/Invalid shared run data/);
 }finally{await a.end();await b.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end();}
});
