// A run registry and action journal shared by separate processes through PostgreSQL. Workers killed mid-dispatch
// leave runs that the surviving nodes recover exactly once, verifying each interrupted action against the external
// system instead of replaying it, so no external effect is duplicated.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {PostgresAgentRuns,PostgresAgentSchedules} from '../dist/index.js';

const url=process.env.APP_MIXER_TEST_POSTGRES_URL,nodePath=fileURLToPath(new URL('./fixtures/run-node.mjs',import.meta.url));
const scope={tenantId:'tenant',agentId:'agent'},skip=!url&&'set APP_MIXER_TEST_POSTGRES_URL to run against PostgreSQL';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const transaction=pool=>async operation=>{const client=await pool.connect();try{await client.query('BEGIN');const result=await operation((sql,args)=>client.query(sql,args));await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}};
async function database(prefix){
 const schema=prefix+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:url}),pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
 await admin.query(`CREATE SCHEMA "${schema}"`);
 const options={enabled:true,query:(sql,args)=>pool.query(sql,args),transaction:transaction(pool)};
 return {schema,pool,options,close:async()=>{await pool.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(()=>{});await admin.end();}};
}

test('the shared PostgreSQL run registry keeps the SQLite lifecycle, limits and lease fencing',{skip,timeout:60000},async()=>{
 const db=await database('runs_');
 try{
  assert.throws(()=>new PostgresAgentRuns({enabled:true,query:()=>{}}),/Invalid agent run registry configuration/);
  const runs=new PostgresAgentRuns(db.options);await runs.initialize();await runs.initialize();
  const deadline=Date.now()+600000,config={definitionVersion:1,maxAttempts:2,deadline};
  await assert.rejects(runs.create(scope,'past',{...config,deadline:1}),/Invalid run configuration/);
  const created=await runs.create(scope,'r1',config);assert.deepEqual([created.status,created.revision,created.attempts],['queued',1,0]);
  await assert.rejects(runs.create(scope,'r1',config),/Run already exists/);
  await runs.create(scope,'r2',config);await runs.create(scope,'r3',config);
  await assert.rejects(runs.claim(scope,'r1',2,'w',1000),/revision conflict/);
  const lease=await runs.claim(scope,'r1',1,'w',1000,{maxRunsPerDay:2});assert.equal(lease.status,'running');assert.equal(lease.attempts,1);
  await assert.rejects(runs.claim(scope,'r2',1,'w',1000,{maxRunsPerDay:2}),/concurrency limit/,'one active run by default');
  const second=await runs.claim(scope,'r2',1,'w',1000,{maxConcurrentRuns:3,maxRunsPerDay:2});
  await assert.rejects(runs.claim(scope,'r3',1,'w',1000,{maxConcurrentRuns:3,maxRunsPerDay:2}),/daily run limit/);
  // The journal is fenced on the live lease: a wrong token cannot dispatch, a renewed lease still can.
  let calls=0;const dispatch=async(input,key)=>{calls++;return {ok:input.n,key};};
  await assert.rejects(runs.journal(scope,'r1',randomUUID()).invoke('x','op',{n:1},2,dispatch),/Action lease unavailable/);
  const renewed=await runs.renew(scope,'r1',lease.revision,lease.leaseToken,1000);
  const journal=runs.journal(scope,'r1',lease.leaseToken),first=await journal.invoke('x','op',{n:1},2,dispatch);
  assert.deepEqual(await journal.invoke('x','op',{n:1},2,dispatch),first);assert.equal(calls,1,'a recorded result is not dispatched again');
  await assert.rejects(journal.invoke('x','op',{n:2},2,dispatch),/identity conflict/);
  await assert.rejects(journal.invoke('y','op',{},2,async()=>{throw Error('network');}),/Action outcome uncertain/);
  await assert.rejects(journal.invoke('y','op',{},2,dispatch),/requires reconciliation/);
  // Settling with an unresolved action makes the run uncertain; it cannot be retried until the action is decided.
  const uncertain=await runs.settle(scope,'r1',renewed.revision,lease.leaseToken,'succeeded');assert.equal(uncertain.status,'uncertain');
  await assert.rejects(journal.invoke('z','op',{},2,dispatch),/Action lease unavailable/,'a released lease fences the old worker');
  await assert.rejects(runs.reconcile(scope,'r1',uncertain.revision,'retry'),/requires reconciliation/);
  const recovery=runs.journal(scope,'r1','recovery');assert.deepEqual((await recovery.unresolved()).map(action=>[action.actionId,action.status]),[['y','uncertain']]);
  await assert.rejects(recovery.reconcileWith('y',async()=>({outcome:'applied'})),/Invalid action verification/);
  assert.equal(await recovery.reconcileWith('y',async()=>({outcome:'not_applied'})),'not_applied');
  const retried=await runs.reconcile(scope,'r1',uncertain.revision,'retry');assert.equal(retried.status,'queued');
  const again=await runs.claim(scope,'r1',retried.revision,'w',1000,{maxConcurrentRuns:3,maxRunsPerDay:2});assert.equal(again.attempts,2,'a retry is not a new run for the daily limit');
  const lost=await runs.settle(scope,'r1',again.revision,again.leaseToken,'uncertain');assert.equal(lost.status,'uncertain');
  await assert.rejects(runs.reconcile(scope,'r1',lost.revision,'retry'),/cannot be retried/,'attempts are bounded');
  // Pause, cancel and archive; an expired lease is recovered once.
  const pausing=await runs.request(scope,'r2',second.revision,'pause');assert.equal(pausing.status,'pause_requested');
  const paused=await runs.settle(scope,'r2',pausing.revision,second.leaseToken,'stopped');assert.equal(paused.status,'paused');
  const cancelled=await runs.request(scope,'r2',paused.revision,'cancel');assert.equal(cancelled.status,'cancelled');
  assert.equal((await runs.archive(scope,'r2',cancelled.revision)).archived,true);await assert.rejects(runs.archive(scope,'r2',cancelled.revision+1),/archived/);
  await runs.create(scope,'r4',config);const short=await runs.claim(scope,'r4',1,'w',50,{maxConcurrentRuns:3});
  await assert.rejects(runs.recoverExpired(scope,'r4',short.revision),/Lease is active/);await sleep(120);
  assert.deepEqual((await runs.expiredLeases(scope)).map(run=>run.runId),['r4']);
  await assert.rejects(runs.renew(scope,'r4',short.revision,short.leaseToken,1000),/expired lease/);
  const recovered=await runs.recoverExpired(scope,'r4',short.revision);assert.equal(recovered.status,'uncertain');
  await assert.rejects(runs.recoverExpired(scope,'r4',short.revision),/revision conflict/,'a second node cannot recover it again');
  assert.equal((await runs.get({tenantId:'other',agentId:'agent'},'r4')),undefined,'runs are tenant-scoped');
  // A schedule hand-off taken over after an expired claim creates the run only once.
  const schedules=new PostgresAgentSchedules(db.options);await schedules.initialize();
  await schedules.save(scope,'tick',{enabled:true,principalId:'service',rule:{kind:'interval',intervalMs:60000}},0,1000);
  await schedules.fire(scope,'tick',1,{definitionVersion:1,maxAttempts:2,runTimeoutMs:60000,maxPending:10},{now:61000,nodeId:'n'});
  const stale=await schedules.claimRun(scope,'node-a',50);await runs.create(scope,stale.runId,config);await sleep(120);
  const takeover=await schedules.claimRun(scope,'node-b',1000);assert.equal(takeover.runId,stale.runId);
  await assert.rejects(runs.create(scope,takeover.runId,config),/Run already exists/,'the reclaimed request does not start a second run');
  assert.equal(await schedules.markStarted(scope,takeover.runId,takeover.token),true);
 }finally{await db.close();}
});

test('runs on killed nodes are recovered exactly once with no duplicated external effect',{skip,timeout:120000},async t=>{
 const db=await database('run_nodes_'),nodes=new Map(),events=[],applications=[],effects=new Map(),held=new Map();
 // The external system applies every POST it receives (no deduplication), so a replayed action would show twice.
 const server=createServer(async(request,response)=>{
  const key=decodeURIComponent(request.url.slice('/effects/'.length));
  if(request.method==='GET'){const effect=effects.get(key);response.writeHead(effect?200:404,{'content-type':'application/json'}).end(JSON.stringify(effect??{}));return;}
  let body='';for await(const chunk of request)body+=chunk;const input=JSON.parse(body),node=request.headers['x-node'];
  const apply=()=>{const effect={applied:true,runId:input.runId,actionId:input.actionId};applications.push({key,...input});effects.set(key,effect);return effect;};
  // node-a's first request is applied but the reply never arrives; node-b's first request never gets applied.
  if((node==='node-a'||node==='node-b')&&!held.has(node)){if(node==='node-a')apply();held.set(node,input);request.socket.on('error',()=>{});return;}
  response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(apply()));
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');const effectsUrl=`http://127.0.0.1:${server.address().port}`;
 const start=(nodeId,concurrency='4')=>{const child=fork(nodePath,[url,db.schema,nodeId,effectsUrl,concurrency],{stdio:['ignore','inherit','inherit','ipc']});nodes.set(nodeId,child);child.on('message',message=>events.push({nodeId,...message}));return new Promise((resolve,reject)=>{child.on('message',message=>{if(message.type==='ready')resolve();});child.once('exit',code=>reject(Error(nodeId+' exited '+code)));});};
 try{
  const runs=new PostgresAgentRuns(db.options);await runs.initialize();
  const ids=['run-1','run-2','run-3','run-4','run-5','run-6'];for(const runId of ids)await runs.create(scope,runId,{definitionVersion:1,maxAttempts:3,deadline:Date.now()+600000});
  await Promise.all([start('node-a','1'),start('node-b','1')]);
  for(const deadline=Date.now()+20000;held.size<2;await sleep(20))assert.ok(Date.now()<deadline,'both workers reached their first dispatch');
  for(const nodeId of ['node-a','node-b']){const child=nodes.get(nodeId),gone=once(child,'exit');child.kill('SIGKILL');await gone;}
  t.diagnostic(`killed node-a mid-dispatch of ${JSON.stringify(held.get('node-a'))} (applied) and node-b of ${JSON.stringify(held.get('node-b'))} (not applied)`);
  await Promise.all([start('node-c'),start('node-d')]);
  for(const deadline=Date.now()+40000;;await sleep(100)){
   const all=await Promise.all(ids.map(runId=>runs.get(scope,runId)));if(all.every(run=>run.status==='succeeded'))break;
   assert.ok(Date.now()<deadline,'all runs finish: '+all.map(run=>run.runId+'='+run.status).join(' '));
  }
  for(const nodeId of ['node-c','node-d']){const child=nodes.get(nodeId),gone=once(child,'exit');child.send('stop');const [code]=await gone;assert.equal(code,0,nodeId+' stopped cleanly');}
  assert.deepEqual(events.filter(event=>event.type==='error'),[],'the surviving supervisors reported no errors');
  const killedRuns=[held.get('node-a').runId,held.get('node-b').runId].sort();
  // Each killed run was recovered exactly once, by one of the surviving nodes, and retried once.
  const recoveries=events.filter(event=>event.type==='recovered');
  assert.deepEqual(recoveries.map(event=>event.runId).sort(),killedRuns,'each interrupted run recovered exactly once');
  assert.ok(recoveries.every(event=>['node-c','node-d'].includes(event.nodeId)));
  for(const runId of ids){const run=await runs.get(scope,runId);assert.equal(run.attempts,killedRuns.includes(runId)?2:1,runId+' attempts');}
  // The interrupted actions were verified, not replayed blindly: the applied one is reused, the other dispatched once.
  const reconciled=events.filter(event=>event.type==='reconciled').map(event=>[event.runId,event.actionId,event.outcome]).sort();
  assert.deepEqual(reconciled,[[held.get('node-a').runId,held.get('node-a').actionId,'applied'],[held.get('node-b').runId,held.get('node-b').actionId,'not_applied']].sort());
  // Every action of every run took effect exactly once, under one idempotency key.
  assert.equal(applications.length,ids.length*3,'no duplicated external effect');
  assert.deepEqual(new Set(applications.map(effect=>effect.runId+'/'+effect.actionId)).size,ids.length*3);
  assert.equal(new Set(applications.map(effect=>effect.key)).size,ids.length*3);
  const completed=events.filter(event=>event.type==='completed');assert.deepEqual(completed.map(event=>event.runId).sort(),[...ids].sort(),'each run completed once');
  t.diagnostic(`${ids.length} runs, ${applications.length} external effects, each once; recovered ${killedRuns.join(', ')} by ${recoveries.map(event=>event.nodeId).join(', ')}`);
 }finally{for(const child of nodes.values())if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');server.closeAllConnections();server.close();await db.close();}
});

test('a stopping worker drains its running executions and claims nothing new',{skip,timeout:60000},async()=>{
 const db=await database('run_drain_'),held=[],applications=[],events=[];let child;
 // Every first action is held until the test releases it, so the worker is mid-run when it is told to stop.
 const server=createServer(async(request,response)=>{
  let body='';for await(const chunk of request)body+=chunk;const input=JSON.parse(body);applications.push(input);
  const reply=()=>response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({applied:true,...input}));
  if(input.actionId==='a1')held.push(reply);else reply();
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  const runs=new PostgresAgentRuns(db.options);await runs.initialize();
  const ids=['run-1','run-2','run-3','run-4'];for(const runId of ids)await runs.create(scope,runId,{definitionVersion:1,maxAttempts:3,deadline:Date.now()+600000});
  child=fork(nodePath,[url,db.schema,'drainer',`http://127.0.0.1:${server.address().port}`,'2'],{stdio:['ignore','inherit','inherit','ipc']});child.on('message',message=>events.push(message));
  for(const deadline=Date.now()+20000;held.length<2;await sleep(20))assert.ok(Date.now()<deadline,'two runs in flight');
  const exited=once(child,'exit');child.send('stop');await sleep(500);
  assert.equal(child.exitCode,null,'the worker waits for its running executions');
  for(const reply of held.splice(0))reply();const [code]=await exited;assert.equal(code,0);
  const final=await Promise.all(ids.map(runId=>runs.get(scope,runId)));
  assert.deepEqual(final.map(run=>run.status).sort(),['queued','queued','succeeded','succeeded'],'in-flight runs finished; no new run was claimed');
  assert.equal(events.filter(event=>event.type==='claimed').length,2);assert.equal(events.filter(event=>event.type==='error').length,0);
  assert.equal(applications.length,6,'each finished run applied its three actions once');
 }finally{if(child&&child.exitCode===null)child.kill('SIGKILL');server.closeAllConnections();server.close();await db.close();}
});
