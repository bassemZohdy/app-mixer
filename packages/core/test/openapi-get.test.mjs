import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {CapabilityRegistry,createOpenAPIGetBinding} from '../dist/index.js';
async function start(server){server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${server.address().port}`;}
async function stop(server){await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
const spec={openapi:'3.1.0',paths:{'/customers/{id}':{get:{operationId:'getCustomer',parameters:[{name:'id',in:'path',required:true,schema:{type:'string',maxLength:20}},{name:'limit',in:'query',schema:{type:'integer',minimum:1,maximum:10}}]}}}};

test('explicit OpenAPI GET binding validates parameters and enforces policy before REST calls',async()=>{
  const requests=[];const service=createServer((req,res)=>{requests.push(req.url);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({name:'Ada'}));});
  const url=await start(service);
  try{
    const {candidate,binding}=createOpenAPIGetBinding(spec,'getCustomer',{baseURL:url,authorize:ctx=>ctx.tenantId==='tenant-a'&&ctx.principalId==='alice'});
    const audit=[],registry=new CapabilityRegistry(event=>audit.push(event));registry.register(candidate,binding);
    for(const origin of ['ui','agent']){
      await assert.rejects(registry.invoke('getCustomer',{path:{id:'abc'},query:{limit:2}},{tenantId:'other',principalId:'alice',origin}),/forbidden/);
      await assert.rejects(registry.invoke('getCustomer',{path:{id:'../x'},query:{limit:2}},{tenantId:'tenant-a',principalId:'alice',origin}),/Invalid capability input/);
      await assert.rejects(registry.invoke('getCustomer',{path:{id:'abc'},query:{limit:11}},{tenantId:'tenant-a',principalId:'alice',origin}),/Invalid capability input/);
      const result=await registry.invoke('getCustomer',{path:{id:'abc'},query:{limit:2}},{tenantId:'tenant-a',principalId:'alice',origin});assert.equal(result.name,'Ada');
    }
    assert.deepEqual(requests,['/customers/abc?limit=2','/customers/abc?limit=2']);
    assert.equal(audit.filter(e=>e.outcome==='succeeded').length,2);
  }finally{await stop(service);}
});

test('rejects untrusted endpoints, unsupported schemas and redirects',async()=>{
  assert.throws(()=>createOpenAPIGetBinding(spec,'getCustomer',{baseURL:'http://example.com',authorize:()=>true}),/Untrusted/);
  const unsupported=structuredClone(spec);unsupported.paths['/customers/{id}'].get.parameters[0].schema.pattern='.*';
  assert.throws(()=>createOpenAPIGetBinding(unsupported,'getCustomer',{baseURL:'http://127.0.0.1:1',authorize:()=>true}),/Unsupported parameter schema/);
  const service=createServer((_req,res)=>{res.writeHead(302,{location:'http://127.0.0.1:1/'});res.end();});const url=await start(service);
  try{
    const {candidate,binding}=createOpenAPIGetBinding(spec,'getCustomer',{baseURL:url,authorize:()=>true});
    const registry=new CapabilityRegistry(()=>{});registry.register(candidate,binding);
    await assert.rejects(registry.invoke('getCustomer',{path:{id:'abc'}},{tenantId:'t',principalId:'p',origin:'ui'}));
  }finally{await stop(service);}
});
