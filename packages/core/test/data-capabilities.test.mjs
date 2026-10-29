import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CapabilityRegistry,createCapabilityServer,registerDataCapability,SqliteDataProvider} from '../dist/index.js';

test('authenticated UI and agent calls share data capability policies and tenant isolation',async()=>{
 const provider=new SqliteDataProvider(':memory:'),audit=[],registry=new CapabilityRegistry(event=>audit.push(event));
 const common={applicationId:'app',collection:'people',authorize:context=>context.principalId==='allowed',validate:()=>true};
 for(const [operation,method] of [['get','GET'],['put','PUT'],['delete','DELETE']])registerDataCapability(registry,provider,{...common,operation,candidate:{operationId:`people.${operation}`,method,path:'/people'}});
 const server=createCapabilityServer(registry,req=>{
  const [tenantId,principalId]=(req.headers.authorization??'').split(':');return tenantId&&principalId?{tenantId,principalId}:undefined;
 },()=>{});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const call=async(operation,input,tenant='a',principal='allowed',origin='ui')=>{
  const res=await fetch(`http://127.0.0.1:${server.address().port}/capabilities/people.${operation}/invoke`,{method:'POST',headers:{'content-type':'application/json',authorization:`${tenant}:${principal}`},body:JSON.stringify({origin,input})});
  return {status:res.status,body:await res.json()};
 };
 try {
  for(const origin of ['ui','agent'])assert.equal((await call('put',{id:'1',expectedRevision:null,value:{name:'Ada'}},'a','denied',origin)).status,403);
  assert.equal((await call('put',{id:'1',expectedRevision:null,value:{name:'Ada'},tenantId:'b'})).status,400);
  assert.equal((await call('put',{id:'1',expectedRevision:null,value:{name:'Ada'}})).body.result.revision,1);
  assert.deepEqual((await call('get',{id:'1'},'a','allowed','agent')).body.result.value,{name:'Ada'});
  assert.equal((await call('get',{id:'1'},'b')).body.result,null);
  assert.equal((await call('delete',{id:'1',expectedRevision:1},'a','allowed','agent')).status,200);
  assert.equal((await call('get',{id:'1'})).body.result,null);
  assert.ok(audit.some(event=>event.outcome==='denied'));assert.ok(audit.some(event=>event.outcome==='succeeded'));
 } finally {await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));provider.close();}
});

test('host configuration and validation are mandatory and scope is fixed at registration',async()=>{
 const provider=new SqliteDataProvider(':memory:'),registry=new CapabilityRegistry(()=>{});
 const candidate={operationId:'save',method:'PUT',path:'/items'},input={id:'1',expectedRevision:null,value:{ok:true}};
 const options={candidate,applicationId:'first',collection:'items',operation:'put',authorize:()=>true,validate:value=>value.value.ok===true};
 try {
  assert.throws(()=>registerDataCapability(registry,provider,{...options,validate:undefined}),/Invalid/);
  registerDataCapability(registry,provider,options);options.applicationId='second';options.collection='other';
  const context={tenantId:'t',principalId:'p',origin:'ui'};
  await assert.rejects(registry.invoke('save',{...input,value:{ok:false}},context),/Invalid capability input/);
  await registry.invoke('save',input,context);
  assert.deepEqual(provider.get({tenantId:'t',applicationId:'first'},'items','1').value,{ok:true});
  assert.equal(provider.get({tenantId:'t',applicationId:'second'},'other','1'),undefined);
 } finally {provider.close();}
});
