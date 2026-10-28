import test from 'node:test';
import assert from 'node:assert/strict';
import {importOpenAPI,CapabilityRegistry} from '../dist/index.js';

const spec={openapi:'3.1.0',paths:{'/customers':{get:{operationId:'listCustomers',summary:'List customers'}},'/customers/{id}':{get:{operationId:'getCustomer'}}}};
test('imports operation candidates without registering or executing them',async()=>{
  const candidates=importOpenAPI(spec);assert.deepEqual(candidates.map(c=>c.operationId),['listCustomers','getCustomer']);
  assert.equal(candidates[0].method,'GET');assert.equal(candidates[0].path,'/customers');
  const registry=new CapabilityRegistry();
  await assert.rejects(registry.invoke('listCustomers',{}, {tenantId:'t',principalId:'p',origin:'ui'}),/not found/);
  assert.throws(()=>importOpenAPI({openapi:'3.1.0',paths:{'/x':{$ref:'https://evil.example/spec'}}}),/Unsupported/);
  assert.throws(()=>importOpenAPI({openapi:'3.1.0',paths:{'/x':{get:{operationId:'a'},post:{operationId:'a'}}}}),/duplicate/);
});

test('UI and agent use the same deny-by-default policy and validation before execution',async()=>{
  const candidate=importOpenAPI(spec)[0], registry=new CapabilityRegistry();let calls=0;
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
