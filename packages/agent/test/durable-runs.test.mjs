import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {SqliteAgentRuns} from '../dist/index.js';
const scope={tenantId:'tenant',agentId:'agent'},config={definitionVersion:3,maxAttempts:2,deadline:1000};

test('durable runs support cooperative pause, resume, cancel and archive',()=>{
 const store=new SqliteAgentRuns(':memory:');try{
  let run=store.create(scope,'one',config,10);assert.equal(run.status,'queued');assert.throws(()=>store.create(scope,'one',config,10),/already exists/);
  run=store.claim(scope,'one',run.revision,'worker',100,20);const token=run.leaseToken;assert.equal(run.attempts,1);
  run=store.request(scope,'one',run.revision,'pause');assert.equal(run.status,'pause_requested');assert.throws(()=>store.renew(scope,'one',run.revision,token,100,21),/cannot be renewed/);
  run=store.settle(scope,'one',run.revision,token,'stopped',21);assert.equal(run.status,'paused');run=store.request(scope,'one',run.revision,'resume',21);run=store.claim(scope,'one',run.revision,'worker',100,22);
  run=store.request(scope,'one',run.revision,'cancel');assert.equal(run.status,'cancel_requested');run=store.settle(scope,'one',run.revision,run.leaseToken,'stopped',23);assert.equal(run.status,'cancelled');run=store.archive(scope,'one',run.revision);assert.equal(run.archived,true);assert.equal(store.list(scope).length,0);assert.equal(store.list(scope,{includeArchived:true})[0].runId,'one');assert.throws(()=>store.request(scope,'one',run.revision,'resume'),/archived/);
 }finally{store.close();}
});

test('expired worker leases become uncertain and stale workers are fenced',()=>{
 const store=new SqliteAgentRuns(':memory:');try{
  let run=store.create(scope,'one',config,10);run=store.claim(scope,'one',run.revision,'worker-a',20,20);const token=run.leaseToken,revision=run.revision;
  assert.throws(()=>store.recoverExpired(scope,'one',revision,39),/active/);assert.throws(()=>store.settle(scope,'one',revision,token,'succeeded',40),/expired/);
  run=store.recoverExpired(scope,'one',revision,40);assert.equal(run.status,'uncertain');assert.throws(()=>store.claim(scope,'one',run.revision,'worker-b',20,41),/cannot be claimed/);
  run=store.reconcile(scope,'one',run.revision,'retry',41);run=store.claim(scope,'one',run.revision,'worker-b',20,42);assert.notEqual(run.leaseToken,token);assert.throws(()=>store.settle(scope,'one',run.revision,token,'succeeded',43),/lease/);
  run=store.recoverExpired(scope,'one',run.revision,62);assert.throws(()=>store.reconcile(scope,'one',run.revision,'retry',63),/cannot be retried/);run=store.reconcile(scope,'one',run.revision,'failed',63);assert.equal(run.status,'failed');
 }finally{store.close();}
});

test('SQLite runs persist and competing connections cannot claim or mutate the same revision',()=>{
 const dir=mkdtempSync(join(tmpdir(),'app-mixer-runs-')),path=join(dir,'runs.sqlite');let a,b;
 try{a=new SqliteAgentRuns(path);b=new SqliteAgentRuns(path);let run=a.create(scope,'one',config,10);assert.equal(b.get({...scope,tenantId:'other'},'one'),undefined);run=a.claim(scope,'one',run.revision,'worker-a',20,20);assert.throws(()=>b.claim(scope,'one',1,'worker-b',20,20),/revision conflict/);a.close();a=undefined;b.close();b=undefined;
  a=new SqliteAgentRuns(path);assert.equal(a.get(scope,'one').leaseOwner,'worker-a');run=a.recoverExpired(scope,'one',run.revision,40);assert.equal(run.status,'uncertain');
 }finally{a?.close();b?.close();rmSync(dir,{recursive:true,force:true});}
});

test('deadlines, tokens and invalid lifecycle transitions fail closed',()=>{
 const store=new SqliteAgentRuns(':memory:');try{
  let run=store.create(scope,'one',config,10);assert.throws(()=>store.claim(scope,'one',run.revision,'worker',20,1000),/cannot be claimed/);run=store.claim(scope,'one',run.revision,'worker',30,970);assert.equal(run.leaseUntil,1000);
  assert.throws(()=>store.settle(scope,'one',run.revision,'incorrect','succeeded',971),/lease/);assert.throws(()=>store.settle(scope,'one',run.revision,run.leaseToken,'stopped',971),/state/);
  run=store.recoverExpired(scope,'one',run.revision,1000);assert.throws(()=>store.reconcile(scope,'one',run.revision,'retry',1000),/retried/);assert.throws(()=>store.archive(scope,'one',run.revision),/state/);
 }finally{store.close();}
});

test('run-start history is pruned by age and daily quotas keep counting the current day',()=>{
 const dir=mkdtempSync(join(tmpdir(),'run-starts-')),path=join(dir,'runs.sqlite'),store=new SqliteAgentRuns(path),DAY=86400000;
 try{
  const scope={tenantId:'tenant',agentId:'agent'},DAY0=10*DAY;
  for(const [id,at] of [['old',DAY0-3*DAY],['recent',DAY0-DAY/2],['today',DAY0+1000]]){const run=store.create(scope,id,{definitionVersion:1,maxAttempts:3,deadline:DAY0+DAY},0);const claimed=store.claim(scope,id,run.revision,'worker',1000,at,3,10);store.settle(scope,id,claimed.revision,claimed.leaseToken,'succeeded',at+1);}
  for(const bad of [0,-1,3661,1.5,'1'])assert.throws(()=>store.pruneStarts(bad,DAY0),/Invalid retention/);
  assert.throws(()=>store.pruneStarts(1,-1),/Invalid retention/);
  assert.equal(store.pruneStarts(2,DAY0+2000),1,'only the three-day-old record is older than two days');
  assert.equal(store.pruneStarts(2,DAY0+2000),0);
  assert.equal(store.pruneStarts(1,DAY0+DAY/2+1),1,'the half-day-old record is older than a day half a day later');
  const next=store.create(scope,'next',{definitionVersion:1,maxAttempts:3,deadline:DAY0+DAY},0);
  // One start remains today ("today"); with a limit of two a second run still starts and a third is refused.
  const started=store.claim(scope,'next',next.revision,'worker',1000,DAY0+3000,3,2);assert.equal(started.status,'running');store.settle(scope,'next',started.revision,started.leaseToken,'succeeded',DAY0+3500);
  const third=store.create(scope,'third',{definitionVersion:1,maxAttempts:3,deadline:DAY0+DAY},0);assert.throws(()=>store.claim(scope,'third',third.revision,'worker',1000,DAY0+4000,3,2),/limit|daily/i);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('queued runs are dispatched in creation order, not run ID order, and databases from before the sequence column keep their row order',()=>{
 const dir=mkdtempSync(join(tmpdir(),'run-order-')),path=join(dir,'runs.sqlite');let store;
 try{
  store=new SqliteAgentRuns(path);
  // Run IDs sorted opposite to creation order, as random UUIDs are.
  const ids=Array.from({length:50},(_,n)=>'run-'+String(99-n).padStart(2,'0'));
  for(const runId of ids)store.create(scope,runId,config,0);
  const collect=limit=>{const seen=[];let after;do{const page=store.queuedPage(scope,{limit,...(after?{after}:{})});seen.push(...page.runIds);after=page.next;}while(after);return seen;};
  assert.deepEqual(collect(7),ids,'pages of seven return the runs oldest first');assert.deepEqual(collect(100),ids);
  // A claimed run leaves the queue and the order of the rest is unchanged.
  const first=store.get(scope,ids[0]);store.claim(scope,ids[0],first.revision,'worker',1000,10);assert.deepEqual(collect(10),ids.slice(1));
  assert.equal(store.queuedPage(scope,{after:'unknown-run'}).runIds[0],ids[1],'an unknown cursor starts from the beginning');
  store.close();store=undefined;
  // A database written before created_seq existed: rows keep their insertion order after the migration.
  const old=join(dir,'old.sqlite'),legacy=new DatabaseSync(old);
  legacy.exec("CREATE TABLE agent_runs (tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,run_id TEXT NOT NULL,definition_version INTEGER NOT NULL,revision INTEGER NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL,max_attempts INTEGER NOT NULL,deadline INTEGER NOT NULL,lease_owner TEXT,lease_token TEXT,lease_until INTEGER,archived INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(tenant_id,agent_id,run_id))");
  for(const runId of ['zulu','alpha','mike'])legacy.prepare("INSERT INTO agent_runs VALUES (?,?,?,1,1,'queued',0,2,1000,NULL,NULL,NULL,0)").run('tenant','agent',runId);
  legacy.close();
  store=new SqliteAgentRuns(old);assert.deepEqual(store.queuedPage(scope).runIds,['zulu','alpha','mike']);
  store.create(scope,'bravo',config,0);assert.deepEqual(store.queuedPage(scope).runIds,['zulu','alpha','mike','bravo'],'new runs follow the migrated ones');
 }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});

test('resuming a paused run that has used all its attempts says so instead of reporting a retryable race',()=>{
 // A run paused for approval or delegation after its last attempt started has attempts equal to maxAttempts; the pause is put in place directly here.
 const dir=mkdtempSync(join(tmpdir(),'durable-runs-exhausted-')),path=join(dir,'db.sqlite'),store=new SqliteAgentRuns(path);let db;
 try{
  let run=store.create(scope,'one',{definitionVersion:1,maxAttempts:1,deadline:1000},10);
  run=store.claim(scope,'one',run.revision,'worker',100,20);assert.equal(run.attempts,1);
  db=new DatabaseSync(path);db.prepare("UPDATE agent_runs SET status='paused',lease_token=NULL,lease_until=NULL,lease_owner=NULL WHERE run_id='one'").run();
  run=store.get(scope,'one');assert.equal(run.status,'paused');assert.equal(run.attempts,run.maxAttempts);
  assert.throws(()=>store.request(scope,'one',run.revision,'resume',22),error=>error.name==='AgentError'&&error.code==='conflict'&&/attempts exhausted/.test(error.message),'a non-retryable conflict that names the cause');
  // A stale revision is still the retryable race it always was.
  assert.throws(()=>store.request(scope,'one',run.revision-1,'resume',22),error=>error.code==='lost_race');
  assert.equal(store.get(scope,'one').status,'paused','the run is left as it was');
 }finally{db?.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
