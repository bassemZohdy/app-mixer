import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SqliteAgentRuns,SqliteAgentTriggers} from '../dist/index.js';
const scope={tenantId:'tenant',agentId:'agent'},other={tenantId:'other',agentId:'agent'},event={sourceId:'source',principalId:'sender',eventId:'evt',eventType:'order.created',payload:{order:'private'}},options={definitionVersion:1,maxAttempts:2,deadline:10000,maxPending:10,traceParent:'00-0123456789abcdef0123456789abcdef-0123456789abcdef-01'};
async function killAtBarrier(path,barrier,phase){
 const child=fork(fileURLToPath(new URL('./fixtures/crash-trigger-enqueue.mjs',import.meta.url)),[path,barrier,phase],{stdio:['ignore','ignore','pipe','ipc']});let errors='',problem,exited=false;child.stderr.on('data',data=>errors+=String(data));child.on('message',message=>{if(message?.error)problem=message.error;});const exit=new Promise(resolve=>child.once('exit',()=>{exited=true;resolve();}));
 try{const limit=Date.now()+15000;while(!existsSync(barrier)){if(exited||problem)throw Error(`Worker exited before ${phase}: ${problem??errors}`);if(Date.now()>limit)throw Error(`Worker did not reach ${phase}`);await new Promise(resolve=>setTimeout(resolve,20));}child.kill('SIGKILL');await exit;}finally{if(!exited){child.kill('SIGKILL');await exit;}}
}
for(const phase of ['trace','inbox','receipt','after'])test(`event enqueue survives process termination at ${phase}`,{timeout:30000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'trigger-enqueue-crash-')),path=join(dir,'db.sqlite'),barrier=join(dir,'barrier');let runs=new SqliteAgentRuns(path),triggers=new SqliteAgentTriggers(path),db;
 try{const foreign=triggers.enqueue(other,event,options,100);triggers.close();runs.close();triggers=runs=undefined;await killAtBarrier(path,barrier,phase);db=new DatabaseSync(path);db.exec('DROP TRIGGER IF EXISTS test_enqueue_crash');const committed=phase==='after';for(const table of ['agent_runs','agent_run_trace_context','agent_trigger_inbox','agent_trigger_receipts'])assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id=? AND agent_id=?`).get(scope.tenantId,scope.agentId).n,committed?1:0,table);db.close();db=undefined;
  runs=new SqliteAgentRuns(path);triggers=new SqliteAgentTriggers(path);const result=triggers.enqueue(scope,event,options,100);assert.equal(result.duplicate,committed);assert.equal(runs.list(scope).length,1);assert.deepEqual(triggers.enqueue(scope,event,{...options,traceParent:'00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01'},101),{runId:result.runId,duplicate:true});assert.equal(runs.getTraceParent(scope,result.runId),options.traceParent);assert.deepEqual(triggers.get(scope,result.runId).payload,event.payload);assert.throws(()=>triggers.enqueue(scope,{...event,payload:{order:'changed'}},options,101),/identity conflict/);assert.deepEqual(triggers.get(other,foreign.runId).payload,event.payload);assert.equal(runs.list(other).length,1);
 }finally{db?.close();triggers?.close();runs?.close();rmSync(dir,{recursive:true,force:true});}
});
