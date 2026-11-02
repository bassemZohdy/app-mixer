import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {CapabilityRegistry} from '../../core/dist/index.js';
import {SqliteAgentRuns,SqliteAgentDelegations,registerAgentDelegationCapability} from '../dist/index.js';
const scope={tenantId:'tenant',agentId:'agent'},other={tenantId:'other',agentId:'agent'},actor={tenantId:'tenant',principalId:'operator'},foreign={tenantId:'other',principalId:'operator'},grant={...scope,runId:'run',grantId:'grant',principalId:'user',permissionVersion:'v1',expiresAt:100};
for(const mode of ['issue','renew','revoke'])for(const phase of ['event','after'])test(`delegation ${mode} recovers after capability process termination ${phase}`,{timeout:60000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'delegation-crash-')),path=join(dir,'runs.sqlite'),barrier=join(dir,'barrier');let runs=new SqliteAgentRuns(path),store,otherStore,child,db;
 const open=()=>new SqliteAgentDelegations(path,{scope,runId:'run',authorize:()=>true,clock:()=>10});
 try{
  runs.create(scope,'run',{definitionVersion:1,maxAttempts:2,deadline:1000},0);runs.create(other,'run',{definitionVersion:1,maxAttempts:2,deadline:1000},0);store=open();otherStore=new SqliteAgentDelegations(path,{scope:other,runId:'run',authorize:()=>true,clock:()=>10});if(mode!=='issue')await store.issue(actor,grant);await otherStore.issue(foreign,{...grant,...other});store.close();otherStore.close();runs.close();store=otherStore=runs=undefined;
  child=fork(fileURLToPath(new URL('./fixtures/crash-delegation-capability.mjs',import.meta.url)),[path,barrier,phase,mode],{stdio:['ignore','ignore','pipe','ipc']});let stderr='',problem,exited=false;child.stderr.on('data',chunk=>stderr+=String(chunk));child.on('message',message=>{if(message?.error)problem=message.error;});const exit=new Promise(resolve=>child.once('exit',()=>{exited=true;resolve();})),deadline=Date.now()+30000;while(!existsSync(barrier)){if(exited||problem)throw Error(`Delegation worker failed: ${problem??stderr}`);if(Date.now()>deadline)throw Error('Delegation barrier timed out');await new Promise(resolve=>setTimeout(resolve,20));}child.kill('SIGKILL');await exit;child=undefined;
  db=new DatabaseSync(path);db.exec('DROP TRIGGER IF EXISTS test_delegation_crash');db.close();db=undefined;store=open();otherStore=new SqliteAgentDelegations(path,{scope:other,runId:'run',authorize:()=>true,clock:()=>10});let current=await store.get(actor,'grant');const beforeEvents=mode==='issue'?[]:['issued'];assert.deepEqual((await otherStore.history(foreign,'grant')).map(item=>item.event),['issued']);assert.equal((await otherStore.get(foreign,'grant')).revision,1);
  if(phase==='event'){assert.equal(current?.revision,mode==='issue'?undefined:1);assert.deepEqual(current?(await store.history(actor,'grant')).map(item=>item.event):[],beforeEvents);const registry=new CapabilityRegistry(()=>{});registerAgentDelegationCapability(registry,{store,scope,runId:'run',grantId:'grant',mode,operationId:'manage',path:'/manage',authorize:()=>true,authorizeAction:()=>true});const query=mode==='issue'?{principalId:'user',permissionVersion:'v1',expiresAt:100}:mode==='renew'?{revision:1,permissionVersion:'v2',expiresAt:200}:{revision:1};await registry.invoke('manage',{query},{...actor,origin:'ui'});current=await store.get(actor,'grant');}
  assert.equal(current.revision,mode==='issue'?1:2);assert.equal(current.revoked,mode==='revoke');assert.equal(current.grant.permissionVersion,mode==='renew'?'v2':'v1');const events=(await store.history(actor,'grant')).map(item=>[item.event,item.actorId]);assert.deepEqual(events,mode==='issue'?[['issued','operator']]:[['issued','operator'],[mode==='renew'?'renewed':'revoked','operator']]);
  if(mode==='issue')await assert.rejects(store.issue(actor,grant),/already exists/);else if(mode==='renew')await assert.rejects(store.renew(actor,'grant',1,'v2',200),/revision conflict/);else await assert.rejects(store.revoke(actor,'grant',1),/revision conflict/);assert.equal((await otherStore.get(foreign,'grant')).revision,1);
 }finally{if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await new Promise(resolve=>child.once('exit',resolve));}db?.close();store?.close();otherStore?.close();runs?.close();rmSync(dir,{recursive:true,force:true});}
});
