import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {checkIdempotencyContract} from '../dist/index.js';

// A small HTTP payment double whose idempotency behavior is selected per test.
async function service(mode){
 const byKey=new Map(),effects=new Map();let sequence=0;
 const server=createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString()),key=req.headers['idempotency-key'];
  const reply=(status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
  const apply=()=>{const result={id:'pay_'+(++sequence),amount:body.amount};effects.set(key,(effects.get(key)??0)+1);return result;};
  if(mode==='ignores-key')return reply(201,apply());
  const existing=byKey.get(key);
  if(existing){if(mode!=='accepts-conflict'&&JSON.stringify(existing.body)!==JSON.stringify(body))return reply(422,{error:'key reused'});return reply(200,existing.result);}
  if(mode==='racy')await new Promise(resolve=>setTimeout(resolve,20));
  const again=byKey.get(key);if(again&&mode!=='racy')return reply(200,again.result);
  const result=apply();byKey.set(key,{body,result});reply(201,result);
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${server.address().port}`;
 return {server,options:{input:{amount:100},conflictingInput:{amount:999},countEffects:async key=>effects.get(key)??0,dispatch:async(input,key)=>{const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json','idempotency-key':key},body:JSON.stringify(input)});const value=await response.json();if(!response.ok)throw Error(value.error);return value;}}};
}

test('idempotency contract passes a conforming service and reports each class of defect',async()=>{
 const expect={correct:[],'ignores-key':['sequential-replay','sequential-replay','concurrent-replay','concurrent-replay','conflicting-input','conflicting-input'],racy:['concurrent-replay','concurrent-replay'],'accepts-conflict':['conflicting-input']};
 for(const [mode,checks] of Object.entries(expect)){const {server,options}=await service(mode);try{const report=await checkIdempotencyContract(options);assert.equal(report.passed,checks.length===0,mode);assert.deepEqual(report.findings.map(finding=>finding.check),checks,mode+': '+JSON.stringify(report.findings));assert.equal(new Set(Object.values(report.keys)).size,3);}finally{server.close();}}
});

test('idempotency contract rejects unsafe configuration',async()=>{
 const base={dispatch:async()=>({}),countEffects:async()=>1,input:{a:1},conflictingInput:{a:2}};
 for(const bad of [{...base,conflictingInput:{a:1}},{...base,concurrency:1},{...base,concurrency:51},{...base,dispatch:undefined},{...base,input:[]},{...base,newKey:()=>'same'}])await assert.rejects(checkIdempotencyContract(bad),/Invalid idempotency contract/);
 await assert.rejects(checkIdempotencyContract({...base,countEffects:async()=>-1}),/Invalid effect count/);
});
