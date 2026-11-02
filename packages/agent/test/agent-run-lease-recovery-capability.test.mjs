import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CapabilityRegistry,createCapabilityServer} from '../../core/dist/index.js';
import {SqliteAgentRuns,SqliteAgentLeaseRecoveryHistory,registerAgentLeaseRecovery} from '../dist/index.js';
const scope={tenantId:'tenant',agentId:'agent'},other={...scope,tenantId:'other'},actor={tenantId:'tenant',principalId:'operator'},config={definitionVersion:1,maxAttempts:2,deadline:1000};
function setup(audit=()=>{}){const dir=mkdtempSync(join(tmpdir(),'lease-action-')),path=join(dir,'db.sqlite'),runs=new SqliteAgentRuns(path),registry=new CapabilityRegistry(audit);let original;for(const target of [scope,other]){const queued=runs.create(target,'run',config,0),claimed=runs.claim(target,'run',queued.revision,'worker',50,10);if(target===scope)original=claimed;}return {dir,path,runs,registry,original};}
function close(s){s.runs.close();rmSync(s.dir,{recursive:true,force:true});}
async function serve(registry,revision,authenticate=()=>actor){const server=createCapabilityServer(registry,authenticate,()=>{});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}/capabilities/lease-recover/invoke`,call=(input={reference:'case-1',revision},headers={})=>fetch(url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify({origin:'ui',input})});return {server,call};}
async function stop(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}

test('fixed lease recovery authenticates, authorizes and records the actual actor',async()=>{
 const s=setup(),events=[];let server,history;try{
  const options={runs:s.runs,scope:{...scope},runId:'run',operationId:'lease-recover',path:'/lease-recover',clock:()=>100,authorize:(who,action,lease)=>{events.push([who.principalId,action,lease]);if(lease){assert.equal(Object.hasOwn(lease,'leaseToken'),false);lease.runId='changed';}return who.principalId==='operator';}};registerAgentLeaseRecovery(s.registry,options);options.scope.tenantId='other';options.runId='other';options.authorize=()=>false;
  const app=await serve(s.registry,s.original.revision,req=>req.headers.authorization==='Bearer valid'?actor:req.headers.authorization==='Bearer other'?{...actor,tenantId:'other'}:undefined);server=app.server;assert.equal((await app.call()).status,401);assert.equal((await app.call(undefined,{authorization:'Bearer other'})).status,403);assert.equal((await app.call({reference:'bad id',revision:s.original.revision},{authorization:'Bearer valid'})).status,400);const response=await app.call({reference:'case-1',revision:s.original.revision},{authorization:'Bearer valid'});assert.equal(response.status,200);const result=await response.json();assert.equal(result.result.status,'uncertain');assert.doesNotMatch(JSON.stringify(result),/leaseToken|worker/);assert.equal(s.runs.get(scope,'run').status,'uncertain');assert.equal(s.runs.get(other,'run').status,'running');history=new SqliteAgentLeaseRecoveryHistory(s.path,{scope,authorize:()=>true});const entries=(await history.list({tenantId:'tenant',principalId:'auditor'})).items;assert.equal(entries.length,1);assert.equal(entries[0].principalId,'operator');assert.equal(entries[0].reference,'case-1');assert.equal((await app.call({reference:'case-1',revision:s.original.revision},{authorization:'Bearer valid'})).status,409);assert.ok(events.some(entry=>entry[1]==='recover'));
 }finally{if(server)await stop(server);history?.close();close(s);}
});

test('lease recovery rejects renewed leases and bounds late authorization',async()=>{
 for(const mode of ['renew','timeout']){
  const s=setup();let server,entered,release,seen,block=true;const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);try{
   registerAgentLeaseRecovery(s.registry,{runs:s.runs,scope,runId:'run',operationId:'lease-recover',path:'/lease-recover',clock:()=>100,timeoutMs:100,maxPending:1,authorize:async(_actor,action,_lease,signal)=>{if(action==='recover'&&block){if(mode==='renew'){block=false;s.runs.renew(scope,'run',s.original.revision,s.original.leaseToken,200,59);return true;}seen=signal;entered();await gate;}return true;}});const app=await serve(s.registry,s.original.revision);server=app.server;
   if(mode==='renew'){assert.equal((await app.call()).status,409);assert.equal(s.runs.get(scope,'run').status,'running');}else{const pending=app.call();await ready;assert.equal((await pending).status,503);assert.equal(seen.aborted,true);assert.equal((await app.call()).status,503);assert.equal(s.runs.get(scope,'run').status,'running');block=false;release();await new Promise(resolve=>setImmediate(resolve));assert.equal(s.runs.get(scope,'run').status,'running');assert.equal((await app.call()).status,200);assert.equal(s.runs.get(scope,'run').status,'uncertain');}
  }finally{release();if(server)await stop(server);close(s);}
 }
});

test('lost completion audit reports uncertainty after recovery without replaying it',async()=>{
 const s=setup(event=>{if(event.outcome==='succeeded')throw Error('audit down');});let server,history;try{registerAgentLeaseRecovery(s.registry,{runs:s.runs,scope,runId:'run',operationId:'lease-recover',path:'/lease-recover',clock:()=>100,authorize:()=>true});const app=await serve(s.registry,s.original.revision);server=app.server;const response=await app.call();assert.equal(response.status,503);assert.equal((await response.json()).code,'CAPABILITY_OUTCOME_UNCERTAIN');assert.equal(s.runs.get(scope,'run').status,'uncertain');history=new SqliteAgentLeaseRecoveryHistory(s.path,{scope,authorize:()=>true});assert.equal((await history.list({tenantId:'tenant',principalId:'auditor'})).items.length,1);assert.equal((await app.call()).status,409);assert.equal((await history.list({tenantId:'tenant',principalId:'auditor'})).items.length,1);}finally{if(server)await stop(server);history?.close();close(s);}
});

test('lease recovery rejects an old reviewed revision after the run is claimed again',async()=>{
 const s=setup();let server,history;try{
  const uncertain=s.runs.recoverExpired(scope,'run',s.original.revision,100),queued=s.runs.reconcile(scope,'run',uncertain.revision,'retry',100),reclaimed=s.runs.claim(scope,'run',queued.revision,'new-worker',50,110);registerAgentLeaseRecovery(s.registry,{runs:s.runs,scope,runId:'run',operationId:'lease-recover',path:'/lease-recover',clock:()=>200,authorize:()=>true});const app=await serve(s.registry,s.original.revision);server=app.server;
  assert.equal((await app.call({reference:'case'})).status,400);assert.equal((await app.call({reference:'case',revision:s.original.revision})).status,409);assert.equal(s.runs.get(scope,'run').status,'running');assert.equal(s.runs.get(scope,'run').revision,reclaimed.revision);history=new SqliteAgentLeaseRecoveryHistory(s.path,{scope,authorize:()=>true});assert.equal((await history.list({tenantId:'tenant',principalId:'auditor'})).items.length,0);
  const response=await app.call({reference:'case',revision:reclaimed.revision});assert.equal(response.status,200);assert.equal(s.runs.get(scope,'run').status,'uncertain');assert.equal((await history.list({tenantId:'tenant',principalId:'auditor'})).items.length,1);
 }finally{if(server)await stop(server);history?.close();close(s);}
});
