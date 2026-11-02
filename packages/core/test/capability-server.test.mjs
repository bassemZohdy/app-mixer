import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {CapabilityRegistry,createCapabilityServer,importOpenAPI} from '../dist/index.js';
async function start(server){server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${server.address().port}`;}
async function stop(server){if(server.listening)await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}

test('authenticated UI and agent calls share authorization, validation, audit and a REST operation',async()=>{
  let externalCalls=0;const external=createServer((req,res)=>{externalCalls++;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify([{id:'c1',name:'Ada'}]));});
  const externalURL=await start(external), records=[], authFailures=[];
  const registry=new CapabilityRegistry(event=>records.push(event));
  const [candidate]=importOpenAPI({openapi:'3.1.0',paths:{'/customers':{get:{operationId:'listCustomers'}}}});
  registry.register(candidate,{
    authorize:ctx=>ctx.tenantId==='tenant-a'&&ctx.principalId==='alice',
    validate:input=>input && typeof input==='object' && Object.keys(input).length===0,
    execute:async()=>{const response=await fetch(`${externalURL}/customers`,{redirect:'error'});if(!response.ok)throw Error('upstream failure');return response.json();}
  });
  const server=createCapabilityServer(registry,req=>req.headers.authorization==='Bearer allowed'?{tenantId:'tenant-a',principalId:'alice'}:req.headers.authorization==='Bearer denied'?{tenantId:'tenant-b',principalId:'alice'}:undefined,event=>authFailures.push(event));
  try{
    const url=await start(server);
    const call=(credential,origin,input={})=>fetch(`${url}/capabilities/listCustomers/invoke`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${credential}`},body:JSON.stringify({origin,input})});
    assert.equal((await call('bad','ui')).status,401);assert.equal(authFailures.length,1);
    for(const origin of ['ui','agent']){
      assert.equal((await call('denied',origin)).status,403);
      assert.equal((await call('allowed',origin,{unexpected:true})).status,400);
      const response=await call('allowed',origin);assert.equal(response.status,200);assert.equal((await response.json()).result[0].name,'Ada');
    }
    assert.equal(externalCalls,2);
    assert.deepEqual(records.map(r=>r.outcome),['attempt','denied','attempt','invalid','attempt','succeeded','attempt','denied','attempt','invalid','attempt','succeeded']);
    assert.ok(!JSON.stringify(records).includes('Ada'));
  }finally{await stop(server);await stop(external);}
});

test('authentication audit failure blocks access without exposing internal errors',async()=>{
  const registry=new CapabilityRegistry(()=>{});
  const server=createCapabilityServer(registry,()=>undefined,()=>{throw Error('internal secret');});
  try{
    const url=await start(server);
    const response=await fetch(`${url}/capabilities/x/invoke`,{method:'POST',headers:{'content-type':'application/json'},body:'{"origin":"ui","input":{}}'});
    assert.equal(response.status,503);assert.ok(!(await response.text()).includes('internal secret'));
  }finally{await stop(server);}
});

test('post-execution audit failure returns an explicit uncertain outcome without audit details',async()=>{
 const registry=new CapabilityRegistry(event=>{if(event.outcome==='succeeded')throw Error('private audit details');});let effects=0;registry.register({operationId:'write',method:'POST',path:'/write'},{authorize:()=>true,validate:()=>true,execute:()=>{effects++;}});const server=createCapabilityServer(registry,()=>({tenantId:'tenant',principalId:'person'}),()=>{});
 try{const url=await start(server),response=await fetch(`${url}/capabilities/write/invoke`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({origin:'ui',input:{}})});assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'Capability outcome uncertain',code:'CAPABILITY_OUTCOME_UNCERTAIN'});assert.equal(effects,1);}finally{await stop(server);}
});

test('shared offline uncertain outcomes are signaled explicitly to clients',async()=>{
 const registry=new CapabilityRegistry(()=>{});registry.register({operationId:'write',method:'POST',path:'/write'},{authorize:()=>true,validate:()=>true,execute:()=>{throw Error('Shared offline outcome uncertain');}});const server=createCapabilityServer(registry,()=>({tenantId:'tenant',principalId:'person'}),()=>{});
 try{const url=await start(server),response=await fetch(`${url}/capabilities/write/invoke`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({origin:'ui',input:{}})});assert.equal(response.status,409);assert.deepEqual(await response.json(),{error:'Shared offline outcome uncertain',code:'CAPABILITY_OUTCOME_UNCERTAIN'});}finally{await stop(server);}
});
