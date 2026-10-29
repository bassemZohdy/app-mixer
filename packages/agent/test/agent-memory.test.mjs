import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteAgentMemory} from '../dist/index.js';
const actor={tenantId:'tenant',principalId:'admin'},scope={tenantId:'tenant',agentId:'agent',owner:{kind:'organization',id:'org'},kind:'episodic'},provenance={kind:'run',id:'run-1'};
const write=(expiresAt,expectedRevision=null)=>({expiresAt,expectedRevision,provenance});
const settings=(overrides={})=>({enabled:true,maxTtlMs:1000,maxEntries:5,authorize:()=>true,clock:()=>100,...overrides});

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
