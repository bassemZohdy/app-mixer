import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteAgentDefinitions,validateAgentManifest} from '../dist/index.js';
const manifest=(tenantId='tenant',agentId='agent')=>({manifestVersion:1,tenantId,agentId,name:'Operations',owner:{kind:'organization',id:'org'},administrators:['admin'],servicePrincipalId:'svc',model:{provider:'openai-compatible',model:'model-a',credentialRef:'secret-ref'},allowedCapabilities:['inventory.read'],lifecycle:{enabled:true,maxAttempts:3,runTimeoutMs:60000},quotas:{maxConcurrentRuns:2,maxTokensPerRun:10000,maxRunsPerDay:100}});

test('manifest supports independent and user-associated agents while rejecting unsafe configuration',()=>{
 const org=validateAgentManifest(manifest());assert.equal(org.owner.kind,'organization');assert.equal(org.userAssociation,undefined);
 const personal=validateAgentManifest({...manifest(),owner:{kind:'user',id:'user'},userAssociation:'user'});assert.equal(personal.userAssociation,'user');assert.equal(personal.servicePrincipalId,'svc');
 for(const bad of [{...manifest(),manifestVersion:2},{...manifest(),userAssociation:''},{...manifest(),administrators:[]},{...manifest(),administrators:['admin','admin']},{...manifest(),allowedCapabilities:['x','x']},{...manifest(),model:{...manifest().model,apiKey:'secret'}},{...manifest(),unknown:true},{...manifest(),quotas:{...manifest().quotas,maxConcurrentRuns:0}},{...manifest(),lifecycle:{...manifest().lifecycle,runTimeoutMs:Infinity}},{...manifest(),servicePrincipalId:''}])assert.throws(()=>validateAgentManifest(bad),/Invalid agent manifest/);
});

test('agent definitions are versioned, tenant-isolated, immutable and durable',()=>{
 const dir=mkdtempSync(join(tmpdir(),'app-mixer-agents-')),path=join(dir,'agents.sqlite');let first,second,db;
 try{
  first=new SqliteAgentDefinitions(path);second=new SqliteAgentDefinitions(path);const input=manifest();const saved=first.save('tenant',input,0);input.model.model='mutated';saved.manifest.name='changed';assert.equal(first.get('tenant','agent').manifest.name,'Operations');assert.equal(first.get('tenant','agent').manifest.model.model,'model-a');
  assert.throws(()=>second.save('tenant',manifest(),0),/version conflict/);assert.throws(()=>first.save('other',manifest(),0),/scope mismatch/);assert.equal(first.get('other','agent'),undefined);
  const update={...manifest(),name:'Updated',userAssociation:'user'};second.save('tenant',update,1);assert.equal(first.get('tenant','agent').version,2);assert.equal(first.get('tenant','agent',1).manifest.name,'Operations');assert.equal(first.get('tenant','agent',2).manifest.userAssociation,'user');assert.equal(first.get('tenant','agent',3),undefined);
  first.save('other',manifest('other','agent'),0);first.save('tenant',manifest('tenant','another'),0);assert.deepEqual(first.list('tenant',{limit:1}).map(x=>x.manifest.agentId),['agent']);assert.deepEqual(first.list('tenant',{after:'agent'}).map(x=>x.manifest.agentId),['another']);assert.equal(first.list('other').length,1);
  db=new DatabaseSync(path);assert.throws(()=>db.exec('UPDATE agent_definitions SET version=9'),/immutable/);assert.throws(()=>db.exec('DELETE FROM agent_definitions'),/immutable/);assert.throws(()=>db.exec('INSERT OR REPLACE INTO agent_definitions SELECT * FROM agent_definitions'),/immutable/);db.close();db=undefined;
  first.close();first=undefined;second.close();second=undefined;first=new SqliteAgentDefinitions(path);assert.equal(first.get('tenant','agent').version,2);
 }finally{db?.close();first?.close();second?.close();rmSync(dir,{recursive:true,force:true});}
});
