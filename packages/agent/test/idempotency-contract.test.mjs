import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {checkIdempotencyContract} from '../dist/index.js';

// A small HTTP payment double whose idempotency behavior is selected per test.
async function service(mode){
 const concurrency=5,byKey=new Map(),effects=new Map();let sequence=0,countChecks=0,arrivals=0,concurrentCalls=0,release;const concurrentGate=new Promise(resolve=>release=resolve);
 const server=createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString()),key=req.headers['idempotency-key'];
  const reply=(status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
  const apply=()=>{const result={id:'pay_'+(++sequence),amount:body.amount};effects.set(key,(effects.get(key)??0)+1);return result;};
  if(mode==='ignores-key')return reply(201,apply());
  if(mode==='forgets-concurrent'&&countChecks===1&&++concurrentCalls===concurrency+1)byKey.delete(key);
  const existing=byKey.get(key);
  if(existing){if(mode!=='accepts-conflict'&&JSON.stringify(existing.body)!==JSON.stringify(body))return reply(422,{error:'key reused'});return reply(200,existing.result);}
  // Hold every concurrent request after its first lookup until all have arrived.
  if(mode==='racy'&&countChecks===1){if(++arrivals===concurrency)release();await concurrentGate;}
  const again=byKey.get(key);if(again&&mode!=='racy')return reply(200,again.result);
  const result=apply();byKey.set(key,{body,result});reply(201,result);
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${server.address().port}`;
 return {server,options:{concurrency,input:{amount:100},conflictingInput:{amount:999},countEffects:async key=>{countChecks++;return effects.get(key)??0;},dispatch:async(input,key)=>{const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json','idempotency-key':key},body:JSON.stringify(input)});const value=await response.json();if(!response.ok)throw Error(value.error);return value;}}};
}

test('idempotency contract passes a conforming service and reports each class of defect',{timeout:15000},async()=>{
 const expect={correct:[],'ignores-key':['sequential-replay','sequential-replay','concurrent-replay','concurrent-replay','conflicting-input','conflicting-input'],racy:['concurrent-replay','concurrent-replay'],'forgets-concurrent':['concurrent-replay','concurrent-replay'],'accepts-conflict':['conflicting-input']};
 for(const [mode,checks] of Object.entries(expect)){const {server,options}=await service(mode);try{const report=await checkIdempotencyContract(options);assert.equal(report.passed,checks.length===0,mode);assert.deepEqual(report.findings.map(finding=>finding.check),checks,mode+': '+JSON.stringify(report.findings));assert.equal(new Set(Object.values(report.keys)).size,3);}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}}
});

test('idempotency contract rejects unsafe configuration',async()=>{
 const base={dispatch:async()=>({}),countEffects:async()=>1,input:{a:1},conflictingInput:{a:2}};
 for(const bad of [{...base,conflictingInput:{a:1}},{...base,concurrency:1},{...base,concurrency:51},{...base,dispatch:undefined},{...base,input:[]},{...base,newKey:()=>'same'}])await assert.rejects(checkIdempotencyContract(bad),/Invalid idempotency contract/);
 await assert.rejects(checkIdempotencyContract({...base,countEffects:async()=>-1}),/Invalid effect count/);
});


test('idempotency check snapshots host inputs and callback references before async work',async()=>{
 let entered,release;const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),effects=new Map(),seen=[],input={amount:100},conflictingInput={amount:999};let first=true;const options={input,conflictingInput,countEffects:async key=>effects.has(key)?1:0,dispatch:async(value,key)=>{seen.push(structuredClone(value));if(first){first=false;entered();await gate;}const previous=effects.get(key);if(previous){if(previous.amount!==value.amount)throw Error('key conflict');return previous;}const result={amount:value.amount};effects.set(key,result);return result;}};
 const pending=checkIdempotencyContract(options);await ready;input.amount=200;conflictingInput.amount=200;options.dispatch=async()=>{throw Error('replacement dispatch used');};options.countEffects=async()=>99;release();const report=await pending;assert.equal(report.passed,true);assert.equal(seen.filter(value=>value.amount===100).length,9);assert.equal(seen.filter(value=>value.amount===999).length,1);
});


test('a temporary concurrent rejection is allowed when a later replay resolves to the same effect',async()=>{
 const effects=new Map();let checks=0,attempts=0;const report=await checkIdempotencyContract({input:{amount:100},conflictingInput:{amount:999},countEffects:async key=>{checks++;return effects.has(key)?1:0;},dispatch:async(value,key)=>{if(checks===1&&++attempts>1&&attempts<=5)throw Error('in progress');const current=effects.get(key);if(current){if(current.amount!==value.amount)throw Error('key conflict');return current;}const result={amount:value.amount};effects.set(key,result);return result;}});assert.equal(report.passed,true);assert.equal(attempts,6);
});


test('idempotency check preserves the host callback receiver',async()=>{
 const options={input:{amount:1},conflictingInput:{amount:2},effects:new Map(),async countEffects(key){return this.effects.has(key)?1:0;},async dispatch(input,key){const existing=this.effects.get(key);if(existing){if(existing.amount!==input.amount)throw Error('conflict');return existing;}const result={amount:input.amount};this.effects.set(key,result);return result;}};assert.equal((await checkIdempotencyContract(options)).passed,true);
});

test('contract deadline interrupts a stalled dispatch and retains keys for investigation',async()=>{
 let signal,release,dispatches=0,counts=0;const pending=new Promise(resolve=>release=resolve),options={input:{value:1},conflictingInput:{value:2},timeoutMs:25,newKey:(()=>{let n=0;return()=>`test-${++n}`;})(),countEffects:async()=>{counts++;return 1;},dispatch:async(_value,_key,s)=>{dispatches++;signal=s;await pending;return {ok:true};}};
 await assert.rejects(checkIdempotencyContract(options),error=>error.name==='IdempotencyContractInterruptedError'&&/timed out/.test(error.message)&&error.keys.replay==='test-1'&&error.keys.concurrent==='test-2');assert.equal(signal.aborted,true);release();await new Promise(resolve=>setImmediate(resolve));assert.equal(dispatches,1);assert.equal(counts,0);
});

test('caller cancellation interrupts parallel work without starting later checks',async()=>{
 let count=0,dispatches=0,ready,release;const entered=new Promise(resolve=>ready=resolve),gate=new Promise(resolve=>release=resolve),controller=new AbortController();const options={input:{value:1},conflictingInput:{value:2},concurrency:3,signal:controller.signal,countEffects:async()=>{count++;return 1;},dispatch:async(_value,_key,signal)=>{dispatches++;if(dispatches<=2)return {ok:true};if(dispatches===5)ready();await gate;assert.equal(signal.aborted,true);return {ok:true};}};
 const result=checkIdempotencyContract(options);await entered;controller.abort();await assert.rejects(result,error=>error.name==='IdempotencyContractInterruptedError'&&/cancelled/.test(error.message)&&Object.keys(error.keys).length===3);release();await new Promise(resolve=>setImmediate(resolve));assert.equal(dispatches,5);assert.equal(count,1);
 const pre=new AbortController();pre.abort();await assert.rejects(checkIdempotencyContract({...options,signal:pre.signal}),/cancelled/);assert.equal(dispatches,5);
});

test('deadline rejects invalid settings and interrupts stalled effect reads',async()=>{
 const base={input:{value:1},conflictingInput:{value:2},dispatch:async()=>({ok:true}),countEffects:async()=>new Promise(()=>{})};for(const timeoutMs of [0,-1,300001,1.5,'20'])await assert.rejects(checkIdempotencyContract({...base,timeoutMs}),/Invalid idempotency contract configuration/);await assert.rejects(checkIdempotencyContract({...base,signal:{}}),/Invalid idempotency contract configuration/);await assert.rejects(checkIdempotencyContract({...base,timeoutMs:20}),/timed out/);
});

test('provider errors after possible effects retain all keys and preserve the cause',async()=>{
 const original=Error('response lost after commit'),keys=(()=>{let n=0;return()=>`key-${++n}`;})();let effects=0,reads=0;const options={input:{value:1},conflictingInput:{value:2},newKey:keys,dispatch:async()=>{effects++;throw original;},countEffects:async()=>{reads++;return effects;}};
 await assert.rejects(checkIdempotencyContract(options),error=>error.name==='IdempotencyContractExecutionError'&&error.cause===original&&error.keys.replay==='key-1'&&error.keys.concurrent==='key-2'&&error.keys.fresh==='key-3');assert.equal(effects,1);assert.equal(reads,0);
 const readError=Error('independent read unavailable');await assert.rejects(checkIdempotencyContract({...options,newKey:(()=>{let n=0;return()=>`read-${++n}`;})(),dispatch:async()=>({ok:true}),countEffects:async()=>{throw readError;}}),error=>error.name==='IdempotencyContractExecutionError'&&error.cause===readError&&error.keys.replay==='read-1');
});

test('replay comparison snapshots returned objects before a provider can mutate them',async()=>{
 const effects=new Map();let counter=0;const report=await checkIdempotencyContract({input:{amount:1},conflictingInput:{amount:2},newKey:()=>`snapshot-${++counter}`,countEffects:async key=>effects.has(key)?1:0,dispatch:async(input,key)=>{const prior=effects.get(key);if(prior){if(input.amount!==1)throw Error('key conflict');if(key==='snapshot-1')prior.version++;return prior;}const result={version:1};effects.set(key,result);return result;}});
 assert.equal(report.passed,false);assert.deepEqual(report.findings,[{check:'sequential-replay',problem:'replay returned a different result'}]);
});

test('uncloneable provider results fail the check with retained investigation keys',async()=>{
 let n=0;await assert.rejects(checkIdempotencyContract({input:{a:1},conflictingInput:{a:2},newKey:()=>`bad-result-${++n}`,dispatch:async()=>({bad:()=>{}}),countEffects:async()=>1}),error=>error.name==='IdempotencyContractExecutionError'&&error.keys.replay==='bad-result-1'&&error.cause?.name==='DataCloneError');
});
