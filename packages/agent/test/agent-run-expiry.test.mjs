import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {SqliteAgentRuns,AgentRunExpiryWorker,SqliteAgentRunHistory} from '../dist/index.js';
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
