import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';

const script=fileURLToPath(new URL('../../../scripts/check-provider-idempotency.mjs',import.meta.url));
/** A local provider: `good` honours Idempotency-Key like a payments API, `bad` applies every request it receives. */
async function provider(mode){
 const seen=new Map(),effects=new Map(),requests=[];
 const server=createServer(async(request,response)=>{
  const url=new URL(request.url,'http://localhost'),json=(status,body)=>response.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify(body));
  requests.push({method:request.method,url:request.url,authorization:request.headers.authorization});
  if(request.method==='GET'&&url.pathname==='/effects'){const key=url.searchParams.get('key');return json(200,{data:Array.from({length:effects.get(key)??0},(_,i)=>({i}))});}
  let body='';for await(const chunk of request)body+=chunk;const input=JSON.parse(body),key=request.headers['idempotency-key'];
  if(mode==='good'&&seen.has(key)){const previous=seen.get(key);return isDeepStrictEqual(previous.input,input)?json(200,previous.result):json(422,{error:'Keys may only be reused with the same request'});}
  effects.set(key,(effects.get(key)??0)+1);const result={id:'charge-'+key.slice(0,8),amount:input.amount};if(mode==='good')seen.set(key,{input,result});
  setTimeout(()=>json(200,mode==='good'?result:{id:'charge-'+Math.random(),amount:input.amount}),20);
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 return {url:`http://127.0.0.1:${server.address().port}`,requests,close:()=>{server.closeAllConnections();server.close();}};
}
// The provider runs inside this process, so the script must run asynchronously or it would wait on a blocked event loop.
const spawn=(args,env={})=>new Promise(resolve=>execFile(process.execPath,[script,...args],{encoding:'utf8',env:{...process.env,...env},timeout:60000},(error,stdout,stderr)=>resolve({status:error?(typeof error.code==='number'?error.code:1):0,stdout,stderr})));
const run=(directory,config,env={})=>{const path=join(directory,'config.json');writeFileSync(path,JSON.stringify(config));return spawn([path],env);};
const config=base=>({environment:'sandbox',allowHttp:true,dispatch:{url:base+'/charges',idempotencyHeader:'Idempotency-Key'},countEffects:{url:base+'/effects?key={key}',path:'data'},input:{amount:100},conflictingInput:{amount:250},concurrency:4});

test('the provider script passes a provider that honours idempotency keys and reports the failures of one that does not',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'provider-idempotency-'));const good=await provider('good'),bad=await provider('bad');
 try{
  const passing=await run(dir,config(good.url),{PROVIDER_HEADERS:JSON.stringify({authorization:'Bearer sandbox-token'})});assert.equal(passing.status,0,passing.stderr+passing.stdout);
  const report=JSON.parse(passing.stdout);assert.equal(report.passed,true);assert.deepEqual(report.findings,[]);
  assert.ok(good.requests.length>0&&good.requests.every(item=>item.authorization==='Bearer sandbox-token'),'credentials from the environment accompany every request');
  // A key header supplied in another letter case must not survive next to the one the check sets (the provider would see both joined).
  const cased=await run(dir,config(good.url),{PROVIDER_HEADERS:JSON.stringify({'idempotency-key':'not-the-checks-key'})});assert.equal(cased.status,0,cased.stderr+cased.stdout);
  // Every {key} in the effects URL is replaced.
  const twice=await run(dir,{...config(good.url),countEffects:{url:good.url+'/effects?key={key}&again={key}',path:'data'}});assert.equal(twice.status,0,twice.stderr+twice.stdout);
  const failing=await run(dir,config(bad.url));assert.equal(failing.status,1);const findings=JSON.parse(failing.stdout).findings.map(finding=>finding.check);
  assert.ok(findings.includes('sequential-replay')&&findings.includes('concurrent-replay'),'a provider that applies every request is reported: '+findings.join(','));
 }finally{good.close();bad.close();rmSync(dir,{recursive:true,force:true});}
});

test('the provider script refuses production, plain http to remote hosts, bad configs and credentials in URLs',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'provider-idempotency-'));
 try{
  const base=config('http://127.0.0.1:9');
  const cases=[
   [{...base,environment:'production'},/not "production"/],[{...base,environment:'prod'},/one of sandbox/],[{...base,environment:'live'},/one of sandbox/],[{...base,environment:'Production'},/not "production"/],[{...base,environment:''},/non-production target/],[{...base,environment:undefined},/non-production target/],
   [{...base,allowHttp:false},/must use https/],[{...base,dispatch:{...base.dispatch,url:'http://sandbox.example/charges'}},/must use https/],
   [{...base,dispatch:{...base.dispatch,url:'https://user:pass@sandbox.example/charges',},allowHttp:true},/must not contain credentials/],
   [{...base,dispatch:{...base.dispatch,method:'DELETE'}},/dispatch.method/],[{...base,dispatch:{...base.dispatch,idempotencyHeader:'bad header'}},/not a valid header name/],
   [{...base,countEffects:{url:'http://127.0.0.1:9/effects',path:'data'}},/must contain \{key\}/],[{...base,countEffects:{url:'http://127.0.0.1:9/e?k={key}'}},/countEffects.path/],
   [{dispatch:base.dispatch},/needs dispatch and countEffects/]
  ];
  for(const [value,message] of cases){const result=await run(dir,value);assert.equal(result.status,1,JSON.stringify(value));assert.match(result.stderr,message);}
  assert.match((await run(dir,base,{PROVIDER_HEADERS:'not json'})).stderr,/PROVIDER_HEADERS must be a JSON object/);
  assert.match((await run(dir,base,{PROVIDER_HEADERS:'{"a":1}'})).stderr,/object of strings/);
  assert.notEqual((await spawn([])).status,0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
