// Two separate processes, each with its own PostgreSQL pool, poll the same shared schedules. One is killed partway
// through. Every occurrence is fired exactly once with no gaps, and every run request is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {PostgresAgentSchedules} from '../dist/index.js';

const url=process.env.APP_MIXER_TEST_POSTGRES_URL,nodePath=fileURLToPath(new URL('./fixtures/schedule-node.mjs',import.meta.url));
const scope={tenantId:'tenant',agentId:'agent'},policy={definitionVersion:1,maxAttempts:3,runTimeoutMs:60000,maxPending:10000};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const transaction=pool=>async operation=>{const client=await pool.connect();try{await client.query('BEGIN');const result=await operation((sql,args)=>client.query(sql,args));await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}};

test('shared PostgreSQL schedules validate input and fire each occurrence once with history',{skip:!url&&'set APP_MIXER_TEST_POSTGRES_URL to run against PostgreSQL',timeout:60000},async()=>{
 const schema='schedules_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:url}),pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
 try{
  await admin.query(`CREATE SCHEMA "${schema}"`);assert.throws(()=>new PostgresAgentSchedules({enabled:true,query:()=>{}}),/Invalid agent schedule configuration/);
  const schedules=new PostgresAgentSchedules({enabled:true,query:(sql,args)=>pool.query(sql,args),transaction:transaction(pool)});await schedules.initialize();await schedules.initialize();
  const config={enabled:true,principalId:'service',rule:{kind:'interval',intervalMs:60000}};
  await assert.rejects(schedules.save(scope,'daily',{...config,rule:{kind:'interval',intervalMs:10}},0,1000),/Invalid schedule/);
  const saved=await schedules.save(scope,'daily',config,0,1000,'admin');assert.deepEqual({revision:saved.revision,generation:saved.generation,nextAt:saved.nextAt},{revision:1,generation:1,nextAt:61000});
  await assert.rejects(schedules.save(scope,'daily',config,0,1000),/revision conflict/);
  await assert.rejects(schedules.fire(scope,'daily',1,policy,{now:60999,nodeId:'n'}),/not due/);
  const first=await schedules.fire(scope,'daily',1,policy,{now:61000,nodeId:'n',actorId:'admin'});assert.equal(first.scheduledAt,61000);
  await assert.rejects(schedules.fire(scope,'daily',1,policy,{now:61000,nodeId:'other'}),/revision conflict/,'a second node firing the same revision loses');
  // Catch-up fires each missed occurrence in order; coalesce would fire once.
  const late=await schedules.fire(scope,'daily',2,policy,{now:250000,nodeId:'n'}),later=await schedules.fire(scope,'daily',3,policy,{now:250000,nodeId:'n'});
  assert.deepEqual([late.scheduledAt,later.scheduledAt],[121000,181000]);
  assert.deepEqual((await schedules.runs(scope,'daily')).map(run=>[run.scheduledAt,run.status,run.firedBy]),[[61000,'pending','n'],[121000,'pending','n'],[181000,'pending','n']]);
  await assert.rejects(schedules.fire(scope,'daily',4,{...policy,maxPending:3},{now:250000,nodeId:'n'}),/backlog full/);
  const claim=await schedules.claimRun(scope,'worker',1000);assert.equal(claim.runId,first.runId);assert.equal(claim.claims,1);
  assert.equal(await schedules.markStarted(scope,claim.runId,randomUUID()),false);assert.equal(await schedules.markStarted(scope,claim.runId,claim.token),true);assert.equal(await schedules.markStarted(scope,claim.runId,claim.token),false);
  // An expired claim is taken over; the first holder can then no longer mark it started.
  const stale=await schedules.claimRun(scope,'slow-worker',50);await new Promise(resolve=>setTimeout(resolve,120));
  const takeover=await schedules.claimRun(scope,'other-worker',1000);assert.equal(takeover.runId,stale.runId);assert.equal(takeover.claims,2);
  assert.equal(await schedules.markStarted(scope,stale.runId,stale.token),false);assert.equal(await schedules.markStarted(scope,takeover.runId,takeover.token),true);
  // A new generation keeps old occurrences and restarts the series.
  const updated=await schedules.save(scope,'daily',{...config,misfire:'coalesce'},4,300000,'admin');assert.equal(updated.generation,2);
  const coalesced=await schedules.fire(scope,'daily',5,policy,{now:600000,nodeId:'n'});assert.equal(coalesced.scheduledAt,360000);assert.equal((await schedules.get(scope,'daily')).nextAt,660000);
  assert.deepEqual((await schedules.history(scope,'daily')).map(event=>event.kind),['created','fired','fired','fired','updated','fired']);
  assert.equal((await schedules.duePage({tenantId:'other',agentId:'agent'},600000)).items.length,0,'schedules are tenant-scoped');
 }finally{await pool.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(()=>{});await admin.end();}
});

test('two nodes sharing PostgreSQL schedules fire each occurrence once, survive a node kill and start every run',{skip:!url&&'set APP_MIXER_TEST_POSTGRES_URL to run against PostgreSQL',timeout:120000},async t=>{
 const schema='schedule_nodes_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:url}),pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`}),nodes=new Map(),totals=new Map(),claimed=new Map();
 try{
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const schedules=new PostgresAgentSchedules({enabled:true,query:(sql,args)=>pool.query(sql,args),transaction:transaction(pool)});await schedules.initialize();
  const ids=['alpha','beta','gamma','delta'];for(const id of ids)await schedules.save(scope,id,{enabled:true,principalId:'service',rule:{kind:'interval',intervalMs:1000}},0);
  const starts=new Map(await Promise.all(ids.map(async id=>[id,(await schedules.get(scope,id)).nextAt])));
  for(const nodeId of ['node-a','node-b']){
   const child=fork(nodePath,[url,schema,nodeId],{stdio:['ignore','inherit','inherit','ipc']});nodes.set(nodeId,child);
   child.on('message',message=>{if(message.type==='totals')totals.set(nodeId,message);if(message.type==='claimed')claimed.set(message.runId,[...(claimed.get(message.runId)??[]),nodeId]);});
  }
  await Promise.all([...nodes.values()].map(child=>new Promise((resolve,reject)=>{const listener=message=>{if(message.type==='ready'){child.off('message',listener);resolve();}};child.on('message',listener);child.once('exit',code=>reject(Error('node exited '+code)));})));
  await sleep(3500);
  // Kill node-a without warning; node-b must keep every schedule firing on time and pick up any claim it left.
  const killed=nodes.get('node-a'),gone=once(killed,'exit');killed.kill('SIGKILL');await gone;t.diagnostic('killed node-a after '+JSON.stringify(totals.get('node-a')));
  await sleep(4500);
  const survivor=nodes.get('node-b'),done=once(survivor,'exit');survivor.send('stop');await done;
  // Drain run requests left by the end of the run (the survivor stopped mid-cycle), then audit every schedule.
  for(let claim;(claim=await schedules.claimRun(scope,'auditor',1500));)assert.equal(await schedules.markStarted(scope,claim.runId,claim.token),true);
  let total=0,reclaimed=0;const firedBy=new Set();
  for(const id of ids){
   const runs=await schedules.runs(scope,id,{limit:1000}),expected=runs.map((_,i)=>starts.get(id)+i*1000);
   assert.deepEqual(runs.map(run=>run.scheduledAt),expected,id+': one occurrence per second, none missing or repeated');
   assert.ok(runs.length>=6,id+' fired '+runs.length+' times');
   assert.equal(new Set(runs.map(run=>run.runId)).size,runs.length);
   const fired=(await schedules.history(scope,id,{limit:1000})).filter(event=>event.kind==='fired');assert.deepEqual(fired.map(event=>event.runId),runs.map(run=>run.runId),id+': history matches');
   for(const run of runs){assert.equal(run.status,'started');assert.ok(run.claims===1||run.claims===2);if(run.claims===2)reclaimed++;firedBy.add(run.firedBy);}
   total+=runs.length;
  }
  assert.ok(reclaimed<=1,'only a claim held by the killed node is taken over: '+reclaimed);
  assert.deepEqual([...firedBy].sort(),['node-a','node-b'],'both nodes fired occurrences');
  const conflicts=[...totals.values()].reduce((sum,value)=>sum+value.conflicts,0);
  for(const [runId,by] of claimed)assert.ok(by.length===1||(by.length===2&&by[0]==='node-a'),runId+' claimed by '+by.join(','));
  t.diagnostic(`${total} occurrences across ${ids.length} schedules, each fired once; nodes lost ${conflicts} firing races; ${reclaimed} claim taken over after the kill`);
 }finally{for(const child of nodes.values())if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await pool.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(()=>{});await admin.end();}
});
