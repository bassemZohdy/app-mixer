import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {PostgresAgentTriggerFoundation} from '../dist/postgres-trigger-foundation.js';

const transaction=pool=>async operation=>{const client=await pool.connect();try{await client.query('BEGIN');const result=await operation((sql,args)=>client.query(sql,args));await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}};

test('shared trigger and run creation is atomic and serialized across hosts',{skip:!process.env.APP_MIXER_TEST_POSTGRES_URL,timeout:30000},async()=>{
 const schema='shared_triggers_'+randomUUID().replaceAll('-',''),url=process.env.APP_MIXER_TEST_POSTGRES_URL,admin=new pg.Pool({connectionString:url}),a=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`}),b=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
 const scope={tenantId:'tenant',agentId:'agent'},event={sourceId:'manual',principalId:'person',eventId:'request',eventType:'manual',payload:{value:'example'}},options={definitionVersion:1,maxAttempts:3,deadline:Date.now()+60000,maxPending:1};
 try{
  await admin.query(`CREATE SCHEMA "${schema}"`);const first=new PostgresAgentTriggerFoundation({query:(sql,args)=>a.query(sql,args),transaction:transaction(a)}),second=new PostgresAgentTriggerFoundation({query:(sql,args)=>b.query(sql,args),transaction:transaction(b)});await first.initialize();await second.initialize();
  const both=await Promise.all([first.enqueue(scope,event,options),second.enqueue(scope,event,options)]);assert.equal(both[0].runId,both[1].runId);assert.deepEqual(both.map(item=>item.duplicate).sort(),[false,true]);
  await assert.rejects(second.enqueue(scope,{...event,payload:{value:'changed'}},options),/identity conflict/);await assert.rejects(second.enqueue(scope,{...event,principalId:'other'},options),/identity conflict/);
  await assert.rejects(second.enqueue(scope,{...event,eventId:'new'},options),/backlog full/);
  const other=await second.enqueue({...scope,tenantId:'other'},event,options);assert.notEqual(other.runId,both[0].runId);
  const raceScope={...scope,agentId:'race'};
  const race=await Promise.allSettled([first.enqueue(raceScope,{...event,eventId:'one'},options),second.enqueue(raceScope,{...event,eventId:'two'},options)]);
  assert.equal(race.filter(item=>item.status==='fulfilled').length,1);assert.match(race.find(item=>item.status==='rejected').reason.message,/backlog full/);
  const result=await a.query('SELECT r.run_id,r.status,r.definition_version,i.payload,i.received_at FROM app_mixer_shared_runs r JOIN app_mixer_shared_trigger_inbox i USING(tenant_id,agent_id,run_id) WHERE r.tenant_id=$1 AND r.agent_id=$2',[scope.tenantId,scope.agentId]);assert.equal(result.rowCount,1);assert.equal(result.rows[0].status,'queued');assert.equal(Number(result.rows[0].definition_version),1);assert.deepEqual(JSON.parse(result.rows[0].payload),event.payload);assert.ok(Number(result.rows[0].received_at)>0);
  const failing=new PostgresAgentTriggerFoundation({query:(sql,args)=>a.query(sql,args),transaction:async operation=>transaction(a)(query=>operation((sql,args)=>{if(sql.startsWith('INSERT INTO app_mixer_shared_trigger_inbox'))throw Error('injected failure');return query(sql,args);}))});
  await assert.rejects(failing.enqueue({...scope,agentId:'rollback'},event,options),/injected failure/);const after=await a.query("SELECT count(*)::int AS n FROM app_mixer_shared_runs WHERE agent_id='rollback'");assert.equal(after.rows[0].n,0);
  await assert.rejects(first.enqueue(scope,event,{...options,deadline:1}),/Invalid trigger/);
 }finally{await a.end();await b.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end();}
});
