import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SqliteAgentRuns,SqliteAgentTriggers,SqliteAgentTriggerRetention,AgentTriggerRetentionWorker} from '../dist/index.js';
const scope={tenantId:'tenant',agentId:'agent'},other={tenantId:'other',agentId:'agent'},actor={tenantId:'tenant',principalId:'cleaner'},event={sourceId:'source',principalId:'sender',eventId:'event',eventType:'order',payload:{private:'payload'}},settings={definitionVersion:1,maxAttempts:2,deadline:10000,maxPending:10};
async function killAtBarrier(path,barrier,phase){
 const child=fork(fileURLToPath(new URL('./fixtures/crash-trigger-retention.mjs',import.meta.url)),[path,barrier,phase],{stdio:['ignore','ignore','pipe','ipc']});let errors='',problem;child.stderr.on('data',data=>errors+=String(data));child.on('message',message=>{if(message?.error)problem=message.error;});let exited=false;const exit=new Promise(resolve=>child.once('exit',()=>{exited=true;resolve();}));
 try{const limit=Date.now()+15000;while(!existsSync(barrier)){if(exited||problem)throw Error(`Worker exited before ${phase}: ${problem??errors}`);if(Date.now()>limit)throw Error(`Worker did not reach ${phase}`);await new Promise(resolve=>setTimeout(resolve,20));}child.kill('SIGKILL');await exit;}finally{if(!exited){child.kill('SIGKILL');await exit;}}
}
for(const phase of ['during','after'])test(`trigger retention survives process termination ${phase} redaction`,{timeout:30000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'trigger-redaction-crash-')),path=join(dir,'db.sqlite'),barrier=join(dir,'barrier');let runs=new SqliteAgentRuns(path),triggers=new SqliteAgentTriggers(path),retention,db;try{
  const item=triggers.enqueue(scope,event,settings,1),foreign=triggers.enqueue(other,event,settings,1),run=runs.get(scope,item.runId);runs.request(scope,item.runId,run.revision,'cancel',2);triggers.close();runs.close();triggers=undefined;runs=undefined;
  await killAtBarrier(path,barrier,phase);db=new DatabaseSync(path);db.exec('DROP TRIGGER IF EXISTS test_crash_retention');db.close();db=undefined;runs=new SqliteAgentRuns(path);triggers=new SqliteAgentTriggers(path);retention=new SqliteAgentTriggerRetention(path,{scope,authorize:()=>true,authorizeDiscovery:()=>true});
  assert.equal(triggers.get(scope,item.runId).payloadRedacted,phase==='after'?true:undefined);assert.deepEqual(await retention.getRedaction(actor,item.runId),phase==='after'?{actorId:'cleaner',redactedAt:100}:undefined);assert.deepEqual(triggers.get(other,foreign.runId).payload,event.payload);
  const worker=new AgentTriggerRetentionWorker({retention,actor,minAgeMs:20,maxPerPass:5,pollMs:100,clock:()=>100,authorize:()=>true,onError:()=>{}});assert.equal(await worker.runOnce(),phase==='after'?0:1);assert.equal(await worker.runOnce(),0);assert.equal(triggers.get(scope,item.runId).payloadRedacted,true);assert.deepEqual(await retention.getRedaction(actor,item.runId),{actorId:'cleaner',redactedAt:100});assert.deepEqual(triggers.enqueue(scope,event,settings,3),{runId:item.runId,duplicate:true});assert.throws(()=>triggers.enqueue(scope,{...event,payload:{private:'different'}},settings,3),/identity conflict/);assert.deepEqual(triggers.get(other,foreign.runId).payload,event.payload);await worker.stop();
 }finally{db?.close();retention?.close();triggers?.close();runs?.close();rmSync(dir,{recursive:true,force:true});}
});
