import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AIMessage} from '@langchain/core/messages';
import {SqliteAgentRuns,SqliteAgentCheckpointer,SqliteAgentDefinitions,createConfiguredAgentRun,createCapabilityTool,createToolCallingModel} from '../dist/index.js';
const scope={tenantId:'tenant',agentId:'agent'};
const messages=[{role:'user',content:'Find data'}];
const read=async stream=>{const output=[];for await(const chunk of stream)output.push(chunk);return output;};

test('LangGraph checkpoint survives restart and resumes a completed tool step',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'app-mixer-checkpoint-')),path=join(dir,'runs.sqlite');let runs,saver;
 try{
  runs=new SqliteAgentRuns(path);let run=runs.create(scope,'run',{definitionVersion:1,maxAttempts:2,deadline:10000},0);run=runs.claim(scope,'run',run.revision,'worker',1000,10);saver=new SqliteAgentCheckpointer(path,{scope,runId:'run',leaseToken:run.leaseToken,clock:()=>20});let calls=0,turn=0;
  const tool=createCapabilityTool({name:'lookup',description:'Lookup',invoke:async()=>{calls++;return 'found';}});
  const first={async invoke(){turn++;if(turn===1)return new AIMessage({content:'',tool_calls:[{id:'call-1',name:'lookup',args:{}}]});throw Error('model outage');}};
  await assert.rejects(read(createToolCallingModel(first,[tool],{checkpoint:{saver,threadId:'run',resume:false}}).stream(messages)),/model outage/);assert.equal(calls,1);const previous=await saver.getTuple({configurable:{thread_id:'run'}});assert.ok(previous);saver.close();saver=undefined;runs.close();runs=undefined;
  runs=new SqliteAgentRuns(path);run=runs.recoverExpired(scope,'run',run.revision,1010);run=runs.reconcile(scope,'run',run.revision,'retry',1010);run=runs.claim(scope,'run',run.revision,'worker-2',1000,1011);saver=new SqliteAgentCheckpointer(path,{scope,runId:'run',leaseToken:run.leaseToken,clock:()=>1020});
  const resumed={async invoke(history){assert.ok(history.some(message=>message._getType()==='tool'));return new AIMessage('Done');}};
  assert.deepEqual(await read(createToolCallingModel(resumed,[tool],{checkpoint:{saver,threadId:'run',resume:true}}).stream(messages)),['Done']);assert.equal(calls,1);
  await assert.rejects(read(createToolCallingModel(resumed,[tool],{checkpoint:{saver,threadId:'run',resume:false}}).stream(messages)),/already exists/);
 }finally{saver?.close();runs?.close();rmSync(dir,{recursive:true,force:true});}
});

test('checkpoint writes are lease-fenced and bound to tenant, agent and run',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'app-mixer-checkpoint-')),path=join(dir,'runs.sqlite');let runs,saver,other;
 try{
  runs=new SqliteAgentRuns(path);let now=10,run=runs.create(scope,'run',{definitionVersion:1,maxAttempts:2,deadline:10000},0);run=runs.claim(scope,'run',run.revision,'worker',100,now);saver=new SqliteAgentCheckpointer(path,{scope,runId:'run',leaseToken:run.leaseToken,clock:()=>now});
  const config={configurable:{thread_id:'run',checkpoint_ns:''}},cp={v:4,id:'0001',ts:'now',channel_values:{x:1},channel_versions:{},versions_seen:{}},metadata={source:'input',step:-1,parents:{}};
  const stored=await saver.put(config,cp,metadata,{});await saver.putWrites(stored,[['x',1]],'task');assert.deepEqual((await saver.getTuple(config)).pendingWrites,[['task','x',1]]);
  await assert.rejects(saver.put({...config,configurable:{thread_id:'other'}},cp,metadata,{}),/scope/);
  other=new SqliteAgentCheckpointer(path,{scope:{tenantId:'other',agentId:'agent'},runId:'run',leaseToken:run.leaseToken,clock:()=>now});assert.equal(await other.getTuple(config),undefined);await assert.rejects(other.put(config,cp,metadata,{}),/lease/);
  now=110;run=runs.recoverExpired(scope,'run',run.revision,now);await assert.rejects(saver.put(config,{...cp,id:'0002'},metadata,{}),/lease/);await assert.rejects(saver.putWrites(stored,[['x',2]],'task2'),/lease/);await assert.rejects(saver.deleteThread('run'),/lease/);assert.equal((await saver.getTuple(config)).checkpoint.id,'0001');
 }finally{other?.close();saver?.close();runs?.close();rmSync(dir,{recursive:true,force:true});}
});


test('pending writes are ordered, idempotent and isolated by namespace',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'app-mixer-checkpoint-')),path=join(dir,'runs.sqlite');let runs,saver;
 try{runs=new SqliteAgentRuns(path);let run=runs.create(scope,'run',{definitionVersion:1,maxAttempts:1,deadline:1000},0);run=runs.claim(scope,'run',run.revision,'worker',100,10);saver=new SqliteAgentCheckpointer(path,{scope,runId:'run',leaseToken:run.leaseToken,clock:()=>20});
  const config={configurable:{thread_id:'run',checkpoint_ns:'one'}},cp={v:4,id:'0001',ts:'now',channel_values:{},channel_versions:{},versions_seen:{}},metadata={source:'input',step:-1,parents:{}};
  const saved=await saver.put(config,cp,metadata,{});await saver.putWrites(saved,[['z','later']],'z-task','z');await saver.putWrites(saved,[['a','first']],'a-task','a');await saver.putWrites(saved,[['a','changed']],'a-task','a');assert.deepEqual((await saver.getTuple(config)).pendingWrites,[['a-task','a','first'],['z-task','z','later']]);
  assert.equal(await saver.getTuple({configurable:{thread_id:'run',checkpoint_ns:'two'}}),undefined);await assert.rejects(saver.put(config,{...cp,channel_values:{different:true}},metadata,{}),/conflict/);
  const listed=[];for await(const item of saver.list(config,{limit:1}))listed.push(item);assert.equal(listed.length,1);await saver.deleteThread('run');assert.equal(await saver.getTuple(config),undefined);
 }finally{saver?.close();runs?.close();rmSync(dir,{recursive:true,force:true});}
});


test('configured agent binds checkpoint thread to its run ID',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'app-mixer-checkpoint-')),path=join(dir,'runs.sqlite');let runs,saver,definitions;
 try{runs=new SqliteAgentRuns(path);let run=runs.create(scope,'run',{definitionVersion:1,maxAttempts:1,deadline:1000},0);run=runs.claim(scope,'run',run.revision,'worker',100,10);saver=new SqliteAgentCheckpointer(path,{scope,runId:'run',leaseToken:run.leaseToken,clock:()=>20});definitions=new SqliteAgentDefinitions(':memory:');definitions.save('tenant',{manifestVersion:1,tenantId:'tenant',agentId:'agent',name:'Agent',owner:{kind:'organization',id:'org'},administrators:['admin'],servicePrincipalId:'service',model:{provider:'local',model:'test'},allowedCapabilities:[],lifecycle:{enabled:true,maxAttempts:1,runTimeoutMs:1000},quotas:{maxConcurrentRuns:1,maxTokensPerRun:100,maxRunsPerDay:1}},0);
  const options={definitions,tenantId:'tenant',agentId:'agent',expectedVersion:1,bindings:[],registry:{invoke:async()=>null},authorizeRun:()=>true,authorizeCapability:()=>true,createModel:()=>({invoke:async()=>new AIMessage('Done')}),checkpoint:{saver,threadId:'run',resume:false}};
  let configured=await createConfiguredAgentRun(options);await assert.rejects(read(configured.run({threadId:'thread',runId:'other',messages})),/run mismatch/);
  configured=await createConfiguredAgentRun(options);const events=await read(configured.run({threadId:'thread',runId:'run',messages}));assert.equal(events.at(-1).type,'RUN_FINISHED');assert.ok(await saver.getTuple({configurable:{thread_id:'run'}}));
 }finally{definitions?.close();saver?.close();runs?.close();rmSync(dir,{recursive:true,force:true});}
});


test('configured agent resumes its checkpoint after an authorized recovery',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'app-mixer-checkpoint-')),path=join(dir,'runs.sqlite');let runs,saver,definitions;
 try{runs=new SqliteAgentRuns(path);let run=runs.create(scope,'run',{definitionVersion:1,maxAttempts:2,deadline:10000},0);run=runs.claim(scope,'run',run.revision,'first',100,10);saver=new SqliteAgentCheckpointer(path,{scope,runId:'run',leaseToken:run.leaseToken,clock:()=>20});definitions=new SqliteAgentDefinitions(':memory:');definitions.save('tenant',{manifestVersion:1,tenantId:'tenant',agentId:'agent',name:'Agent',owner:{kind:'organization',id:'org'},administrators:['admin'],servicePrincipalId:'service',model:{provider:'local',model:'test'},allowedCapabilities:[],lifecycle:{enabled:true,maxAttempts:2,runTimeoutMs:1000},quotas:{maxConcurrentRuns:1,maxTokensPerRun:100,maxRunsPerDay:1}},0);
  const base={definitions,tenantId:'tenant',agentId:'agent',expectedVersion:1,bindings:[],registry:{invoke:async()=>null},authorizeRun:()=>true,authorizeCapability:()=>true};
  const first=await createConfiguredAgentRun({...base,createModel:()=>({invoke:async()=>{throw Error('unavailable');}}),checkpoint:{saver,threadId:'run',resume:false}});assert.equal((await read(first.run({threadId:'thread',runId:'run',messages}))).at(-1).type,'RUN_ERROR');saver.close();saver=undefined;
  run=runs.recoverExpired(scope,'run',run.revision,110);run=runs.reconcile(scope,'run',run.revision,'retry',111);run=runs.claim(scope,'run',run.revision,'second',100,112);saver=new SqliteAgentCheckpointer(path,{scope,runId:'run',leaseToken:run.leaseToken,clock:()=>113});
  const resumed=await createConfiguredAgentRun({...base,createModel:()=>({invoke:async()=>new AIMessage('Recovered')}),checkpoint:{saver,threadId:'run',resume:true}});const events=await read(resumed.run({threadId:'thread',runId:'run',messages}));assert.equal(events.at(-1).type,'RUN_FINISHED');assert.equal(events.find(e=>e.type==='TEXT_MESSAGE_CONTENT').delta,'Recovered');
 }finally{definitions?.close();saver?.close();runs?.close();rmSync(dir,{recursive:true,force:true});}
});
