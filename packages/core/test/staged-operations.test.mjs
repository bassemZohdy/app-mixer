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
  if(req.method==='GET'){const key=new URL(req.url,'http://localhost').searchParams.get('key');res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({applied:effects.has(key)}));return;}
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
  const outcome=await staged.verifyAndReconcile(scope,op.id,async(_scope,operation)=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/status?key=${encodeURIComponent(operation.idempotencyKey)}`);return (await response.json()).applied?'applied':'unknown';});
  assert.equal(outcome,'applied');assert.equal(staged.get(scope,op.id).status,'succeeded');
  await assert.rejects(staged.submit(scope,op.id,registry,context),/not staged/);
  assert.equal(requests,1);assert.equal(effects.size,1);
 } finally {staged.close();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});

test('staging retries with the same request key return one durable intent and reject mismatches',()=>{
 const dir=mkdtempSync(join(tmpdir(),'app-mixer-stage-dedup-')),path=join(dir,'db.sqlite');
 const first=new SqliteStagedOperations(path),second=new SqliteStagedOperations(path);
 try {
  const op=first.stage(scope,'charge',{a:1,b:{x:2,y:3}},'request-1');
  const retried=second.stage(scope,'charge',{b:{y:3,x:2},a:1},'request-1');
  assert.deepEqual(retried,op);
  assert.throws(()=>second.stage(scope,'charge',{a:2},'request-1'),/conflict/);
  assert.throws(()=>second.stage(scope,'other',{a:1,b:{x:2,y:3}},'request-1'),/conflict/);
  assert.notEqual(second.stage({...scope,tenantId:'other'},'charge',{a:2},'request-1').id,op.id);
  assert.notEqual(second.stage({...scope,applicationId:'other'},'charge',{a:2},'request-1').id,op.id);
  assert.notEqual(second.stage(scope,'charge',{a:2}).id,op.id);
  const zero=first.stage(scope,'charge',{n:-0},'zero');assert.equal(second.stage(scope,'charge',{n:-0},'zero').id,zero.id);assert.equal(Object.is(zero.payload.n,-0),false);
  assert.throws(()=>first.stage(scope,'charge',{},''),/Invalid/);
 } finally {first.close();second.close();rmSync(dir,{recursive:true,force:true});}
});

test('existing staging databases migrate without losing operations',async()=>{
 const {DatabaseSync}=await import('node:sqlite');
 const dir=mkdtempSync(join(tmpdir(),'app-mixer-stage-migration-')),path=join(dir,'db.sqlite'),db=new DatabaseSync(path);
 db.exec(`CREATE TABLE staged_business_operations (tenant_id TEXT NOT NULL, application_id TEXT NOT NULL, id TEXT NOT NULL, operation_id TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY(tenant_id,application_id,id)); INSERT INTO staged_business_operations VALUES ('tenant','app','old','charge','old-key','{"amount":10}','staged');`);db.close();
 const store=new SqliteStagedOperations(path);
 try {assert.equal(store.get(scope,'old').idempotencyKey,'old-key');const op=store.stage(scope,'charge',{amount:10},'new-request');assert.equal(store.stage(scope,'charge',{amount:10},'new-request').id,op.id);}
 finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('provider verification fails closed and stale results cannot resolve a later attempt',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'staged-verify-')),path=join(dir,'db.sqlite'),first=new SqliteStagedOperations(path),second=new SqliteStagedOperations(path),op=first.stage(scope,'charge',{amount:10}),registry=new CapabilityRegistry(()=>{});
 registry.register({operationId:'charge',method:'POST',path:'/charge'},{authorize:()=>true,validate:()=>true,execute:()=>{throw Error('unknown')}});
 try{
  await assert.rejects(first.verifyAndReconcile(scope,op.id,()=> 'applied'),/state/);await assert.rejects(first.submit(scope,op.id,registry,context),/unknown/);
  await assert.rejects(first.verifyAndReconcile({...scope,tenantId:'other'},op.id,()=> 'applied'),/state/);
  assert.equal(await first.verifyAndReconcile(scope,op.id,()=> 'unknown'),'unknown');await assert.rejects(first.verifyAndReconcile(scope,op.id,()=> 'invalid'),/verification outcome/);await assert.rejects(first.verifyAndReconcile(scope,op.id,()=>{throw Error('provider down')}),/provider down/);assert.equal(first.get(scope,op.id).status,'uncertain');
  let unblock,started;const waiting=new Promise(resolve=>unblock=resolve),entered=new Promise(resolve=>started=resolve),mutableScope={...scope};const verification=first.verifyAndReconcile(mutableScope,op.id,async(s,operation)=>{assert.deepEqual(s,scope);assert.equal(operation.idempotencyKey,op.idempotencyKey);s.tenantId='other';operation.payload.amount=999;started();await waiting;return 'applied';},{principalId:'reviewer',reference:'stale-case'});await entered;mutableScope.tenantId='other';
  second.reconcile(scope,op.id,'not_applied');await assert.rejects(second.submit(scope,op.id,registry,context),/unknown/);unblock();await assert.rejects(verification,/Stale staged verification/);assert.equal(first.get(scope,op.id).status,'uncertain');assert.deepEqual(first.get(scope,op.id).payload,{amount:10});assert.deepEqual(first.listReconciliationEvidence(scope,op.id),[]);
  assert.equal(await second.verifyAndReconcile(scope,op.id,()=> 'not_applied'),'not_applied');assert.equal(first.get(scope,op.id).status,'staged');
 }finally{first.close();second.close();rmSync(dir,{recursive:true,force:true});}
});
