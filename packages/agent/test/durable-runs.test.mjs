import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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
