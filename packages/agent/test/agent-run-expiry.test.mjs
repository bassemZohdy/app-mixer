import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {SqliteAgentRuns,AgentRunExpiryWorker,SqliteAgentRunHistory,SqliteAgentExpiryHistory} from '../dist/index.js';
const scope={tenantId:'tenant',agentId:'agent'},conf={definitionVersion:1,maxAttempts:2,deadline:100};
function setup(){const dir=mkdtempSync(join(tmpdir(),'agent-expiry-')),path=join(dir,'test.db'),runs=new SqliteAgentRuns(path);return {dir,path,runs};}
function close(s){s.runs.close();rmSync(s.dir,{recursive:true,force:true});}

test('expired unleased runs are paged by deadline and fail with lifecycle history',async()=>{
 const s=setup();let history;try{s.runs.create(scope,'b',conf,0);let paused=s.runs.create(scope,'a',conf,0);paused=s.runs.request(scope,'a',paused.revision,'pause',1);s.runs.create({...scope,tenantId:'other'},'c',conf,0);s.runs.create(scope,'future',{...conf,deadline:300},0);assert.throws(()=>s.runs.expireDeadline(scope,'a',paused.revision,99),/eligible/);assert.throws(()=>s.runs.request(scope,'a',paused.revision,'resume',100),/deadline/);const first=s.runs.expiredPage(scope,100,{limit:1}),second=s.runs.expiredPage(scope,100,{after:first.next,limit:1});assert.deepEqual(first.items.map(x=>x.runId),['a']);assert.deepEqual(second.items.map(x=>x.runId),['b']);const ended=s.runs.expireDeadline(scope,'a',paused.revision,100);assert.equal(ended.status,'failed');assert.throws(()=>s.runs.expireDeadline(scope,'a',paused.revision,100),/revision/);assert.equal(s.runs.get({...scope,tenantId:'other'},'c').status,'queued');history=new SqliteAgentRunHistory(s.path,{scope,authorize:()=>true});const events=(await history.list({tenantId:'tenant',principalId:'admin'},{runId:'a'})).items;assert.equal(events.at(-1).previousStatus,'paused');assert.equal(events.at(-1).status,'failed');assert.equal(s.runs.archive(scope,'a',ended.revision).archived,true);
 }finally{history?.close();close(s);}
});

test('expiry never changes active runs or unresolved effects',()=>{
 const s=setup();let db;try{let active=s.runs.create(scope,'active',conf,0);active=s.runs.claim(scope,'active',active.revision,'worker',50,1);assert.throws(()=>s.runs.expireDeadline(scope,'active',active.revision,100),/eligible/);assert.equal(s.runs.get(scope,'active').status,'running');let uncertain=s.runs.recoverExpired(scope,'active',active.revision,100);assert.throws(()=>s.runs.expireDeadline(scope,'active',uncertain.revision,100),/eligible/);let queued=s.runs.create(scope,'unresolved',conf,0);db=new DatabaseSync(s.path);db.exec("CREATE TABLE agent_action_journal (tenant_id TEXT,agent_id TEXT,run_id TEXT,status TEXT); INSERT INTO agent_action_journal VALUES ('tenant','agent','unresolved','uncertain')");assert.throws(()=>s.runs.expireDeadline(scope,'unresolved',queued.revision,100),/reconciliation/);assert.equal(s.runs.get(scope,'unresolved').status,'queued');db.exec("DELETE FROM agent_action_journal; CREATE TABLE agent_token_calls (tenant_id TEXT,agent_id TEXT,run_id TEXT,status TEXT); INSERT INTO agent_token_calls VALUES ('tenant','agent','unresolved','reserved')");assert.throws(()=>s.runs.expireDeadline(scope,'unresolved',queued.revision,100),/reconciliation/);assert.equal(s.runs.get(scope,'unresolved').status,'queued');
 }finally{db?.close();close(s);}
});

test('expiry worker authorizes each run, avoids stale decisions and revisits denied runs',async()=>{
 const s=setup(),errors=[];try{for(const name of ['a','b','c'])s.runs.create(scope,name,conf,0);let allowA=false;const worker=new AgentRunExpiryWorker({runs:s.runs,scope,maxPerPass:2,pollMs:100,clock:()=>100,onError:(e,id)=>errors.push([e.message,id]),authorize:run=>{if(run.runId==='a')return allowA;if(run.runId==='b'){s.runs.request(scope,'b',run.revision,'cancel',100);return true;}return true;}});assert.equal(await worker.runOnce(),0);assert.equal(s.runs.get(scope,'a').status,'queued');assert.equal(s.runs.get(scope,'b').status,'cancelled');assert.equal(await worker.runOnce(),1);assert.equal(s.runs.get(scope,'c').status,'failed');allowA=true;assert.equal(await worker.runOnce(),1);assert.equal(s.runs.get(scope,'a').status,'failed');assert.deepEqual(errors,[]);
 }finally{close(s);}
});

test('stopping expiry while authorization is pending prevents a late transition',async()=>{
 const s=setup();let resolve,started;const gate=new Promise(r=>{resolve=r;}),entered=new Promise(r=>{started=r;});try{s.runs.create(scope,'a',conf,0);const worker=new AgentRunExpiryWorker({runs:s.runs,scope,maxPerPass:5,pollMs:100,clock:()=>100,onError:()=>{},authorize:async()=>{started();await gate;return true;}});worker.start();await entered;const stop=worker.stop();resolve();await stop;assert.equal(s.runs.get(scope,'a').status,'queued');assert.equal(await worker.runOnce(),1);assert.equal(s.runs.get(scope,'a').status,'failed');}finally{close(s);}
});


test('expiry decisions atomically record scoped actor and evidence across restart',async()=>{
 const s=setup();let history,other,db;try{const one=s.runs.create(scope,'one',conf,0),two=s.runs.create(scope,'two',conf,0),outside=s.runs.create({...scope,tenantId:'other'},'outside',conf,0),evidence={principalId:'operator',reference:'case-1'};s.runs.expireDeadline(scope,'one',one.revision,100,evidence);s.runs.expireDeadline({...scope,tenantId:'other'},'outside',outside.revision,100,evidence);const workerOptions={runs:s.runs,scope,maxPerPass:10,pollMs:100,clock:()=>100,onError:()=>{},authorize:()=>true,evidence:{principalId:'worker',reference:'batch-1'}},worker=new AgentRunExpiryWorker(workerOptions);workerOptions.evidence.principalId='changed';assert.equal(await worker.runOnce(),1);history=new SqliteAgentExpiryHistory(s.path,{scope,authorize:(actor,action,event)=>actor.principalId==='auditor'&&(action==='list'||event.runId==='one')});const actor={tenantId:'tenant',principalId:'auditor'},first=await history.list(actor,{limit:1}),second=await history.list(actor,{after:first.nextAfter,limit:1});assert.deepEqual(first.items.map(e=>[e.runId,e.revision,e.previousStatus,e.deadline,e.principalId,e.reference,e.observedAt]),[['one',2,'queued',100,'operator','case-1',100]]);assert.deepEqual(second.items,[]);await assert.rejects(history.list({...actor,tenantId:'other'}),/actor/);await assert.rejects(history.list({...actor,principalId:'other'}),/denied/);history.close();history=new SqliteAgentExpiryHistory(s.path,{scope,authorize:()=>true});const all=(await history.list(actor)).items;assert.deepEqual(all.map(x=>x.principalId),['operator','worker']);assert.equal(all[1].reference,'batch-1');other=new SqliteAgentExpiryHistory(s.path,{scope:{...scope,tenantId:'other'},authorize:()=>true});assert.deepEqual((await other.list({...actor,tenantId:'other'})).items.map(x=>x.runId),['outside']);db=new DatabaseSync(s.path);assert.throws(()=>db.exec("UPDATE agent_run_expiry_audit SET reference='changed'"),/immutable/);assert.throws(()=>db.exec('DELETE FROM agent_run_expiry_audit'),/immutable/);
 }finally{db?.close();other?.close();history?.close();close(s);}
});

test('expiry audit failure rolls back transition and invalid evidence fails closed',async()=>{
 const s=setup();let db;try{const run=s.runs.create(scope,'run',conf,0);assert.throws(()=>s.runs.expireDeadline(scope,'run',run.revision,100,{principalId:'',reference:'case'}),/evidence/);db=new DatabaseSync(s.path);db.exec("CREATE TRIGGER reject_expiry_audit BEFORE INSERT ON agent_run_expiry_audit BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");assert.throws(()=>s.runs.expireDeadline(scope,'run',run.revision,100,{principalId:'operator',reference:'case'}),/audit unavailable/);assert.equal(s.runs.get(scope,'run').status,'queued');assert.equal(s.runs.get(scope,'run').revision,run.revision);db.exec('DROP TRIGGER reject_expiry_audit');assert.equal(s.runs.expireDeadline(scope,'run',run.revision,100,{principalId:'operator',reference:'case'}).status,'failed');
 }finally{db?.close();close(s);}
});

test('stopping a manual expiry pass prevents a late transition and leaves it for retry',async()=>{
 const s=setup();let release,started,block=true;const gate=new Promise(r=>release=r),entered=new Promise(r=>started=r);try{
  s.runs.create(scope,'a',conf,0);const worker=new AgentRunExpiryWorker({runs:s.runs,scope,maxPerPass:5,pollMs:100,clock:()=>100,onError:()=>{},authorize:async()=>{if(block){started();await gate;}return true;}});
  const pass=worker.runOnce();await entered;const stopping=worker.stop();block=false;release();assert.equal(await pass,0);await stopping;assert.equal(s.runs.get(scope,'a').status,'queued');assert.equal(await worker.runOnce(),1);assert.equal(s.runs.get(scope,'a').status,'failed');
 }finally{close(s);}
});
