import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CapabilityRegistry,createCapabilityServer,registerDataCapability,SqliteDataProvider} from '../dist/index.js';

test('bounded data policies cannot execute a late write after timeout or saturation',async()=>{
 for(const stage of ['authorize','validate','authorizeRecord']){
  const provider=new SqliteDataProvider(':memory:'),registry=new CapabilityRegistry(()=>{});let release,signal,blocked=true,server;
  const gate=new Promise(resolve=>release=resolve),pending=async currentSignal=>{if(blocked){signal=currentSignal;await gate;}return true;};
  const options={candidate:{operationId:'items.put',method:'PUT',path:'/items'},applicationId:'app',collection:'items',operation:'put',policyTimeoutMs:100,maxPendingPolicies:1,authorize:(_actor,s)=>stage==='authorize'?pending(s):true,validate:(_input,s)=>stage==='validate'?pending(s):true,authorizeRecord:(_actor,_input,s)=>stage==='authorizeRecord'?pending(s):true};
  try{
   for(const invalid of [{policyTimeoutMs:100,maxPendingPolicies:undefined},{policyTimeoutMs:99,maxPendingPolicies:1},{policyTimeoutMs:100,maxPendingPolicies:0}])assert.throws(()=>registerDataCapability(new CapabilityRegistry(()=>{}),provider,{...options,...invalid}),/Invalid data capability/);
   registerDataCapability(registry,provider,options);options.policyTimeoutMs=30000;options.maxPendingPolicies=100;
   server=createCapabilityServer(registry,()=>({tenantId:'tenant',principalId:'alice'}),()=>{});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
   const call=()=>fetch(`http://127.0.0.1:${server.address().port}/capabilities/items.put/invoke`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({origin:'ui',input:{id:'one',expectedRevision:null,value:{text:'value'}}})});
   const first=await call();assert.equal(first.status,503,stage);assert.deepEqual(await first.json(),{error:'Data capability unavailable'});assert.equal(signal.aborted,true);
   assert.equal((await call()).status,503,stage);assert.equal(provider.get({tenantId:'tenant',applicationId:'app'},'items','one'),undefined);
   blocked=false;release();await new Promise(resolve=>setImmediate(resolve));assert.equal(provider.get({tenantId:'tenant',applicationId:'app'},'items','one'),undefined);
   assert.equal((await call()).status,200,stage);assert.deepEqual(provider.get({tenantId:'tenant',applicationId:'app'},'items','one').value,{text:'value'});
  }finally{release();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}provider.close();}
 }
});

test('optional rechecks prevent record access when scope or record policy is revoked during authorization',async()=>{
 for(const operation of ['get','put','delete'])for(const revoked of ['scope','record']){
  const provider=new SqliteDataProvider(':memory:'),events=[],registry=new CapabilityRegistry(event=>events.push(event.outcome)),scope={tenantId:'tenant',applicationId:'app'};let release,started,blocked=true,scopeAllowed=true,recordAllowed=true,server;
  const gate=new Promise(resolve=>release=resolve),waiting=new Promise(resolve=>started=resolve);
  try{
   if(operation!=='put')provider.put(scope,'items','one',{text:'before'},null);
   const options={candidate:{operationId:`items.${operation}`,method:'POST',path:'/items'},applicationId:'app',collection:'items',operation,recheckAuthorization:true,authorize:()=>scopeAllowed,validate:()=>true,authorizeRecord:async()=>{const allowed=recordAllowed;if(blocked){started();await gate;}return allowed;}};
   assert.throws(()=>registerDataCapability(new CapabilityRegistry(()=>{}),provider,{...options,recheckAuthorization:'true'}),/Invalid data capability/);
   registerDataCapability(registry,provider,options);options.recheckAuthorization=false;
   server=createCapabilityServer(registry,()=>({tenantId:'tenant',principalId:'alice'}),()=>{});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
   const input=operation==='put'?{id:'one',expectedRevision:null,value:{text:'new'}}:operation==='delete'?{id:'one',expectedRevision:1}:{id:'one'};
   const call=()=>fetch(`http://127.0.0.1:${server.address().port}/capabilities/items.${operation}/invoke`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({origin:'ui',input})});
   const pending=call();await waiting;if(revoked==='scope')scopeAllowed=false;else recordAllowed=false;blocked=false;release();
   const denied=await pending;assert.equal(denied.status,403,`${operation}: ${revoked}`);assert.deepEqual(await denied.json(),{error:'Capability forbidden'});assert.equal(events.at(-1),'failed');
   assert.deepEqual(provider.get(scope,'items','one')?.value,operation==='put'?undefined:{text:'before'});
   scopeAllowed=true;recordAllowed=true;const allowed=await call();assert.equal(allowed.status,200,operation);
   assert.deepEqual(provider.get(scope,'items','one')?.value,operation==='put'?{text:'new'}:operation==='delete'?undefined:{text:'before'});
  }finally{release();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}provider.close();}
 }
});

test('timed-out final record recheck cannot perform a late write',async()=>{
 const provider=new SqliteDataProvider(':memory:'),registry=new CapabilityRegistry(()=>{});let release,signal,count=0;const gate=new Promise(resolve=>release=resolve);
 try{
  registerDataCapability(registry,provider,{candidate:{operationId:'items.put',method:'PUT',path:'/items'},applicationId:'app',collection:'items',operation:'put',policyTimeoutMs:100,maxPendingPolicies:1,recheckAuthorization:true,authorize:()=>true,validate:()=>true,authorizeRecord:async(_actor,_input,currentSignal)=>{if(++count===2){signal=currentSignal;await gate;}return true;}});
  const invoke=()=>registry.invoke('items.put',{id:'one',expectedRevision:null,value:{text:'value'}},{tenantId:'tenant',principalId:'alice',origin:'ui'});
  await assert.rejects(invoke(),/Data capability unavailable/);assert.equal(signal.aborted,true);assert.equal(provider.get({tenantId:'tenant',applicationId:'app'},'items','one'),undefined);
  release();await new Promise(resolve=>setImmediate(resolve));assert.equal(provider.get({tenantId:'tenant',applicationId:'app'},'items','one'),undefined);
  await invoke();assert.equal(provider.get({tenantId:'tenant',applicationId:'app'},'items','one').value.text,'value');
 }finally{release();provider.close();}
});

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
  assert.equal((await call('put',{id:'1',expectedRevision:null,value:{name:'Grace'}})).status,409);
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

test('record policy sees validated input, denies both origins and cannot mutate the write',async()=>{
 const provider=new SqliteDataProvider(':memory:'),events=[],registry=new CapabilityRegistry(event=>events.push(event.outcome));let policyCalls=0;
 const options={candidate:{operationId:'restricted.put',method:'PUT',path:'/restricted'},applicationId:'app',collection:'items',operation:'put',
  authorize:()=>true,validate:input=>typeof input.value.name==='string',
  authorizeRecord:(context,input)=>{policyCalls++;const allowed=input.id===context.principalId;input.value.name='modified by policy';context.tenantId='other';return allowed;}};
 registerDataCapability(registry,provider,options);
 try {
  for(const origin of ['ui','agent'])await assert.rejects(registry.invoke('restricted.put',{id:'other',expectedRevision:null,value:{name:'bad'}},{tenantId:'t',principalId:'alice',origin}),/forbidden/);
  await assert.rejects(registry.invoke('restricted.put',{id:'alice',expectedRevision:null,value:{name:3}},{tenantId:'t',principalId:'alice',origin:'ui'}),/Invalid capability input/);
  assert.equal(policyCalls,2);
  await registry.invoke('restricted.put',{id:'alice',expectedRevision:null,value:{name:'original'}},{tenantId:'t',principalId:'alice',origin:'agent'});
  assert.deepEqual(provider.get({tenantId:'t',applicationId:'app'},'items','alice').value,{name:'original'});
  assert.equal(provider.get({tenantId:'other',applicationId:'app'},'items','alice'),undefined);
  assert.deepEqual(events,['attempt','denied','attempt','denied','attempt','invalid','attempt','succeeded']);
 } finally {provider.close();}
});

test('final record authorization catches revocation during the last scope check',async()=>{
 for(const operation of ['get','put','delete']){
  const provider=new SqliteDataProvider(':memory:'),registry=new CapabilityRegistry(()=>{}),scope={tenantId:'tenant',applicationId:'app'};let scopeChecks=0,recordAllowed=true;
  try{
   if(operation!=='put')provider.put(scope,'items','one',{text:'before'},null);
   registerDataCapability(registry,provider,{candidate:{operationId:'item',method:'POST',path:'/item'},applicationId:'app',collection:'items',operation,recheckAuthorization:true,authorize:async()=>{if(++scopeChecks===3)recordAllowed=false;return true;},authorizeRecord:()=>recordAllowed,validate:()=>true});
   const input=operation==='put'?{id:'one',expectedRevision:null,value:{text:'new'}}:operation==='delete'?{id:'one',expectedRevision:1}:{id:'one'};
   await assert.rejects(registry.invoke('item',input,{tenantId:'tenant',principalId:'alice',origin:'ui'}),/forbidden/);
   assert.deepEqual(provider.get(scope,'items','one')?.value,operation==='put'?undefined:{text:'before'});
  }finally{provider.close();}
 }
});

test('timed-out last record authorization cannot perform a late write',async()=>{
 const provider=new SqliteDataProvider(':memory:'),registry=new CapabilityRegistry(()=>{});let release,signal,count=0;const gate=new Promise(resolve=>release=resolve);
 try{registerDataCapability(registry,provider,{candidate:{operationId:'item',method:'PUT',path:'/item'},applicationId:'app',collection:'items',operation:'put',policyTimeoutMs:100,maxPendingPolicies:1,recheckAuthorization:true,authorize:()=>true,validate:()=>true,authorizeRecord:async(_actor,_input,currentSignal)=>{if(++count===3){signal=currentSignal;await gate;}return true;}});const input={id:'one',expectedRevision:null,value:{text:'value'}},actor={tenantId:'tenant',principalId:'alice',origin:'ui'};await assert.rejects(registry.invoke('item',input,actor),/Data capability unavailable/);assert.equal(signal.aborted,true);assert.equal(provider.get({tenantId:'tenant',applicationId:'app'},'items','one'),undefined);release();await new Promise(resolve=>setImmediate(resolve));assert.equal(provider.get({tenantId:'tenant',applicationId:'app'},'items','one'),undefined);assert.equal((await registry.invoke('item',input,actor)).revision,1);}finally{release();provider.close();}
});
