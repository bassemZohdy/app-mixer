import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CapabilityRegistry,createCapabilityServer,registerStagedCapability,SqliteStagedOperations} from '../dist/index.js';

test('authenticated staging is explicit and external submission rechecks actor policy',async()=>{
 const audit=[],outer=new CapabilityRegistry(event=>audit.push(event)),external=new CapabilityRegistry(event=>audit.push(event)),store=new SqliteStagedOperations(':memory:');let executions=0;
 external.register({operationId:'orders.create',method:'POST',path:'/orders'},{authorize:ctx=>ctx.principalId==='allowed',validate:input=>input.payload.quantity===2,execute:input=>{executions++;return {key:input.idempotencyKey};}});
 for(const operation of ['stage','get','submit'])registerStagedCapability(outer,external,store,{candidate:{operationId:`orders.${operation}`,method:'POST',path:'/staging'},applicationId:'app',externalOperationId:'orders.create',operation,authorize:ctx=>ctx.principalId!=='denied',validate:()=>true});
 const server=createCapabilityServer(outer,req=>{const [tenantId,principalId]=(req.headers.authorization??'').split(':');return tenantId&&principalId?{tenantId,principalId}:undefined;},()=>{});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const call=async(operation,input,tenant='t',principal='allowed',origin='ui')=>{const res=await fetch(`http://127.0.0.1:${server.address().port}/capabilities/orders.${operation}/invoke`,{method:'POST',headers:{'content-type':'application/json',authorization:`${tenant}:${principal}`},body:JSON.stringify({origin,input})});return {status:res.status,body:await res.json()};};
 try {
  assert.equal((await call('stage',{payload:{quantity:2}},'t','denied')).status,403);
  assert.equal((await call('stage',{payload:{quantity:2},tenantId:'other'})).status,400);
  const viewerOp=(await call('stage',{payload:{quantity:2}},'t','viewer')).body.result;
  assert.equal((await call('submit',{id:viewerOp.id},'t','viewer')).status,403);assert.equal((await call('get',{id:viewerOp.id},'t','viewer')).body.result.status,'uncertain');assert.equal(executions,0);
  const op=(await call('stage',{payload:{quantity:2}})).body.result;assert.equal(op.status,'staged');assert.equal(executions,0);
  assert.equal((await call('get',{id:op.id},'other')).body.result,null);
  assert.equal((await call('submit',{id:op.id},'t','denied','agent')).status,403);assert.equal(executions,0);
  const result=await call('submit',{id:op.id},'t','allowed','agent');assert.equal(result.status,200);assert.equal(result.body.result.key,op.idempotencyKey);
  assert.equal((await call('get',{id:op.id})).body.result.status,'succeeded');assert.equal(executions,1);
  assert.equal((await call('submit',{id:op.id})).status,500);assert.equal(executions,1);
  assert.ok(audit.some(event=>event.operationId==='orders.create'&&event.outcome==='succeeded'));
 } finally {await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));store.close();}
});

test('staged capabilities cannot access another external operation and fail closed on policy',async()=>{
 const outer=new CapabilityRegistry(()=>{}),external=new CapabilityRegistry(()=>{}),store=new SqliteStagedOperations(':memory:'),scope={tenantId:'t',applicationId:'app'};
 const other=store.stage(scope,'other.operation',{secret:'private'}),context={tenantId:'t',principalId:'alice',origin:'ui'};
 const base={applicationId:'app',externalOperationId:'allowed.operation',authorize:()=>true,validate:()=>true};
 try {
  registerStagedCapability(outer,external,store,{...base,candidate:{operationId:'get',method:'POST',path:'/'},operation:'get'});
  registerStagedCapability(outer,external,store,{...base,candidate:{operationId:'submit',method:'POST',path:'/'},operation:'submit'});
  assert.equal(await outer.invoke('get',{id:other.id},context),null);
  await assert.rejects(outer.invoke('submit',{id:other.id},context),/not found/);
  assert.equal(store.get(scope,other.id).status,'staged');
  registerStagedCapability(outer,external,store,{...base,candidate:{operationId:'create',method:'POST',path:'/'},operation:'stage',authorizeInput:()=>false});
  await assert.rejects(outer.invoke('create',{payload:{}},context),/forbidden/);
  assert.throws(()=>registerStagedCapability(outer,external,store,{...base,candidate:{operationId:'bad',method:'POST',path:'/'},operation:'stage',authorizeInput:'bad'}),/Invalid/);
 } finally {store.close();}
});
