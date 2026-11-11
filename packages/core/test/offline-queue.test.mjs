import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {CapabilityRegistry,SqliteOfflineQueue,SqliteStagedOperations} from '../dist/index.js';
const scope={tenantId:'t',applicationId:'a'},actor={tenantId:'t',principalId:'p',origin:'service'},policy={enabled:true,maxAttempts:2,retryDelayMs:100};
const candidate={operationId:'update',method:'POST',path:'/update'};

test('separate offline queues accept a host-issued shared idempotency key',async()=>{
 const first=new SqliteOfflineQueue(':memory:',policy),second=new SqliteOfflineQueue(':memory:',policy),effects=new Map(),registry=new CapabilityRegistry(()=>{});registry.register(candidate,{authorize:()=>true,validate:()=>true,execute:input=>{if(!effects.has(input.idempotencyKey))effects.set(input.idempotencyKey,input.payload);return 'ok';}});
 try{const key='shared-key',a=first.enqueue(scope,'p','update','logical',{value:1},{idempotencyKey:key}),b=second.enqueue(scope,'p','update','logical',{value:1},{idempotencyKey:key});assert.equal(a.idempotencyKey,b.idempotencyKey);assert.throws(()=>first.enqueue(scope,'p','update','logical',{value:1},{idempotencyKey:'other'}),/conflict/);assert.equal(first.enqueue(scope,'p','update','logical',{value:1}).idempotencyKey,key);await first.processOne(scope,actor,registry,()=> 'uncertain',10);await second.processOne(scope,actor,registry,()=> 'uncertain',10);assert.equal(effects.size,1);assert.deepEqual(effects.get(key),{value:1});}finally{first.close();second.close();}
});

test('offline queue requires explicit enablement and deduplicates durable intents',()=>{
 assert.throws(()=>new SqliteOfflineQueue(':memory:',{...policy,enabled:false}),/policy/);
 const dir=mkdtempSync(join(tmpdir(),'app-mixer-offline-')),path=join(dir,'db.sqlite');let queue=new SqliteOfflineQueue(path,policy);
 try{
  const payload={name:'one',nested:{x:1,y:2}},item=queue.enqueue(scope,'p','update','req',payload);payload.name='mutated';
  assert.equal(queue.enqueue(scope,'p','update','req',{nested:{y:2,x:1},name:'one'}).id,item.id);
  assert.throws(()=>queue.enqueue(scope,'p','update','req',{name:'different'}),/conflict/);
  assert.notEqual(queue.enqueue(scope,'other','update','req',{name:'other'}).id,item.id);
  assert.equal(queue.get({...scope,tenantId:'other'},'p',item.id),undefined);
  queue.close();queue=new SqliteOfflineQueue(path,policy);assert.equal(queue.get(scope,'p',item.id).payload.name,'one');
  assert.equal(queue.list(scope,'p').length,1);
 }finally{queue.close();rmSync(dir,{recursive:true,force:true});}
});


test('terminal offline records archive atomically while retaining request fences',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'offline-archive-')),path=join(dir,'queue.sqlite'),registry=new CapabilityRegistry(()=>{}),proof={operatorId:'operator',reference:'retention-case'};let queue=new SqliteOfflineQueue(path,policy),db=new DatabaseSync(path);registry.register(candidate,{authorize:()=>true,validate:()=>true,execute:()=> 'ok'});
 try{
  const item=queue.enqueue(scope,'p','update','request',{secret:'private'},{idempotencyKey:'shared-key'}),pending=queue.enqueue(scope,'p','update','pending',{v:2}),other=queue.enqueue({...scope,tenantId:'other'},'p','update','request',{v:3});assert.throws(()=>queue.archiveTerminal(scope,'p',pending.id,proof,100),/state/);assert.equal(queue.getArchived(scope,'p',pending.id),undefined);assert.equal((await queue.processOne(scope,actor,registry,()=> 'uncertain',10)).status,'succeeded');
  db.exec("CREATE TRIGGER fail_archive_delete BEFORE DELETE ON offline_operations BEGIN SELECT RAISE(ABORT,'forced archive failure'); END");assert.throws(()=>queue.archiveTerminal(scope,'p',item.id,proof,100),/forced archive failure/);assert.equal(queue.get(scope,'p',item.id).status,'succeeded');assert.equal(queue.getArchived(scope,'p',item.id),undefined);db.exec('DROP TRIGGER fail_archive_delete');
  queue.archiveTerminal(scope,'p',item.id,proof,100);assert.equal(queue.get(scope,'p',item.id),undefined);assert.deepEqual(queue.getArchived(scope,'p',item.id),{id:item.id,operationId:'update',requestKey:'request',idempotencyKey:'shared-key',status:'succeeded',operatorId:'operator',reference:'retention-case',recordedAt:100});assert.equal(queue.getArchived({...scope,tenantId:'other'},'p',item.id),undefined);assert.equal(queue.get({...scope,tenantId:'other'},'p',other.id).status,'pending');assert.throws(()=>queue.enqueue(scope,'p','update','request',{secret:'private'}),/archived/);assert.throws(()=>queue.enqueue({...scope,tenantId:'other'},'p','update','another',{v:1},{idempotencyKey:'shared-key'}),/archived/);
  assert.throws(()=>db.prepare("INSERT INTO offline_operations VALUES (?,?,?,?,?,?,?,?,?,?,?)").run('t','a','p','legacy-id','update','request','another-key','{}','pending',0,0),/archived/);assert.throws(()=>db.prepare("INSERT INTO offline_operations VALUES (?,?,?,?,?,?,?,?,?,?,?)").run('other','a','p','legacy-id','update','other-request','shared-key','{}','pending',0,0),/archived/);assert.throws(()=>db.prepare("UPDATE offline_archived_operations SET reference='changed'").run(),/immutable/);assert.throws(()=>db.prepare('DELETE FROM offline_archived_operations').run(),/immutable/);
  queue.close();queue=new SqliteOfflineQueue(path,policy);assert.equal(queue.getArchived(scope,'p',item.id).reference,'retention-case');assert.throws(()=>queue.enqueue(scope,'p','update','request',{secret:'private'}),/archived/);queue.discard(scope,'p',pending.id);queue.archiveTerminal(scope,'p',pending.id,proof,101);assert.equal(queue.getArchived(scope,'p',pending.id).status,'discarded');
 }finally{db.close();queue.close();rmSync(dir,{recursive:true,force:true});}
});



test('terminal time tracking preserves legacy inserts and supports safe age filtering',()=>{
 const dir=mkdtempSync(join(tmpdir(),'offline-terminal-time-')),path=join(dir,'queue.sqlite');let db=new DatabaseSync(path),queue;try{
  db.exec("CREATE TABLE offline_operations (tenant_id TEXT NOT NULL,application_id TEXT NOT NULL,principal_id TEXT NOT NULL,id TEXT NOT NULL,operation_id TEXT NOT NULL,request_key TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,payload TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL,next_attempt_at INTEGER NOT NULL,PRIMARY KEY(tenant_id,application_id,principal_id,id),UNIQUE(tenant_id,application_id,principal_id,request_key));");db.prepare('INSERT INTO offline_operations VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('t','a','p','old','update','old-request','old-key','{}','succeeded',1,0);db.close();db=undefined;queue=new SqliteOfflineQueue(path,policy);db=new DatabaseSync(path);assert.equal(queue.get(scope,'p','old').completedAt,undefined);
  const item=queue.enqueue(scope,'p','update','new-request',{v:1}),before=Date.now();queue.discard(scope,'p',item.id);const after=Date.now(),completed=queue.get(scope,'p',item.id).completedAt;assert.ok(completed>=before&&completed<=after);let all=queue.listArchiveRecords(scope,'p','update','candidates');assert.equal(all.items.find(x=>x.id==='old').completedAt,undefined);assert.equal(all.items.find(x=>x.id===item.id).completedAt,completed);assert.deepEqual(queue.listArchiveRecords(scope,'p','update','candidates',{completedBefore:completed}).items,[]);assert.deepEqual(queue.listArchiveRecords(scope,'p','update','candidates',{completedBefore:completed+1}).items.map(x=>x.id),[item.id]);
  const expected=queue.get(scope,'p',item.id);db.prepare('UPDATE offline_terminal_times SET completed_at=? WHERE id=?').run(completed+1,item.id);assert.throws(()=>queue.archiveTerminal(scope,'p',item.id,{operatorId:'operator',reference:'case'},1,expected),/stale/i);assert.equal(queue.get(scope,'p',item.id).status,'discarded');assert.throws(()=>queue.listArchiveRecords(scope,'p','update','archived',{completedBefore:10}),/query/);assert.throws(()=>queue.listArchiveRecords(scope,'p','update','candidates',{completedBefore:-1}),/query/);
  db.prepare('INSERT INTO offline_operations VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('t','a','p','legacy-new','update','legacy-new','legacy-key','{}','pending',0,0);db.prepare("UPDATE offline_operations SET status='discarded' WHERE id=?").run('legacy-new');assert.ok(Number.isSafeInteger(queue.get(scope,'p','legacy-new').completedAt));queue.archiveTerminal(scope,'p',item.id,{operatorId:'operator',reference:'case'},1);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM offline_terminal_times WHERE id=?').get(item.id).n,0);
 }finally{db?.close();queue?.close();rmSync(dir,{recursive:true,force:true});}
});

test('retirement cannot remove an in-flight or uncertain operation',async()=>{
 const queue=new SqliteOfflineQueue(':memory:',policy),registry=new CapabilityRegistry(()=>{}),proof={operatorId:'operator',reference:'case'};let started,release;const running=new Promise(resolve=>started=resolve),wait=new Promise(resolve=>release=resolve);registry.register(candidate,{authorize:()=>true,validate:()=>true,execute:async()=>{started();await wait;throw Error('ambiguous');}});
 try{const item=queue.enqueue(scope,'p','update','request',{v:1}),work=queue.processOne(scope,actor,registry,()=> 'uncertain',10);await running;assert.equal(queue.get(scope,'p',item.id).status,'running');assert.throws(()=>queue.archiveTerminal(scope,'p',item.id,proof,10),/state/);release();assert.equal((await work).status,'uncertain');assert.throws(()=>queue.archiveTerminal(scope,'p',item.id,proof,11),/state/);assert.equal(queue.getArchived(scope,'p',item.id),undefined);queue.reconcile(scope,'p',item.id,'applied');queue.archiveTerminal(scope,'p',item.id,proof,12);assert.equal(queue.getArchived(scope,'p',item.id).status,'succeeded');}finally{release?.();queue.close();}
});

test('archiving terminal records releases queue capacity without allowing identity reuse',()=>{
 const queue=new SqliteOfflineQueue(':memory:',policy),proof={operatorId:'operator',reference:'case'};try{let first;for(let i=0;i<1000;i++){const item=queue.enqueue(scope,'p','update','r'+i,{value:i});if(i===0)first=item;}assert.throws(()=>queue.enqueue(scope,'p','update','overflow',{}),/full/);queue.discard(scope,'p',first.id);queue.archiveTerminal(scope,'p',first.id,proof,0);assert.equal(queue.list(scope,'p').length,999);assert.ok(queue.enqueue(scope,'p','update','overflow',{}));assert.throws(()=>queue.enqueue(scope,'p','update','r0',{value:0}),/archived/);}finally{queue.close();}
});

test('bounded retries preserve the key, reauthorize, and remain separate from staged operations',async()=>{
 const queue=new SqliteOfflineQueue(':memory:',policy),staged=new SqliteStagedOperations(':memory:'),events=[],keys=[];let attempts=0;
 const registry=new CapabilityRegistry(event=>events.push(event.outcome));registry.register(candidate,{authorize:ctx=>ctx.principalId==='p',validate:()=>true,execute:input=>{keys.push(input.idempotencyKey);if(++attempts===1)throw Error('known pre-effect outage');return 'ok';}});
 try{
  const item=queue.enqueue(scope,'p','update','r',{v:1}),manual=staged.stage(scope,'update',{v:2});
  const first=await queue.processOne(scope,actor,registry,()=> 'retry',1000);assert.equal(first.status,'pending');assert.equal(first.attempts,1);assert.equal(first.nextAttemptAt,1100);
  assert.equal(await queue.processOne(scope,actor,registry,()=> 'retry',1099),undefined);
  const second=await queue.processOne(scope,actor,registry,()=> 'retry',1100);assert.equal(second.status,'succeeded');assert.equal(second.attempts,2);
  assert.deepEqual(keys,[item.idempotencyKey,item.idempotencyKey]);assert.equal(staged.get(scope,manual.id).status,'staged');
  assert.deepEqual(events,['attempt','failed','attempt','succeeded']);
 }finally{queue.close();staged.close();}
});

test('conflicts and uncertain outcomes stop replay until a host decision',async()=>{
 const queue=new SqliteOfflineQueue(':memory:',policy),registry=new CapabilityRegistry(()=>{});let mode='conflict',calls=0;
 registry.register(candidate,{authorize:()=>true,validate:()=>true,execute:()=>{calls++;throw Error(mode);}});
 try{
  const conflict=queue.enqueue(scope,'p','update','conflict',{});
  assert.equal((await queue.processOne(scope,actor,registry,()=> 'conflict',1)).status,'conflict');
  assert.equal(await queue.processOne(scope,actor,registry,()=> 'retry',2),undefined);queue.discard(scope,'p',conflict.id);assert.equal(queue.get(scope,'p',conflict.id).status,'discarded');
  const uncertain=queue.enqueue(scope,'p','update','uncertain',{});mode='lost';
  assert.equal((await queue.processOne(scope,actor,registry,()=> 'uncertain',3)).status,'uncertain');
  assert.throws(()=>queue.discard(scope,'p',uncertain.id),/state/);assert.equal(await queue.processOne(scope,actor,registry,()=> 'retry',4),undefined);
  queue.reconcile(scope,'p',uncertain.id,'applied');assert.equal(queue.get(scope,'p',uncertain.id).status,'succeeded');assert.equal(calls,2);
 }finally{queue.close();}
});

test('one claimant executes, actor changes do not affect in-flight work, and retry limits hold',async()=>{
 const queue=new SqliteOfflineQueue(':memory:',policy),registry=new CapabilityRegistry(()=>{});let release,started;
 const gate=new Promise(resolve=>release=resolve),signal=new Promise(resolve=>started=resolve),contexts=[];
 registry.register(candidate,{authorize:()=>true,validate:()=>true,execute:async(_input,ctx)=>{contexts.push(ctx);started();await gate;throw Error('safe retry');}});
 try{
  const item=queue.enqueue(scope,'p','update','one',{}),mutableScope={...scope},mutableActor={...actor};
  const first=queue.processOne(mutableScope,mutableActor,registry,()=> 'retry',1);await signal;
  mutableScope.tenantId='evil';mutableActor.principalId='other';
  assert.equal(await queue.processOne(scope,actor,registry,()=> 'retry',1),undefined);release();assert.equal((await first).status,'pending');
  assert.deepEqual(contexts,[{tenantId:'t',principalId:'p'}]);assert.equal(queue.get(scope,'p',item.id).attempts,1);
  assert.equal((await queue.processOne(scope,actor,registry,()=> 'retry',101)).status,'exhausted');
 }finally{queue.close();}
});

test('process exit leaves an uncertain operation requiring explicit recovery',async()=>{
 const {spawnSync}=await import('node:child_process');
 const dir=mkdtempSync(join(tmpdir(),'app-mixer-offline-crash-')),path=join(dir,'db.sqlite'),moduleUrl=new URL('../dist/index.js',import.meta.url).href;
 const script=`import {SqliteOfflineQueue,CapabilityRegistry} from ${JSON.stringify(moduleUrl)};
 const q=new SqliteOfflineQueue(process.env.OFFLINE_DB,{enabled:true,maxAttempts:2,retryDelayMs:0}),scope={tenantId:'t',applicationId:'a'};
 const item=q.enqueue(scope,'p','update','req',{x:1});console.log(item.id);
 const r=new CapabilityRegistry(()=>{});r.register({operationId:'update',method:'POST',path:'/'},{authorize:()=>true,validate:()=>true,execute:()=>process.exit(0)});
 await q.processOne(scope,{tenantId:'t',principalId:'p',origin:'service'},r,()=> 'retry');`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',env:{...process.env,OFFLINE_DB:path}});assert.equal(child.status,0,child.stderr);
 const id=child.stdout.trim(),queue=new SqliteOfflineQueue(path,policy),registry=new CapabilityRegistry(()=>{});let calls=0;
 registry.register(candidate,{authorize:()=>true,validate:()=>true,execute:()=>{calls++;}});
 try{
  assert.equal(queue.get(scope,'p',id).status,'running');assert.equal(await queue.processOne(scope,actor,registry,()=> 'retry'),undefined);
  queue.recoverAbandoned(scope,'p',id);assert.equal(queue.get(scope,'p',id).status,'uncertain');
  assert.equal(await queue.processOne(scope,actor,registry,()=> 'retry'),undefined);assert.equal(calls,0);
  queue.reconcile(scope,'p',id,'not_applied');assert.equal((await queue.processOne(scope,actor,registry,()=> 'uncertain')).status,'succeeded');assert.equal(calls,1);
 }finally{queue.close();rmSync(dir,{recursive:true,force:true});}
});

test('a stricter reopened retry limit exhausts pending work without execution',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'app-mixer-offline-policy-')),path=join(dir,'db.sqlite');let queue=new SqliteOfflineQueue(path,policy),calls=0;
 const registry=new CapabilityRegistry(()=>{});registry.register(candidate,{authorize:()=>true,validate:()=>true,execute:()=>{calls++;throw Error('pre-effect');}});
 try{
  const item=queue.enqueue(scope,'p','update','req',{});assert.equal((await queue.processOne(scope,actor,registry,()=> 'retry',1)).status,'pending');
  queue.close();queue=new SqliteOfflineQueue(path,{...policy,maxAttempts:1});
  assert.equal(await queue.processOne(scope,actor,registry,()=> 'retry',200),undefined);assert.equal(queue.get(scope,'p',item.id).status,'exhausted');assert.equal(calls,1);
 }finally{queue.close();rmSync(dir,{recursive:true,force:true});}
});

test('separate workers cannot claim the same intent concurrently',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'app-mixer-offline-workers-')),path=join(dir,'db.sqlite'),one=new SqliteOfflineQueue(path,policy),two=new SqliteOfflineQueue(path,policy),registry=new CapabilityRegistry(()=>{});let release,started,calls=0;
 const gate=new Promise(resolve=>release=resolve),signal=new Promise(resolve=>started=resolve);
 registry.register(candidate,{authorize:()=>true,validate:()=>true,execute:async()=>{calls++;started();await gate;}});
 try{
  const item=one.enqueue(scope,'p','update','req',{}),first=one.processOne(scope,actor,registry,()=> 'uncertain');await signal;
  assert.equal(await two.processOne(scope,actor,registry,()=> 'uncertain'),undefined);release();assert.equal((await first).status,'succeeded');assert.equal(two.get(scope,'p',item.id).status,'succeeded');assert.equal(calls,1);
 }finally{one.close();two.close();rmSync(dir,{recursive:true,force:true});}
});

test('denial and invalid failure classification fail closed',async()=>{
 const queue=new SqliteOfflineQueue(':memory:',policy),events=[],registry=new CapabilityRegistry(event=>events.push(event.outcome));let calls=0;
 registry.register(candidate,{authorize:()=>false,validate:()=>true,execute:()=>calls++});
 try{
  const item=queue.enqueue(scope,'p','update','req',{});
  assert.equal((await queue.processOne(scope,actor,registry,()=> 'unexpected',1)).status,'uncertain');
  assert.equal(queue.get(scope,'p',item.id).status,'uncertain');assert.equal(calls,0);assert.deepEqual(events,['attempt','denied']);
 }finally{queue.close();}
});


test('failed success persistence never invokes the retry classifier after an effect',async()=>{
 for(const failUncertain of [false,true]){const dir=mkdtempSync(join(tmpdir(),'offline-success-write-')),path=join(dir,'db.sqlite'),queue=new SqliteOfflineQueue(path,policy),db=new DatabaseSync(path),registry=new CapabilityRegistry(()=>{});let effects=0,classifications=0;
  try{registry.register(candidate,{authorize:()=>true,validate:()=>true,execute:()=>{effects++;}});const item=queue.enqueue(scope,'p','update','request',{});db.exec("CREATE TRIGGER fail_success BEFORE UPDATE OF status ON offline_operations WHEN NEW.status='succeeded' BEGIN SELECT RAISE(ABORT,'storage unavailable'); END");if(failUncertain)db.exec("CREATE TRIGGER fail_uncertain BEFORE UPDATE OF status ON offline_operations WHEN NEW.status='uncertain' BEGIN SELECT RAISE(ABORT,'storage unavailable'); END");await assert.rejects(queue.processOne(scope,actor,registry,()=>{classifications++;return 'retry';},1),/outcome uncertain/);assert.equal(queue.get(scope,'p',item.id).status,failUncertain?'running':'uncertain');assert.equal(await queue.processOne(scope,actor,registry,()=> 'retry',200),undefined);assert.equal(effects,1);assert.equal(classifications,0);
  }finally{db.close();queue.close();rmSync(dir,{recursive:true,force:true});}
 }
});

test('capability outcome audit failure remains uncertain even if classifier requests retry',async()=>{
 for(const executionFails of [false,true]){const queue=new SqliteOfflineQueue(':memory:',policy);let effects=0,classifications=0;const registry=new CapabilityRegistry(event=>{if(event.outcome==='succeeded'||event.outcome==='failed')throw Error('audit unavailable');});registry.register(candidate,{authorize:()=>true,validate:()=>true,execute:()=>{effects++;if(executionFails)throw Error('ambiguous provider failure');}});
  try{const item=queue.enqueue(scope,'p','update','request',{}),result=await queue.processOne(scope,actor,registry,()=>{classifications++;return 'retry';},1);assert.equal(result.status,'uncertain');assert.equal(queue.get(scope,'p',item.id).status,'uncertain');assert.equal(await queue.processOne(scope,actor,registry,()=> 'retry',200),undefined);assert.equal(effects,1);assert.equal(classifications,0);}finally{queue.close();}
 }
});

test('a queue keeps accepting work after 1,000 settled operations and retention removes only history',async()=>{
 const queue=new SqliteOfflineQueue(':memory:',{...policy,maxAttempts:3}),registry=new CapabilityRegistry(()=>{});registry.register(candidate,{authorize:()=>true,validate:()=>true,execute:()=>null});
 try{
  for(let n=0;n<1000;n++)queue.enqueue(scope,'p','update','settled-'+n,{n});
  assert.throws(()=>queue.enqueue(scope,'p','update','one-too-many',{}),/queue full/,'1,000 live operations fill the queue');
  for(let n=0;n<1000;n++)assert.equal((await queue.processOne(scope,actor,registry,()=>'retry',n+1)).status,'succeeded');
  const fresh=queue.enqueue(scope,'p','update','after-settling',{});assert.equal(fresh.status,'pending','settled operations no longer count toward the cap');
  const live=queue.enqueue(scope,'p','update','kept-live',{}),discarded=queue.enqueue(scope,'p','update','to-discard',{});queue.discard(scope,'p',discarded.id);
  for(const bad of [{statuses:[],limit:1},{statuses:['pending'],limit:1},{statuses:['succeeded','succeeded'],limit:1},{statuses:['succeeded'],limit:0},{statuses:['succeeded'],limit:1001},{statuses:'succeeded',limit:1},null])assert.throws(()=>queue.purge(scope,'p',bad),/Invalid offline retention query/);
  assert.equal(queue.purge(scope,'p',{statuses:['succeeded'],limit:600}),600,'the limit bounds one pass');
  assert.equal(queue.purge(scope,'p',{statuses:['succeeded','discarded'],limit:1000}),401,'the rest of the history');
  assert.equal(queue.purge(scope,'p',{statuses:['succeeded','discarded','exhausted'],limit:1000}),0);
  assert.deepEqual(queue.list(scope,'p').map(item=>item.id).sort(),[fresh.id,live.id].sort(),'live work is untouched');
  assert.equal(queue.purge(scope,'other',{statuses:['succeeded'],limit:10}),0,'another principal is untouched');
 }finally{queue.close();}
});

// TASK-002.3.1
test('a submission whose state moved on while it ran reports the real error, not a state error',async()=>{
 // recoverAbandoned (run by an operator who believed the submitter had died) moves the operation to uncertain while the capability is still running;
 // when the capability then fails, the failed state change in the error path must not replace the capability's own error.
 const staged=new SqliteStagedOperations(':memory:');
 try{
  const registry=new CapabilityRegistry(()=>{});let id;registry.register(candidate,{authorize:()=>true,validate:()=>true,execute:()=>{staged.recoverAbandoned(scope,id);throw Error('provider rejected the request');}});
  const item=staged.stage(scope,'update',{v:1});id=item.id;
  await assert.rejects(staged.submit(scope,item.id,registry,actor),/provider rejected the request/,'the capability error is what the caller sees');
  assert.equal(staged.get(scope,item.id).status,'uncertain','the operation stays uncertain for reconciliation');
 }finally{staged.close?.();}
});

test('a shared idempotency key already used by another request is a conflict, not a raw constraint error',()=>{
 const queue=new SqliteOfflineQueue(':memory:',policy);
 try{
  queue.enqueue(scope,'p','update','first',{value:1},{idempotencyKey:'shared-key'});
  for(const [other,principal,request] of [[scope,'p','second'],[{tenantId:'other',applicationId:'a'},'p','first'],[scope,'q','first']]){
   assert.throws(()=>queue.enqueue(other,principal,'update',request,{value:1},{idempotencyKey:'shared-key'}),error=>/Offline request conflict/.test(error.message)&&!/UNIQUE|constraint|offline_operations/i.test(error.message),JSON.stringify([other.tenantId,principal,request]));
  }
  assert.equal(queue.enqueue(scope,'p','update','first',{value:1},{idempotencyKey:'shared-key'}).requestKey,'first','the same request still deduplicates');
 }finally{queue.close?.();}
});
