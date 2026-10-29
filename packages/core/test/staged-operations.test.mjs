import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CapabilityRegistry,SqliteStagedOperations,SqliteApplicationStore} from '../dist/index.js';
const scope={tenantId:'tenant',applicationId:'app'},context={tenantId:'tenant',principalId:'user',origin:'ui'};
test('staged operations survive restart and publication and submit only explicitly',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'app-mixer-staging-')),path=join(dir,'db.sqlite'),calls=[];
 let staged=new SqliteStagedOperations(path);
 try {
  const payload={order:{count:2}},op=staged.stage(scope,'placeOrder',payload);payload.order.count=9;
  assert.equal(staged.get(scope,op.id).payload.order.count,2);
  assert.equal(staged.get({...scope,tenantId:'other'},op.id),undefined);
  const store=new SqliteApplicationStore(path,{id:'app',schemaVersion:1,revision:0,pages:[]});store.publish(0);store.close();
  staged.close();staged=new SqliteStagedOperations(path);assert.equal(staged.get(scope,op.id).status,'staged');assert.equal(calls.length,0);
  const registry=new CapabilityRegistry(()=>{});
  registry.register({operationId:'placeOrder',method:'POST',path:'/orders'}, {authorize:()=>true,validate:input=>input.payload.order.count===2,execute:input=>{calls.push(input);return 'ok';}});
  assert.equal(await staged.submit(scope,op.id,registry,context),'ok');assert.equal(staged.get(scope,op.id).status,'succeeded');
  assert.deepEqual(calls,[{idempotencyKey:op.idempotencyKey,payload:{order:{count:2}}}]);
  await assert.rejects(staged.submit(scope,op.id,registry,context),/not staged/);assert.equal(calls.length,1);
 } finally {staged.close();rmSync(dir,{recursive:true,force:true});}
});
test('concurrent submissions claim once and uncertainty requires explicit reconciliation',async()=>{
 const staged=new SqliteStagedOperations(':memory:'),op=staged.stage(scope,'charge',{amount:10}),calls=[];
 let release;const gate=new Promise(resolve=>{release=resolve;});let failed=true;
 const registry=new CapabilityRegistry(()=>{});registry.register({operationId:'charge',method:'POST',path:'/charge'}, {authorize:()=>true,validate:()=>true,execute:async input=>{calls.push(input.idempotencyKey);await gate;if(failed)throw Error('unknown outcome');return 'done';}});
 try {
  const first=staged.submit(scope,op.id,registry,context);await new Promise(resolve=>setImmediate(resolve));
  await assert.rejects(staged.submit(scope,op.id,registry,context),/not staged/);release();await assert.rejects(first,/unknown outcome/);
  assert.equal(staged.get(scope,op.id).status,'uncertain');await assert.rejects(staged.submit(scope,op.id,registry,context),/not staged/);
  assert.throws(()=>staged.reconcile({...scope,tenantId:'other'},op.id,'not_applied'),/state/);
  staged.reconcile(scope,op.id,'not_applied');failed=false;assert.equal(await staged.submit(scope,op.id,registry,{...context,origin:'agent'}),'done');
  assert.deepEqual(calls,[op.idempotencyKey,op.idempotencyKey]);assert.equal(staged.get(scope,op.id).status,'succeeded');
 } finally {staged.close();}
});
test('unapproved submissions fail closed and require reconciliation before retry',async()=>{
 const staged=new SqliteStagedOperations(':memory:'),op=staged.stage(scope,'change',{value:1}),registry=new CapabilityRegistry(()=>{});let calls=0;
 registry.register({operationId:'change',method:'POST',path:'/change'}, {authorize:()=>false,validate:()=>true,execute:()=>calls++});
 try {
  await assert.rejects(staged.submit(scope,op.id,registry,{...context,tenantId:'other'}),/context/);assert.equal(staged.get(scope,op.id).status,'staged');
  await assert.rejects(staged.submit(scope,op.id,registry,context),/forbidden/);assert.equal(calls,0);assert.equal(staged.get(scope,op.id).status,'uncertain');
  staged.reconcile(scope,op.id,'applied');assert.equal(staged.get(scope,op.id).status,'succeeded');
 } finally {staged.close();}
});

test('abandoned in-flight submissions remain uncertain after a process exit',async()=>{
 const {spawnSync}=await import('node:child_process');
 const dir=mkdtempSync(join(tmpdir(),'app-mixer-crash-')),path=join(dir,'db.sqlite');
 const coreUrl=new URL('../dist/index.js',import.meta.url).href;
 const script=`import {SqliteStagedOperations,CapabilityRegistry} from ${JSON.stringify(coreUrl)};
 const store=new SqliteStagedOperations(process.env.STAGED_DB),scope={tenantId:'tenant',applicationId:'app'};
 const op=store.stage(scope,'charge',{amount:10});console.log(op.id);
 const registry=new CapabilityRegistry(()=>{});registry.register({operationId:'charge',method:'POST',path:'/charge'},{authorize:()=>true,validate:()=>true,execute:()=>process.exit(0)});
 await store.submit(scope,op.id,registry,{tenantId:'tenant',principalId:'user',origin:'ui'});`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{env:{...process.env,STAGED_DB:path},encoding:'utf8'});
 assert.equal(child.status,0,child.stderr);const id=child.stdout.trim(),store=new SqliteStagedOperations(path);
 try {
  assert.equal(store.get(scope,id).status,'submitting');
  assert.throws(()=>store.reconcile(scope,id,'not_applied'),/state/);
  store.recoverAbandoned(scope,id);assert.equal(store.get(scope,id).status,'uncertain');
  store.reconcile(scope,id,'applied');assert.equal(store.get(scope,id).status,'succeeded');
 } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('staged external submission reconciles a lost response against an idempotent HTTP service',async()=>{
 const {createServer}=await import('node:http');
 const effects=new Map();let requests=0;
 const server=createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const payload=JSON.parse(Buffer.concat(chunks).toString());const key=req.headers['idempotency-key'];requests++;
  if(!effects.has(key))effects.set(key,payload);
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const staged=new SqliteStagedOperations(':memory:'),op=staged.stage(scope,'orders.create',{sku:'ABC',quantity:2}),registry=new CapabilityRegistry(()=>{});
 registry.register({operationId:'orders.create',method:'POST',path:'/orders'}, {
  authorize:({principalId})=>principalId==='user',validate:input=>typeof input?.idempotencyKey==='string'&&input?.payload?.sku==='ABC',
  execute:async input=>{
   const response=await fetch(`http://127.0.0.1:${server.address().port}/orders`,{method:'POST',headers:{'content-type':'application/json','idempotency-key':input.idempotencyKey},body:JSON.stringify(input.payload)});
   assert.equal(response.status,200);throw Error('response lost after external effect');
  }
 });
 try {
  await assert.rejects(staged.submit(scope,op.id,registry,context),/response lost/);
  assert.equal(staged.get(scope,op.id).status,'uncertain');
  assert.deepEqual(effects.get(op.idempotencyKey),{sku:'ABC',quantity:2});
  staged.reconcile(scope,op.id,'applied');
  await assert.rejects(staged.submit(scope,op.id,registry,context),/not staged/);
  assert.equal(requests,1);assert.equal(effects.size,1);
 } finally {staged.close();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
