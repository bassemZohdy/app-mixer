import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SqliteAgentDefinitions} from '../dist/index.js';

const workerPath=fileURLToPath(new URL('./fixtures/crash-definition-worker.mjs',import.meta.url));
const manifest=name=>({manifestVersion:1,tenantId:'tenant',agentId:'agent',name,owner:{kind:'organization',id:'org'},administrators:['admin'],servicePrincipalId:'svc',model:{provider:'local',model:'test'},allowedCapabilities:[],lifecycle:{enabled:true,maxAttempts:2,runTimeoutMs:60000},quotas:{maxConcurrentRuns:1,maxTokensPerRun:100,maxRunsPerDay:10}});

for(const [mode,latest] of [['first',1],['second',2]])test(`process kill after definition version ${latest} keeps immutable versions and optimistic concurrency`,{timeout:30000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'agent-definition-crash-')),path=join(dir,'definitions.sqlite');let definitions,child;
 try{
  child=fork(workerPath,[path,mode],{stdio:['ignore','ignore','ignore','ipc']});
  const [message]=await Promise.race([once(child,'message'),once(child,'exit').then(([code,signal])=>{throw Error(`worker exited early (${code??signal})`);})]);assert.equal(message.type,mode);
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;child=undefined;

  definitions=new SqliteAgentDefinitions(path);
  assert.equal(definitions.get('tenant','agent').version,latest);
  assert.equal(definitions.get('tenant','agent',1).manifest.name,'First');
  if(latest===2)assert.equal(definitions.get('tenant','agent',2).manifest.name,'Second');
  assert.equal(definitions.get('tenant','agent',latest+1),undefined);
  // Isolation: another tenant sees nothing.
  assert.equal(definitions.get('other','agent'),undefined);assert.equal(definitions.list('other').length,0);
  // A stale writer (expecting the version before the latest) is rejected and changes nothing.
  assert.throws(()=>definitions.save('tenant',manifest('Stale'),latest-1));
  assert.equal(definitions.get('tenant','agent').version,latest);
  // The next version commits normally and earlier versions stay byte-for-byte what they were.
  const before=JSON.stringify(definitions.get('tenant','agent',1));
  assert.equal(definitions.save('tenant',manifest('Third'),latest).version,latest+1);
  assert.equal(JSON.stringify(definitions.get('tenant','agent',1)),before);
  assert.equal(definitions.list('tenant').length,1);
 }finally{if(child){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}definitions?.close();rmSync(dir,{recursive:true,force:true});}
});
