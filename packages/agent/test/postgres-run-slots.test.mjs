import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {SqliteAgentRuns,SqliteAgentDefinitions,DurableAgentWorker,PostgresAgentRunSlots} from '../dist/index.js';

const scope={tenantId:'t',agentId:'agent'},manifest={manifestVersion:1,tenantId:'t',agentId:'agent',name:'Operations',owner:{kind:'organization',id:'org'},administrators:['admin'],servicePrincipalId:'service',model:{provider:'local',model:'test'},allowedCapabilities:[],lifecycle:{enabled:true,maxAttempts:3,runTimeoutMs:10000},quotas:{maxConcurrentRuns:1,maxTokensPerRun:1000,maxRunsPerDay:2}};
const transaction=pool=>async operation=>{const client=await pool.connect();try{await client.query('BEGIN');const result=await operation((sql,args)=>client.query(sql,args));await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}};
const node=(slots,workerId,execute)=>{const runs=new SqliteAgentRuns(':memory:'),definitions=new SqliteAgentDefinitions(':memory:');definitions.save('t',manifest,0);return {runs,definitions,worker:new DurableAgentWorker({runs,definitions,workerId,leaseMs:400,pollMs:25,authorizeStart:()=>true,execute,sharedSlots:slots}),add:runId=>runs.create(scope,runId,{definitionVersion:1,maxAttempts:3,deadline:Date.now()+60000})};};

test('shared PostgreSQL slots enforce agent quotas across separate worker registries',{skip:!process.env.APP_MIXER_TEST_POSTGRES_URL,timeout:30000},async()=>{
 const schema='run_slots_'+randomUUID().replaceAll('-',''),url=process.env.APP_MIXER_TEST_POSTGRES_URL,admin=new pg.Pool({connectionString:url}),pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
 try{
  await admin.query(`CREATE SCHEMA "${schema}"`);assert.throws(()=>new PostgresAgentRunSlots({enabled:true,query:()=>{}}),/Invalid agent run slot configuration/);
  const slots=new PostgresAgentRunSlots({enabled:true,query:(sql,args)=>pool.query(sql,args),transaction:transaction(pool)});await slots.initialize();await slots.initialize();
  assert.throws(()=>new DurableAgentWorker({runs:new SqliteAgentRuns(':memory:'),definitions:{get:()=>undefined},workerId:'w',leaseMs:400,pollMs:25,authorizeStart:()=>true,execute:async()=>'succeeded',sharedSlots:{}}),/Invalid agent worker/);
  let entered,release;const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  const a=node(slots,'node-a',async()=>{entered();await gate;return 'succeeded';}),b=node(slots,'node-b',async()=>'succeeded');a.add('one');b.add('two');
  const pending=a.worker.runOnce(scope,'one');await started;assert.equal(await slots.active(scope),1);
  await assert.rejects(b.worker.runOnce(scope,'two'),/Agent run quota exceeded/);assert.equal(b.runs.get(scope,'two').status,'queued');
  await new Promise(resolve=>setTimeout(resolve,600));assert.equal(await slots.active(scope),1,'renewal keeps the slot past its first lease');
  release();assert.equal((await pending).status,'succeeded');assert.equal(await slots.active(scope),0);
  assert.equal((await b.worker.runOnce(scope,'two')).status,'succeeded');
  a.add('three');await assert.rejects(a.worker.runOnce(scope,'three'),/Agent run quota exceeded/);assert.equal(a.runs.get(scope,'three').status,'queued');
  // A retry of a run already counted today does not consume another daily slot.
  assert.equal(typeof await slots.acquire(scope,'one','node-a',200,{maxConcurrentRuns:1,maxRunsPerDay:2}),'string');await assert.rejects(slots.acquire(scope,'four','node-b',200,{maxConcurrentRuns:5,maxRunsPerDay:2}),/quota exceeded/);
  await assert.rejects(slots.acquire(scope,'one','node-b',200,{maxConcurrentRuns:5}),/slot held/);
  await new Promise(resolve=>setTimeout(resolve,300));assert.equal(await slots.active(scope),0);const token=await slots.acquire(scope,'five','node-b',200,{maxConcurrentRuns:1});
  assert.equal(await slots.renew(scope,'five',randomUUID(),200),false);assert.equal(await slots.renew(scope,'five',token,200),true);await slots.release(scope,'five',token);assert.equal(await slots.active(scope),0);
  assert.equal(typeof await slots.acquire({tenantId:'other',agentId:'agent'},'one','node-a',200,{maxConcurrentRuns:1,maxRunsPerDay:1}),'string');
  // Losing the shared slot mid-run aborts execution; the host's result for an aborted run is classified as uncertain.
  let aborted;const c=node(slots,'node-c',async(run,{signal})=>{await pool.query('DELETE FROM app_mixer_agent_run_slots WHERE run_id=$1',['six']);await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));aborted=true;return 'uncertain';});
  await pool.query('DELETE FROM app_mixer_agent_run_starts');c.add('six');assert.equal((await c.worker.runOnce(scope,'six')).status,'uncertain');assert.equal(aborted,true);assert.equal(await slots.active(scope),0);
  for(const bad of [[scope,'x','w',0,{maxConcurrentRuns:1}],[scope,'x','w',100,{maxConcurrentRuns:0}],[{tenantId:'../t',agentId:'a'},'x','w',100,{maxConcurrentRuns:1}]])await assert.rejects(slots.acquire(...bad),/Invalid/);
  assert.ok(await slots.pruneStarts(1)>=0);
 }finally{await pool.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end();}
});
