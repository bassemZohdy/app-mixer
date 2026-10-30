import test from 'node:test';
import assert from 'node:assert/strict';
import {AIMessage} from '@langchain/core/messages';
import {CapabilityRegistry} from '../../core/dist/index.js';
import {SqliteAgentDefinitions,createConfiguredAgentRun} from '../dist/index.js';
const base={manifestVersion:1,tenantId:'t',agentId:'agent',name:'Operations',owner:{kind:'organization',id:'org'},administrators:['admin'],userAssociation:'someone',servicePrincipalId:'svc',model:{provider:'local',model:'model'},allowedCapabilities:['lookup'],lifecycle:{enabled:true,maxAttempts:3,runTimeoutMs:60000},quotas:{maxConcurrentRuns:1,maxTokensPerRun:1000,maxRunsPerDay:10}};
const input={threadId:'thread',runId:'run',messages:[{role:'user',content:'Find it'}]};
const collect=async iterable=>{const result=[];for await(const item of iterable)result.push(item);return result;};
function setup(){
 const definitions=new SqliteAgentDefinitions(':memory:'),audit=[],registry=new CapabilityRegistry(e=>audit.push(e));let count=0;
 registry.register({operationId:'lookup',method:'GET',path:'/lookup'},{authorize:ctx=>ctx.tenantId==='t'&&ctx.principalId==='svc',validate:()=>true,execute:()=>{count++;return {name:'Ada'};}});definitions.save('t',base,0);
 const identities=[],options={definitions,tenantId:'t',agentId:'agent',expectedVersion:1,bindings:[{operationId:'lookup',toolName:'lookup',description:'Look up data'}],registry,authorizeRun:identity=>{identities.push(identity);return true;},authorizeCapability:(identity)=>{identities.push(identity);return true;},createModel:(_definition,tools)=>{assert.deepEqual(tools.map(t=>t.name),['lookup']);let turn=0;return {async invoke(){return ++turn===1?new AIMessage({content:'',tool_calls:[{id:'c1',name:'lookup',args:{}}]}):new AIMessage('Found');}};}};
 return {definitions,registry,audit,options,identities,count:()=>count};
}

test('configured agents support asynchronous definition stores and reject changes during lookup',async()=>{
 const s=setup();try{s.options.definitions={get:async(tenant,agent)=>s.definitions.get(tenant,agent)};const run=await createConfiguredAgentRun(s.options);assert.equal((await collect(run.run(input))).at(-1).type,'RUN_FINISHED');assert.equal(s.count(),1);}finally{s.definitions.close();}
 const t=setup();try{let reads=0,started,release;const ready=new Promise(r=>started=r),gate=new Promise(r=>release=r);t.options.definitions={get:async(tenant,agent)=>{if(++reads===2){started();await gate;}return t.definitions.get(tenant,agent);}};const pending=createConfiguredAgentRun(t.options);await ready;t.definitions.save('t',{...base,lifecycle:{...base.lifecycle,enabled:false}},1);release();await assert.rejects(pending,/definition changed/);assert.equal(t.count(),0);}finally{t.definitions.close();}
});

test('configured organization agent uses only its service principal and authorized capability',async()=>{
 const s=setup();try{const run=await createConfiguredAgentRun(s.options),events=await collect(run.run(input));assert.equal(events.at(-1).type,'RUN_FINISHED');assert.equal(s.count(),1);assert.equal(s.identities.length,3);assert.ok(s.identities.every(x=>x.servicePrincipalId==='svc'&&!('userAssociation' in x)));assert.deepEqual(s.audit.map(x=>x.principalId),['svc','svc']);await assert.rejects(collect(run.run(input)),/already used/);}finally{s.definitions.close();}
});

test('revocation, changed definitions and registry authorization prevent execution',async()=>{
 for(const mode of ['run-revoked','capability-denied','definition-changed','registry-denied']){
  const s=setup();try{
   let allowed=true;if(mode==='run-revoked')s.options.authorizeRun=()=>allowed;
   if(mode==='capability-denied')s.options.authorizeCapability=()=>false;
   if(mode==='registry-denied'){const reg=new CapabilityRegistry(()=>{});reg.register({operationId:'lookup',method:'GET',path:'/lookup'},{authorize:()=>false,validate:()=>true,execute:()=>{throw Error('must not run');}});s.options.registry=reg;}
   const run=await createConfiguredAgentRun(s.options);
   if(mode==='run-revoked')allowed=false;
   if(mode==='definition-changed')s.definitions.save('t',{...base,lifecycle:{...base.lifecycle,enabled:false}},1);
   if(mode==='run-revoked'||mode==='definition-changed')await assert.rejects(collect(run.run(input)),/forbidden|changed/);
   else assert.equal((await collect(run.run(input))).at(-1).type,'RUN_ERROR');assert.equal(s.count(),0);
  }finally{s.definitions.close();}
 }
});

test('agent policy and configuration are rechecked after asynchronous authorization',async()=>{
 const s=setup();try{let started,resume;const ready=new Promise(r=>started=r),gate=new Promise(r=>resume=r);s.options.authorizeCapability=async()=>{started();await gate;return true;};
  const run=await createConfiguredAgentRun(s.options),pending=collect(run.run(input));await ready;s.definitions.save('t',{...base,allowedCapabilities:[]},1);resume();const events=await pending;assert.equal(events.at(-1).type,'RUN_ERROR');assert.equal(s.count(),0);
 }finally{s.definitions.close();}
});

test('preparation rejects disabled, cross-tenant, missing and unapproved tools',async()=>{
 const s=setup();try{
  await assert.rejects(createConfiguredAgentRun({...s.options,tenantId:'other'}),/unavailable/);
  await assert.rejects(createConfiguredAgentRun({...s.options,expectedVersion:2}),/unavailable/);
  await assert.rejects(createConfiguredAgentRun({...s.options,bindings:[]}),/capability unavailable/);
  await assert.rejects(createConfiguredAgentRun({...s.options,authorizeRun:()=>false}),/forbidden/);
  const unlisted={...base,allowedCapabilities:[]};s.definitions.save('t',unlisted,1);let visible;s.options.expectedVersion=2;s.options.createModel=(_d,tools)=>{visible=tools.length;return {async invoke(){return new AIMessage({content:'',tool_calls:[{id:'c',name:'lookup',args:{}}]});}};};const run=await createConfiguredAgentRun(s.options);assert.equal(visible,0);assert.equal((await collect(run.run(input))).at(-1).type,'RUN_ERROR');assert.equal(s.count(),0);
 }finally{s.definitions.close();}
});

test('explicit scoped delegation invokes as the user only while host policy and expiry permit it',async()=>{
 for(const mode of ['allowed','expired','revoked','wrong-tenant','wrong-run','expires-during-check']){const s=setup();try{
  let now=10,calls=0,contexts=[];const registry=new CapabilityRegistry(e=>contexts.push(e));registry.register({operationId:'lookup',method:'GET',path:'/lookup'},{authorize:ctx=>ctx.principalId==='user',validate:()=>true,execute:()=>{calls++;return {ok:true}}});s.options.registry=registry;
  const grant={tenantId:mode==='wrong-tenant'?'other':'t',agentId:'agent',runId:mode==='wrong-run'?'other':'run',principalId:'user',grantId:'grant',permissionVersion:'v1',expiresAt:mode==='expired'?10:20};let checks=0;s.options.delegation={grant,clock:()=>now,authorize:(identity,g,operation)=>{assert.equal(identity.servicePrincipalId,'svc');assert.equal(g.principalId,'user');assert.equal(operation,'lookup');checks++;if(mode==='expires-during-check')now=20;return mode!=='revoked';}};
  if(mode==='wrong-tenant'){await assert.rejects(createConfiguredAgentRun(s.options),/Invalid delegation/);continue}const run=await createConfiguredAgentRun(s.options);grant.principalId='forged';
  if(mode==='wrong-run'){await assert.rejects(collect(run.run(input)),/run mismatch/);continue}const events=await collect(run.run(input));assert.equal(events.at(-1).type,mode==='allowed'?'RUN_FINISHED':'RUN_ERROR');assert.equal(calls,mode==='allowed'?1:0);if(mode==='allowed'){assert.ok(checks>0);assert.ok(contexts.every(e=>e.principalId==='user'));}
 }finally{s.definitions.close();}}
});
