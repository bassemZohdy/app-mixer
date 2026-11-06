import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CapabilityRegistry,SqliteCapabilityAudit} from '../dist/index.js';

test('capability audit persists attempts and outcomes with tenant-scoped pagination',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'capability-audit-')),path=join(dir,'audit.sqlite');let sink=new SqliteCapabilityAudit(path,{clock:()=>1234}),calls=0;
 try{
  const registry=new CapabilityRegistry(sink.record);registry.register({operationId:'read',method:'GET',path:'/read'},{authorize:c=>c.tenantId==='one',validate:()=>true,execute:()=>++calls});
  assert.equal(await registry.invoke('read',{secret:'not recorded'},{tenantId:'one',principalId:'user',origin:'ui'}),1);
  await assert.rejects(registry.invoke('read',{}, {tenantId:'two',principalId:'other',origin:'agent'}),/forbidden/);
  sink.close();sink=new SqliteCapabilityAudit(path);const first=sink.list('one',{limit:1}),rest=sink.list('one',{after:first[0].sequence});
  assert.deepEqual(first.map(x=>x.outcome),['attempt']);assert.deepEqual(rest.map(x=>x.outcome),['succeeded']);assert.equal(first[0].invocationId,rest[0].invocationId);assert.equal(first[0].recordedAt,1234);assert.deepEqual(sink.list('two').map(x=>x.outcome),['attempt','denied']);assert.equal(JSON.stringify(first).includes('secret'),false);assert.equal(sink.list('missing').length,0);
  assert.throws(()=>sink.list('one',{limit:1001}),/query/);assert.throws(()=>sink.record({operationId:'x',tenantId:'one',principalId:'u',outcome:'unknown'}),/event/);
 }finally{sink.close();rmSync(dir,{recursive:true,force:true});}
});

test('concurrent invocations retain distinct correlation IDs',async()=>{
 const sink=new SqliteCapabilityAudit(':memory:'),registry=new CapabilityRegistry(sink.record);let release;const gate=new Promise(resolve=>release=resolve);
 registry.register({operationId:'read',method:'GET',path:'/read'},{authorize:()=>true,validate:()=>true,execute:()=>gate});
 try{const context={tenantId:'t',principalId:'u',origin:'ui'},a=registry.invoke('read',{},context),b=registry.invoke('read',{},context);await new Promise(resolve=>setImmediate(resolve));const attempts=sink.list('t');assert.deepEqual(attempts.map(x=>x.outcome),['attempt','attempt']);assert.notEqual(attempts[0].invocationId,attempts[1].invocationId);release();await Promise.all([a,b]);const all=sink.list('t');for(const entry of attempts)assert.equal(all.filter(x=>x.invocationId===entry.invocationId&&x.outcome==='succeeded').length,1);}finally{release();sink.close();}
});

test('unavailable audit blocks capability execution',async()=>{
 const sink=new SqliteCapabilityAudit(':memory:'),registry=new CapabilityRegistry(sink.record);let calls=0;registry.register({operationId:'write',method:'POST',path:'/write'},{authorize:()=>true,validate:()=>true,execute:()=>++calls});sink.close();
 await assert.rejects(registry.invoke('write',{}, {tenantId:'t',principalId:'u',origin:'service'}));assert.equal(calls,0);
});

test('capability audit retention removes only old events of one tenant up to a reviewed sequence',()=>{
 const dir=mkdtempSync(join(tmpdir(),'capability-audit-prune-')),path=join(dir,'audit.sqlite');let now=100;const sink=new SqliteCapabilityAudit(path,{clock:()=>now});
 try{
  const event=(tenantId,n)=>({invocationId:'i'+n,operationId:'op',tenantId,principalId:'p',outcome:'succeeded'});
  for(let n=0;n<6;n++){now=100+n*10;sink.record(event(n%2?'other':'tenant',n));}
  now=1000;sink.record(event('tenant',6));
  const before=sink.list('tenant').map(item=>item.sequence);assert.equal(before.length,4);
  for(const bad of [{before:2000,through:7,limit:10},{before:100,through:0,limit:10},{before:100,through:7,limit:0},{before:100,through:7,limit:1001},{before:-1,through:7,limit:1},null])assert.throws(()=>sink.prune('tenant',bad),/Invalid capability audit retention query/);
  assert.throws(()=>sink.prune('',{before:100,through:7,limit:10}),/Invalid/);
  // Events recorded before 125 (sequences 1-3) of the tenant: sequences 1 and 3 belong to 'tenant'? Only even n are 'tenant'.
  assert.equal(sink.prune('tenant',{before:125,through:7,limit:1}),1,'the limit bounds one pass');
  assert.equal(sink.prune('tenant',{before:125,through:7,limit:10}),1,'the second old event of the tenant');
  assert.equal(sink.prune('tenant',{before:125,through:7,limit:10}),0,'nothing old is left');
  assert.deepEqual(sink.list('other').map(item=>item.invocationId),['i1','i3','i5'],'another tenant is untouched');
  assert.deepEqual(sink.list('tenant').map(item=>item.invocationId),['i4','i6'],'newer events remain');
  assert.equal(sink.prune('tenant',{before:1000,through:5,limit:10}),1,'through pins the newest sequence that may be removed: i4 (sequence 5) goes, i6 (sequence 7) stays');
  assert.deepEqual(sink.list('tenant').map(item=>item.invocationId),['i6']);
 }finally{sink.close();rmSync(dir,{recursive:true,force:true});}
});
