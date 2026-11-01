import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {SqliteAgentMemory} from '../dist/index.js';
const actor={tenantId:'tenant',principalId:'admin'},scope={tenantId:'tenant',agentId:'agent',owner:{kind:'organization',id:'org'},kind:'episodic'},provenance={kind:'run',id:'run-1'};
const write=(expiresAt,expectedRevision=null)=>({expiresAt,expectedRevision,provenance});
const settings=(overrides={})=>({enabled:true,maxTtlMs:1000,maxEntries:5,authorize:()=>true,clock:()=>100,...overrides});

test('memory audit records authorized changes atomically without values and survives reopening',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'memory-audit-')),path=join(dir,'memory.sqlite');let now=100,db,store=new SqliteAgentMemory(path,settings({audit:true,clock:()=>now}));
 try{await store.put(actor,scope,'one',{secret:'sensitive'},write(200));await store.put(actor,scope,'two',{secret:'hidden'},write(300));await store.delete(actor,scope,'two',1);now=200;assert.equal(await store.purgeExpired(actor,scope),1);assert.equal(await store.purgeExpired(actor,scope),0);const history=await store.auditHistory(actor,scope,{limit:2});assert.deepEqual(history.items.map(x=>x.action),['write','write']);assert.ok(history.nextAfter);const rest=await store.auditHistory(actor,scope,{after:history.nextAfter});assert.deepEqual(rest.items.map(x=>x.action),['delete','purge']);assert.deepEqual(rest.items.map(x=>x.count),[1,1]);assert.equal(rest.items[0].revision,2);assert.equal(rest.items[1].memoryId,null);assert.equal(history.items[0].actorId,'admin');assert.equal(JSON.stringify([...history.items,...rest.items]).includes('sensitive'),false);assert.deepEqual((await store.auditHistory(actor,{...scope,agentId:'other'})).items,[]);
  await store.put(actor,scope,'live','keep',write(500));await store.put(actor,scope,'expiring','keep',write(250));now=250;db=new DatabaseSync(path);assert.throws(()=>db.exec('UPDATE agent_memory_audit SET actor_id=\'forged\''),/immutable/);assert.throws(()=>db.exec('DELETE FROM agent_memory_audit'),/immutable/);db.exec("CREATE TRIGGER fail_memory_audit BEFORE INSERT ON agent_memory_audit BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");await assert.rejects(store.put(actor,scope,'three',{x:1},write(500)),/audit unavailable/);assert.equal(await store.get(actor,scope,'three'),undefined);await assert.rejects(store.delete(actor,scope,'live',1),/audit unavailable/);assert.equal((await store.get(actor,scope,'live')).value,'keep');await assert.rejects(store.purgeExpired(actor,scope),/audit unavailable/);assert.equal(db.prepare("SELECT deleted FROM agent_memories WHERE memory_id='expiring'").get().deleted,0);db.exec('DROP TRIGGER fail_memory_audit');store.close();store=new SqliteAgentMemory(path,settings({audit:true,clock:()=>now}));assert.equal((await store.auditHistory(actor,scope)).items.length,6);
 }finally{db?.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('memory audit requires scope and per-record authorization and advances filtered pages',async()=>{
 const policy=(who,_scope,action,memoryId)=>who.principalId==='admin'||(who.principalId==='reviewer'&&action==='audit'&&memoryId!=='hidden');const store=new SqliteAgentMemory(':memory:',settings({audit:true,authorize:policy}));
 try{await store.put(actor,scope,'hidden','secret',write(500));await store.put(actor,scope,'visible','public',write(500));const reviewer={tenantId:'tenant',principalId:'reviewer'},first=await store.auditHistory(reviewer,scope,{limit:1});assert.deepEqual(first.items,[]);assert.ok(first.nextAfter);const second=await store.auditHistory(reviewer,scope,{after:first.nextAfter,limit:1});assert.equal(second.items[0].memoryId,'visible');await assert.rejects(store.auditHistory({tenantId:'tenant',principalId:'denied'},scope),/access denied/);await assert.rejects(store.auditHistory({...reviewer,tenantId:'other'},scope),/scope/);}
 finally{store.close();}
});

test('memory is scoped and authorization prevents a personal agent reading organization data',async()=>{
 const access=(who,s,action)=>who.principalId==='admin'||(who.principalId==='user'&&s.owner.kind==='user'&&s.owner.id==='user');const store=new SqliteAgentMemory(':memory:',settings({authorize:access}));
 try{await store.put(actor,scope,'item',{secret:'organization'},write(500));const user={tenantId:'tenant',principalId:'user'},personal={...scope,owner:{kind:'user',id:'user'}};await assert.rejects(store.get(user,scope,'item'),/access denied/);await store.put(user,personal,'item',{note:'personal'},write(500));assert.equal((await store.get(user,personal,'item')).value.note,'personal');assert.equal((await store.get(actor,scope,'item')).value.secret,'organization');assert.equal(await store.get(actor,{...scope,agentId:'other'},'item'),undefined);await assert.rejects(store.get({...user,tenantId:'other'},scope,'item'),/scope/);}
 finally{store.close();}
});

test('memory revisions, expiration and tombstones survive restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'app-mixer-memory-')),path=join(dir,'memory.sqlite');let now=100,store=new SqliteAgentMemory(path,settings({clock:()=>now}));
 try{const first=await store.put(actor,scope,'item',{a:1},write(200));assert.equal(first.revision,1);const read=await store.get(actor,scope,'item');read.value.a=9;assert.equal((await store.get(actor,scope,'item')).value.a,1);now=200;assert.equal(await store.get(actor,scope,'item'),undefined);assert.equal(await store.purgeExpired(actor,scope),1);const replacement=await store.put(actor,scope,'item',{a:2},write(500));assert.equal(replacement.revision,3);await assert.rejects(store.delete(actor,scope,'item',1),/revision conflict/);await store.delete(actor,scope,'item',3);store.close();store=new SqliteAgentMemory(path,settings({clock:()=>now}));assert.equal(await store.get(actor,scope,'item'),undefined);const recreated=await store.put(actor,scope,'item',{a:3},write(500));assert.equal(recreated.revision,5);}
 finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('listing and export require scope and per-record read permissions',async()=>{
 const policy=(who,_scope,action,memoryId)=>who.principalId==='admin'||(who.principalId==='reader'&&(action==='list'||(action==='read'&&memoryId!=='secret')));const store=new SqliteAgentMemory(':memory:',settings({authorize:policy}));
 try{for(const memoryId of ['a','b','secret'])await store.put(actor,scope,memoryId,{memoryId},write(500));const reader={tenantId:'tenant',principalId:'reader'};const first=await store.list(reader,scope,{limit:1});assert.deepEqual(first.items.map(x=>x.id),['a']);assert.equal(first.nextAfter,'a');const second=await store.list(reader,scope,{after:first.nextAfter,limit:1});assert.deepEqual(second.items.map(x=>x.id),['b']);assert.equal(second.nextAfter,undefined);await assert.rejects(store.get(reader,scope,'secret'),/access denied/);await assert.rejects(store.put(reader,scope,'x',{},write(500)),/access denied/);}
 finally{store.close();}
});

test('invalid values, quotas and authorization changes leave memory unchanged',async()=>{
 let allowed=true;const store=new SqliteAgentMemory(':memory:',settings({maxEntries:1,authorize:()=>allowed}));
 try{await store.put(actor,scope,'one',{a:1},write(500));await assert.rejects(store.put(actor,scope,'two',{},write(500)),/quota/);await assert.rejects(store.put(actor,scope,'one',{bad:undefined},write(500,1)),/Invalid memory value/);await assert.rejects(store.put(actor,scope,'one',{},write(2000,1)),/expiration/);allowed=false;await assert.rejects(store.get(actor,scope,'one'),/access denied/);allowed=true;assert.deepEqual((await store.get(actor,scope,'one')).value,{a:1});}
 finally{store.close();}
});

test('identity and scope are snapshotted before asynchronous authorization',async()=>{
 let release,started;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);const store=new SqliteAgentMemory(':memory:',settings({authorize:async(_actor,_scope,action)=>{if(action==='write'){started();await gate;}return true;}}));const mutableActor={...actor},mutableScope=structuredClone(scope);
 try{const pending=store.put(mutableActor,mutableScope,'item',{a:1},write(500));await ready;mutableActor.tenantId='other';mutableScope.owner.id='other';release();await pending;assert.equal((await store.get(actor,scope,'item')).value.a,1);assert.equal(await store.get(actor,{...scope,owner:{kind:'organization',id:'other'}},'item'),undefined);}
 finally{store.close();}
});


test('separate connections enforce revision and live-record quota atomically',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'app-mixer-memory-')),path=join(dir,'memory.sqlite'),a=new SqliteAgentMemory(path,settings({maxEntries:1})),b=new SqliteAgentMemory(path,settings({maxEntries:1}));
 try{await a.put(actor,scope,'one',{a:1},write(500));const revision=(await b.get(actor,scope,'one')).revision;await a.put(actor,scope,'one',{a:2},write(500,revision));await assert.rejects(b.put(actor,scope,'one',{a:3},write(500,revision)),/revision conflict/);await assert.rejects(b.put(actor,scope,'two',{},write(500)),/quota/);assert.equal((await b.get(actor,scope,'one')).value.a,2);}
 finally{a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});

test('erasing a scope needs its own permission, removes only that scope and is audited without values',async()=>{
 const actor={tenantId:'t',principalId:'admin'},scope={tenantId:'t',agentId:'a',owner:{kind:'user',id:'u1'},kind:'episodic'},other={...scope,owner:{kind:'user',id:'u2'}};
 let now=100;const policy=(who,_s,action)=>who.principalId==='admin'||(who.principalId==='cleaner'&&action==='purge');
 const store=new SqliteAgentMemory(':memory:',settings({audit:true,authorize:policy,clock:()=>now}));
 try{
  const write=expiresAt=>({expectedRevision:null,expiresAt,provenance:{kind:'human',id:'h'}});
  await store.put(actor,scope,'a',{secret:'x'},write(500));await store.put(actor,scope,'b','y',write(150));await store.put(actor,other,'a','keep',write(500));
  await assert.rejects(store.eraseScope({...actor,principalId:'cleaner'},scope),/access denied/);assert.equal((await store.get(actor,scope,'a')).value.secret,'x');
  now=200;assert.equal(await store.eraseScope(actor,scope),2);assert.equal(await store.eraseScope(actor,scope),0);
  assert.equal(await store.get(actor,scope,'a'),undefined);assert.deepEqual((await store.list(actor,scope)).items,[]);assert.equal((await store.get(actor,other,'a')).value,'keep');
  const history=(await store.auditHistory(actor,scope)).items;assert.deepEqual(history.map(x=>x.action),['write','write','erase']);assert.equal(history[2].count,2);assert.equal(history[2].memoryId,null);assert.equal(JSON.stringify(history).includes('secret'),false);
  assert.equal((await store.put(actor,scope,'a','new',write(500))).revision,3);
 }finally{store.close();}
});

test('erasure and expiry clear maximum-revision records and prevent revision reuse',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'memory-max-revision-')),path=join(dir,'memory.sqlite');let now=100;const store=new SqliteAgentMemory(path,settings({audit:true,clock:()=>now}));let db;
 try{
  await store.put(actor,scope,'erase','secret',write(500));await store.put(actor,scope,'expire','secret',write(150));
  db=new DatabaseSync(path);db.prepare('UPDATE agent_memories SET revision=?').run(Number.MAX_SAFE_INTEGER);
  now=200;assert.equal(await store.purgeExpired(actor,scope),1);assert.equal(await store.eraseScope(actor,scope),1);
  const rows=db.prepare('SELECT revision,value,provenance,deleted FROM agent_memories ORDER BY memory_id').all();
  for(const row of rows){assert.equal(row.revision,Number.MAX_SAFE_INTEGER);assert.equal(row.value,null);assert.equal(row.provenance,null);assert.equal(row.deleted,1);}
  assert.deepEqual((await store.auditHistory(actor,scope)).items.map(x=>x.action),['write','write','purge','erase']);
  await assert.rejects(store.put(actor,scope,'erase','replacement',write(500)),/Invalid memory revision/);
  await assert.rejects(store.put(actor,scope,'expire','replacement',write(500)),/Invalid memory revision/);
 }finally{db?.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
