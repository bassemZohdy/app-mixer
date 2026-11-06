// Staged submissions against a real external provider: an S3-compatible object store (SeaweedFS) in Docker, reached
// with signed requests through a TCP proxy that can lose the response or the request. Opt-in: APP_MIXER_TEST_S3=docker.
// The provider's create-only write (If-None-Match: *) keyed by the staged idempotency key is what makes duplicates
// impossible; the verifier reads the provider directly after an ambiguous result.
import test from 'node:test';
import assert from 'node:assert/strict';
import {CapabilityRegistry,SqliteStagedOperations} from '../dist/index.js';
import {startS3Provider,faultyProxy,sleep} from './fixtures/s3-provider.mjs';

const enabled=process.env.APP_MIXER_TEST_S3==='docker',bucket='staged-orders';
const scope={tenantId:'tenant',applicationId:'app'},context={tenantId:'tenant',principalId:'operator',origin:'ui'};

test('staged submissions reconcile an ambiguous timeout against a real S3 provider without a duplicate effect',{skip:!enabled&&'set APP_MIXER_TEST_S3=docker to run against a SeaweedFS container',timeout:300000},async()=>{
 let provider,proxy,staged;
 try{
  provider=await startS3Provider(bucket);proxy=await faultyProxy(provider.port);
  const objectPath=key=>provider.objectPath('orders/'+key),listOrders=()=>provider.list('orders/');

  // The capability places an order as a create-only object named by the idempotency key. A 412 means an earlier
  // attempt already created it; the stored body must then be the same order.
  const registry=new CapabilityRegistry(()=>{}),attempts=[];
  registry.register({operationId:'orders.place',method:'POST',path:'/orders'},{authorize:()=>true,validate:input=>typeof input.idempotencyKey==='string'&&Number.isSafeInteger(input.payload.quantity),execute:async input=>{
   const body=JSON.stringify(input.payload);attempts.push(input.idempotencyKey);
   const response=await provider.through(proxy.port,{method:'PUT',path:objectPath(input.idempotencyKey),body,headers:{'content-type':'application/json','if-none-match':'*'},timeoutMs:1500});
   if(response.status===200)return {created:true};
   if(response.status===412){const existing=await provider.through(proxy.port,{method:'GET',path:objectPath(input.idempotencyKey)});if(existing.status===200&&existing.body===body)return {created:false};throw Error('Idempotency key reused for a different order');}
   throw Error('Provider rejected the order: '+response.status);
  }});
  // The verifier asks the provider directly. Applied needs the stored order to match. Not applied needs no object
  // and the lost attempt's connection closed for longer than the provider takes to process a received request.
  const settleMs=2000,closedAt=new Map();
  const verify=async(_scope,operation)=>{
   const found=await provider.request({method:'GET',path:objectPath(operation.idempotencyKey)});
   if(found.status===200)return found.body===JSON.stringify(operation.payload)?'applied':'unknown';
   if(found.status===404&&closedAt.has(operation.id)&&Date.now()-closedAt.get(operation.id)>=settleMs)return 'not_applied';
   return 'unknown';
  };
  staged=new SqliteStagedOperations(':memory:');

  // 1. Ambiguous timeout after the effect: the provider stores the order, the response is lost, the client times out.
  const first=staged.stage(scope,'orders.place',{sku:'A-1',quantity:2},'order-1');
  proxy.state.mode='lose-response';
  await assert.rejects(staged.submit(scope,first.id,registry,context),/timed out/);
  // The provider may finish after the client has given up (its first write allocates storage); wait for its answer.
  for(let i=0;proxy.state.heldResponses===0;i++){if(i>100)assert.fail('the provider never answered');await sleep(100);}
  assert.ok(proxy.state.forwarded>0,'the request reached the provider and its answer was lost');
  assert.equal(staged.get(scope,first.id).status,'uncertain');
  await assert.rejects(staged.submit(scope,first.id,registry,context),/not staged/,'an uncertain intent is never retried automatically');
  assert.deepEqual(await listOrders(),['orders/'+first.idempotencyKey],'the effect happened exactly once');
  proxy.state.mode='pass';
  assert.equal(await staged.verifyAndReconcile(scope,first.id,verify),'applied');assert.equal(staged.get(scope,first.id).status,'succeeded');
  // Even a buggy extra execution with the same key cannot duplicate the order: the provider refuses the second create.
  assert.deepEqual(await registry.invoke('orders.place',{idempotencyKey:first.idempotencyKey,payload:{sku:'A-1',quantity:2}},context),{created:false});
  await assert.rejects(registry.invoke('orders.place',{idempotencyKey:first.idempotencyKey,payload:{sku:'A-1',quantity:9}},context),/different order/);
  assert.deepEqual(await listOrders(),['orders/'+first.idempotencyKey]);

  // 2. Lost request: the connection fails before anything reaches the provider. Verification waits out the settle
  // period, finds nothing, reconciles not applied, and an explicit resubmission with the same key creates the order once.
  const second=staged.stage(scope,'orders.place',{sku:'B-2',quantity:1},'order-2');
  proxy.state.mode='lose-request';
  await assert.rejects(staged.submit(scope,second.id,registry,context));closedAt.set(second.id,Date.now());
  assert.equal(proxy.state.dropped,1);assert.equal(staged.get(scope,second.id).status,'uncertain');
  assert.equal(await staged.verifyAndReconcile(scope,second.id,verify),'unknown','too early to rule out a late effect');assert.equal(staged.get(scope,second.id).status,'uncertain');
  await sleep(settleMs);
  assert.equal(await staged.verifyAndReconcile(scope,second.id,verify),'not_applied');assert.equal(staged.get(scope,second.id).status,'staged');
  proxy.state.mode='pass';
  assert.deepEqual(await staged.submit(scope,second.id,registry,context),{created:true});assert.equal(staged.get(scope,second.id).status,'succeeded');
  assert.deepEqual(await listOrders(),['orders/'+first.idempotencyKey,'orders/'+second.idempotencyKey].sort());

  // 3. Ambiguous timeout on the resubmission path too: a lost response after not_applied still yields one order.
  const third=staged.stage(scope,'orders.place',{sku:'C-3',quantity:5},'order-3');
  proxy.state.mode='lose-request';await assert.rejects(staged.submit(scope,third.id,registry,context));closedAt.set(third.id,Date.now());await sleep(settleMs);
  assert.equal(await staged.verifyAndReconcile(scope,third.id,verify),'not_applied');
  proxy.state.mode='lose-response';await assert.rejects(staged.submit(scope,third.id,registry,context),/timed out/);proxy.state.mode='pass';
  assert.equal(await staged.verifyAndReconcile(scope,third.id,verify),'applied');
  const orders=await listOrders();assert.equal(orders.length,3);assert.equal(new Set(orders).size,3);
  assert.equal(attempts.filter(key=>key===third.idempotencyKey).length,2,'two attempts, one order');
 }finally{staged?.close();await proxy?.close();await provider?.close();}
});
