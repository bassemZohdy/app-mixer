import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {SqliteAgentRuns,SqliteAgentDefinitions,SqliteAgentTriggers,createAgentEventIngress} from '../dist/index.js';

const scope={tenantId:'tenant',agentId:'agent'},parent='00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',other='00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',manifest={manifestVersion:1,tenantId:'tenant',agentId:'agent',name:'Agent',owner:{kind:'organization',id:'org'},administrators:['admin'],servicePrincipalId:'service',model:{provider:'local',model:'test'},allowedCapabilities:[],lifecycle:{enabled:true,maxAttempts:2,runTimeoutMs:60000},quotas:{maxConcurrentRuns:1,maxTokensPerRun:100,maxRunsPerDay:10}};

test('trusted run trace context survives reopening and links a worker in another process',()=>{
 const dir=mkdtempSync(join(tmpdir(),'agent-trace-parent-')),runPath=join(dir,'runs.sqlite'),definitionPath=join(dir,'definitions.sqlite'),runs=new SqliteAgentRuns(runPath),definitions=new SqliteAgentDefinitions(definitionPath);let reopened;
 try{definitions.save('tenant',manifest,0);runs.create(scope,'run',{definitionVersion:1,maxAttempts:2,deadline:Date.now()+60000,traceParent:parent});assert.equal(runs.getTraceParent(scope,'run'),parent);assert.equal(runs.getTraceParent({...scope,tenantId:'other'},'run'),undefined);runs.close();definitions.close();const child=spawnSync(process.execPath,[fileURLToPath(new URL('./fixtures/traced-worker.mjs',import.meta.url))],{env:{...process.env,TEST_RUNS:runPath,TEST_DEFINITIONS:definitionPath,TEST_RUN_ID:'run'},encoding:'utf8',timeout:10000});assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),{traceId:'0123456789abcdef0123456789abcdef',parent:'0123456789abcdef',status:'succeeded'});reopened=new SqliteAgentRuns(runPath);assert.equal(reopened.get(scope,'run').status,'succeeded');}finally{reopened?.close();rmSync(dir,{recursive:true,force:true});}
});

test('trace context creation is atomic, immutable and rejects malformed parents',()=>{
 const dir=mkdtempSync(join(tmpdir(),'agent-trace-atomic-')),path=join(dir,'runs.sqlite'),runs=new SqliteAgentRuns(path);let db;
 try{const config={definitionVersion:1,maxAttempts:1,deadline:1000};for(const bad of ['00-'+ '0'.repeat(32)+'-0123456789abcdef-01',parent.toUpperCase(),parent+'-extra','invalid'])assert.throws(()=>runs.create(scope,'bad',{...config,traceParent:bad},0),/configuration/);assert.equal(runs.get(scope,'bad'),undefined);db=new DatabaseSync(path);db.exec("CREATE TRIGGER fail_trace BEFORE INSERT ON agent_run_trace_context BEGIN SELECT RAISE(ABORT,'trace write failed'); END");assert.throws(()=>runs.create(scope,'atomic',{...config,traceParent:parent},0),/trace write failed/);assert.equal(runs.get(scope,'atomic'),undefined);db.exec('DROP TRIGGER fail_trace');runs.create(scope,'valid',{...config,traceParent:parent},0);assert.throws(()=>db.exec("UPDATE agent_run_trace_context SET trace_parent='bad'"),/immutable/);assert.throws(()=>db.exec('DELETE FROM agent_run_trace_context'),/immutable/);}finally{db?.close();runs.close();rmSync(dir,{recursive:true,force:true});}
});

test('authorized ingress stores the first trusted context atomically and ignores invalid tracing',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'agent-trace-event-')),path=join(dir,'runs.sqlite'),runs=new SqliteAgentRuns(path),triggers=new SqliteAgentTriggers(path),definitions=new SqliteAgentDefinitions(':memory:');definitions.save('tenant',manifest,0);let chosen=parent,authorized=true,calls=0;const ingress=createAgentEventIngress({triggers,definitions,maxPending:10,authenticate:()=>({tenantId:'tenant',principalId:'sender',sourceId:'source'}),authorize:()=>authorized,traceParent:()=>{calls++;return chosen;}});ingress.listen(0,'127.0.0.1');await once(ingress,'listening');
 try{const url=`http://127.0.0.1:${ingress.address().port}/events`,post=id=>fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({agentId:'agent',eventId:id,eventType:'event',payload:{}})});let response=await post('first');assert.equal(response.status,202);const first=await response.json();chosen=other;response=await post('first');assert.equal(response.status,200);assert.equal((await response.json()).runId,first.runId);assert.equal(runs.getTraceParent(scope,first.runId),parent);chosen='invalid';response=await post('second');assert.equal(response.status,202);assert.equal(runs.getTraceParent(scope,(await response.json()).runId),undefined);authorized=false;assert.equal((await post('denied')).status,403);assert.equal(calls,3);}finally{ingress.closeAllConnections();await new Promise(resolve=>ingress.close(resolve));definitions.close();triggers.close();runs.close();rmSync(dir,{recursive:true,force:true});}
});
