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
  assert.deepEqual(first.map(x=>x.outcome),['attempt']);assert.deepEqual(rest.map(x=>x.outcome),['succeeded']);assert.equal(first[0].recordedAt,1234);assert.deepEqual(sink.list('two').map(x=>x.outcome),['attempt','denied']);assert.equal(JSON.stringify(first).includes('secret'),false);assert.equal(sink.list('missing').length,0);
  assert.throws(()=>sink.list('one',{limit:1001}),/query/);assert.throws(()=>sink.record({operationId:'x',tenantId:'one',principalId:'u',outcome:'unknown'}),/event/);
 }finally{sink.close();rmSync(dir,{recursive:true,force:true});}
});

test('unavailable audit blocks capability execution',async()=>{
 const sink=new SqliteCapabilityAudit(':memory:'),registry=new CapabilityRegistry(sink.record);let calls=0;registry.register({operationId:'write',method:'POST',path:'/write'},{authorize:()=>true,validate:()=>true,execute:()=>++calls});sink.close();
 await assert.rejects(registry.invoke('write',{}, {tenantId:'t',principalId:'u',origin:'service'}));assert.equal(calls,0);
});
