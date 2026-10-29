import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createProject} from '../dist/index.js';
import {CapabilityRegistry,createCapabilityServer,registerDataCapability,registerStagedCapability,SqliteStagedOperations,SqliteDataProvider} from '../../core/dist/index.js';

const token='capability-secret-at-least-thirty-two-characters';
test('generated app uses an authenticated loopback capability service without exposing its token', {timeout:15000},async()=>{
 const provider=new SqliteDataProvider(':memory:'),staged=new SqliteStagedOperations(':memory:'),events=[],registry=new CapabilityRegistry(event=>events.push(event));let externalCalls=0;
 const common={applicationId:'demo-app',collection:'items',authorize:ctx=>ctx.tenantId==='tenant'&&ctx.principalId==='local',validate:()=>true};
 for(const [operation,method] of [['get','GET'],['put','PUT']])registerDataCapability(registry,provider,{...common,operation,candidate:{operationId:`items.${operation}`,method,path:'/items'}});
 registry.register({operationId:'orders.create',method:'POST',path:'/orders'},{authorize:ctx=>ctx.principalId==='local',validate:input=>input.payload.item==='x',execute:()=>{externalCalls++;return {ok:true};}});
 for(const operation of ['stage','submit'])registerStagedCapability(registry,registry,staged,{candidate:{operationId:`orders.${operation}`,method:'POST',path:'/stage'},applicationId:'demo-app',externalOperationId:'orders.create',operation,authorize:ctx=>ctx.principalId==='local',validate:()=>true});
 const upstream=createCapabilityServer(registry,req=>req.headers.authorization===`Bearer ${token}`?{tenantId:'tenant',principalId:'local'}:undefined,()=>{});
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const dir=await mkdtemp(join(tmpdir(),'app-mixer-capability-'));let server;
 try {
  const target=await createProject('demo-app',dir);
  server=spawn(process.execPath,['server.mjs'],{cwd:target,env:{...process.env,PORT:'0',CAPABILITY_URL:`http://127.0.0.1:${upstream.address().port}/capabilities/`,CAPABILITY_TOKEN:token},stdio:['ignore','pipe','pipe']});
  const url=await new Promise((resolve,reject)=>{let text='';server.stdout.on('data',chunk=>{text+=chunk;const match=text.match(/http:\/\/127\.0\.0\.1:\d+/);if(match)resolve(match[0]);});server.once('error',reject);server.once('exit',code=>reject(Error(`Server exited: ${code}`)));});
  const call=async(op,input,origin=url)=>{const res=await fetch(`${url}/api/capabilities/${op}`,{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify(input)});return {status:res.status,body:await res.json()};};
  assert.equal((await call('items.put',{id:'x',expectedRevision:null,value:{name:'Ada'}},'https://evil.example')).status,403);
  assert.equal((await call('items.put',{id:'x',expectedRevision:null,value:{name:'Ada'}})).body.result.revision,1);
  assert.deepEqual((await call('items.get',{id:'x'})).body.result.value,{name:'Ada'});
  assert.equal((await call('items.put',{id:'x',expectedRevision:null,value:{name:'Other'}})).status,409);
  const originalFetch=globalThis.fetch;
  try {
   globalThis.fetch=(relative,options)=>originalFetch(new URL(relative,url),{...options,headers:{...options.headers,origin:url}});
   const client=await import(pathToFileURL(join(target,'capabilities.mjs')).href);
   assert.equal((await client.invokeCapability('items.get',{id:'x'})).value.name,'Ada');
   const order=await client.invokeCapability('orders.stage',{payload:{item:'x'},requestKey:'order-1'});assert.equal(externalCalls,0);
   assert.equal((await client.invokeCapability('orders.stage',{payload:{item:'x'},requestKey:'order-1'})).id,order.id);
   assert.deepEqual(await client.invokeCapability('orders.submit',{id:order.id}),{ok:true});assert.equal(externalCalls,1);
   await assert.rejects(client.invokeCapability('items.put',{id:'x',expectedRevision:null,value:{name:'Other'}}),error=>error.status===409);
   await assert.rejects(client.invokeCapability('../escape',{}),/Invalid capability ID/);
  } finally {globalThis.fetch=originalFetch;}
  assert.equal((await call('missing',{})).status,404);
  assert.ok(events.some(event=>event.outcome==='succeeded'));assert.doesNotMatch(await (await fetch(`${url}/capabilities.mjs`)).text(),new RegExp(token));
  await new Promise((resolve,reject)=>upstream.close(error=>error?reject(error):resolve()));
  assert.equal((await call('items.get',{id:'x'})).status,502);assert.equal((await fetch(`${url}/api/application`)).status,200);
 } finally {
  if(upstream.listening)await new Promise((resolve,reject)=>upstream.close(error=>error?reject(error):resolve()));
  if(server&&server.exitCode===null&&server.signalCode===null){const done=once(server,'exit');server.kill();await done;}
  provider.close();staged.close();await rm(dir,{recursive:true,force:true});
 }
});
