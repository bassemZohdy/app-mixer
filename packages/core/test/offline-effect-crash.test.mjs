import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CapabilityRegistry,SqliteOfflineQueue} from '../dist/index.js';
const scope={tenantId:'tenant',applicationId:'app'},other={tenantId:'other',applicationId:'app'},actor={tenantId:'tenant',principalId:'person',origin:'service'},policy={enabled:true,maxAttempts:2,retryDelayMs:0};
for(const phase of ['before','after'])test(`offline recovery after process death ${phase} provider commit`,{timeout:30000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'offline-effect-crash-')),path=join(dir,'db.sqlite'),effects=new Map(),requests=[];let queue=new SqliteOfflineQueue(path,policy),child,notify;const received=new Promise(resolve=>notify=resolve);
 const server=createServer(async(req,res)=>{const parts=[];for await(const part of req)parts.push(part);const input=JSON.parse(Buffer.concat(parts).toString());requests.push(input);if(requests.length===1){if(phase==='after')effects.set(input.idempotencyKey,input.payload);notify();return;}if(!effects.has(input.idempotencyKey))effects.set(input.idempotencyKey,input.payload);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true}));});
 try{
  const item=queue.enqueue(scope,'person','change','request',{value:'one'}),foreign=queue.enqueue(other,'person','change','request',{value:'other'});queue.close();queue=undefined;server.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${server.address().port}/effect`;
  child=fork(fileURLToPath(new URL('./fixtures/offline-effect-crash.mjs',import.meta.url)),[path,url],{stdio:['ignore','ignore','pipe','ipc']});let stderr='',problem;child.stderr.on('data',data=>stderr+=String(data));child.on('message',message=>{if(message?.error)problem=message.error;});const exit=once(child,'exit'),failed=()=>{throw Error('Worker exited before provider request: '+(problem??stderr));};let timer;try{await Promise.race([received,exit.then(failed),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Provider request timed out')),15000);})]);}finally{clearTimeout(timer);}child.kill('SIGKILL');await exit;child=undefined;
  queue=new SqliteOfflineQueue(path,policy);assert.equal(queue.get(scope,'person',item.id).status,'running');assert.equal(queue.get(other,'person',foreign.id).status,'pending');assert.equal(requests[0].idempotencyKey,item.idempotencyKey);const registry=new CapabilityRegistry(()=>{});registry.register({operationId:'change',method:'POST',path:'/change'},{authorize:()=>true,validate:()=>true,execute:async input=>{const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});return response.json();}});
  assert.equal(await queue.processOne(scope,actor,registry,()=> 'retry',20),undefined);queue.recoverAbandoned(scope,'person',item.id);assert.equal(queue.get(scope,'person',item.id).status,'uncertain');assert.equal(await queue.processOne(scope,actor,registry,()=> 'retry',20),undefined);
  queue.reconcile(scope,'person',item.id,phase==='after'?'applied':'not_applied');if(phase==='before'){assert.equal((await queue.processOne(scope,actor,registry,()=> 'uncertain',21)).status,'succeeded');assert.equal(requests.length,2);assert.equal(requests[1].idempotencyKey,item.idempotencyKey);}else assert.equal(requests.length,1);
  assert.equal(effects.size,1);assert.deepEqual(effects.get(item.idempotencyKey),{value:'one'});assert.equal(queue.get(other,'person',foreign.id).status,'pending');
 }finally{if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}queue?.close();server.closeAllConnections();if(server.listening)await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
});
