import test from 'node:test';
import assert from 'node:assert/strict';
import {importOpenAPI,CapabilityRegistry} from '../dist/index.js';

const spec={openapi:'3.1.0',paths:{'/customers':{get:{operationId:'listCustomers',summary:'List customers'}},'/customers/{id}':{get:{operationId:'getCustomer'}}}};
test('imports operation candidates without registering or executing them',async()=>{
  const candidates=importOpenAPI(spec);assert.deepEqual(candidates.map(c=>c.operationId),['listCustomers','getCustomer']);
  assert.equal(candidates[0].method,'GET');assert.equal(candidates[0].path,'/customers');
  const registry=new CapabilityRegistry(()=>{});
  await assert.rejects(registry.invoke('listCustomers',{}, {tenantId:'t',principalId:'p',origin:'ui'}),/not found/);
  assert.throws(()=>importOpenAPI({openapi:'3.1.0',paths:{'/x':{$ref:'https://evil.example/spec'}}}),/Unsupported/);
  assert.throws(()=>importOpenAPI({openapi:'3.1.0',paths:{'/x':{get:{operationId:'a'},post:{operationId:'a'}}}}),/duplicate/);
});

test('UI and agent use the same deny-by-default policy and validation before execution',async()=>{
  const candidate=importOpenAPI(spec)[0], registry=new CapabilityRegistry(()=>{});let calls=0;
  registry.register(candidate,{
    authorize:ctx=>ctx.tenantId==='tenant-a' && ctx.principalId==='alice',
    validate:input=>typeof input==='object' && input!==null && input.limit===10,
    execute:(input,ctx)=>{calls++;return {input,ctx};}
  });
  candidate.path='/changed';
  for(const origin of ['ui','agent']) {
    await assert.rejects(registry.invoke('listCustomers',{limit:10},{tenantId:'tenant-b',principalId:'alice',origin}),/forbidden/);
    await assert.rejects(registry.invoke('listCustomers',{limit:5},{tenantId:'tenant-a',principalId:'alice',origin}),/Invalid capability input/);
    const result=await registry.invoke('listCustomers',{limit:10},{tenantId:'tenant-a',principalId:'alice',origin});
    assert.deepEqual(result.ctx,{tenantId:'tenant-a',principalId:'alice'});
  }
  assert.equal(calls,2);
  await assert.rejects(registry.invoke('listCustomers',{}, {tenantId:'',principalId:'alice',origin:'ui'}),/Invalid invocation/);
});


test('audit is mandatory, records outcomes without payloads, and fails closed before execution',async()=>{
  assert.throws(()=>new CapabilityRegistry(),/Audit sink/);
  const records=[];let called=0;
  const registry=new CapabilityRegistry(event=>{records.push(event);});
  registry.register(importOpenAPI(spec)[0],{authorize:ctx=>ctx.principalId==='allowed',validate:input=>input.ok===true,execute:()=>{called++;return 'done';}});
  await assert.rejects(registry.invoke('listCustomers',{secret:'hidden'},{tenantId:'t',principalId:'denied',origin:'agent'}),/forbidden/);
  await assert.rejects(registry.invoke('listCustomers',{ok:false,secret:'hidden'},{tenantId:'t',principalId:'allowed',origin:'ui'}),/Invalid capability input/);
  await registry.invoke('listCustomers',{ok:true,secret:'hidden'},{tenantId:'t',principalId:'allowed',origin:'agent'});
  assert.deepEqual(records.map(e=>e.outcome),['attempt','denied','attempt','invalid','attempt','succeeded']);
  assert.ok(!JSON.stringify(records).includes('hidden'));assert.equal(called,1);
  const unavailable=new CapabilityRegistry(()=>{throw Error('audit unavailable');});
  unavailable.register(importOpenAPI(spec)[0],{authorize:()=>true,validate:()=>true,execute:()=>{called++;}});
  await assert.rejects(unavailable.invoke('listCustomers',{}, {tenantId:'t',principalId:'allowed',origin:'ui'}),/audit unavailable/);
  assert.equal(called,1);
  await assert.rejects(registry.invoke('missing',{}, {tenantId:'t',principalId:'allowed',origin:'ui'}),/not found/);
  assert.deepEqual(records.slice(-2).map(e=>e.outcome),['attempt','not_found']);
});

test('input-aware authorization is isolated, fail-closed and audited',async()=>{
 const events=[],registry=new CapabilityRegistry(event=>events.push(event.outcome));let executeCount=0;
 registry.register({operationId:'guarded',method:'POST',path:'/guarded'}, {
  authorize:()=>true,validate:input=>typeof input.value==='string',
  authorizeInput:(ctx,input)=>{if(input.value==='throw')throw Error('policy failed');input.value='mutated';ctx.tenantId='changed';return false;},
  execute:()=>{executeCount++;}
 });
 const context={tenantId:'t',principalId:'p',origin:'ui'};
 await assert.rejects(registry.invoke('guarded',{value:'x'},context),/forbidden/);
 await assert.rejects(registry.invoke('guarded',{value:'throw'},context),/policy failed/);
 assert.equal(executeCount,0);assert.deepEqual(events,['attempt','denied','attempt','failed']);
 assert.throws(()=>registry.register({operationId:'bad',method:'GET',path:'/'},{authorize:()=>true,validate:()=>true,authorizeInput:'bad',execute:()=>{}}),/Invalid/);
});
