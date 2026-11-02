import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {CapabilityRegistry,createCapabilityServer} from '../../core/dist/index.js';
import {SqliteAgentRuns,SqliteAgentActionJournal,SqliteAgentActionRecoveryDiscovery,registerActionRecoveryDiscovery,AgentActionRecoveryCoordinator,AgentActionRecoveryWorker} from '../dist/index.js';
const scope={tenantId:'tenant',agentId:'agent'},actor={tenantId:'tenant',principalId:'operator'},config={definitionVersion:1,maxAttempts:2,deadline:1000};
async function uncertain(runs,path,selected,runId){let run=runs.create(selected,runId,config,0);run=runs.claim(selected,runId,run.revision,'worker',100,1);const journal=new SqliteAgentActionJournal(path,{scope:selected,runId,leaseToken:run.leaseToken,clock:()=>2});await assert.rejects(journal.invoke('action','operation',{private:'secret'},2,async()=>{throw Error('lost')}),/uncertain/);runs.settle(selected,runId,run.revision,run.leaseToken,'uncertain',3);journal.close();}
test('discovery pages unresolved runs by scope and follows recovery without exposing action details',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'action-discovery-')),path=join(dir,'db.sqlite'),runs=new SqliteAgentRuns(path);let discovery,db,journal;
 try{for(const name of ['a','b','c'])await uncertain(runs,path,scope,name);await uncertain(runs,path,{...scope,tenantId:'other'},'foreign');await uncertain(runs,path,{...scope,agentId:'other'},'foreign');db=new DatabaseSync(path);db.prepare("UPDATE agent_action_journal SET status='dispatching' WHERE tenant_id=? AND agent_id=? AND run_id=?").run('tenant','agent','b');
  discovery=new SqliteAgentActionRecoveryDiscovery(path,{scope,authorize:()=>true});const first=await discovery.list(actor,{limit:2});assert.deepEqual(first,{items:[{runId:'a',runStatus:'uncertain',dispatching:0,uncertain:1},{runId:'b',runStatus:'uncertain',dispatching:1,uncertain:0}],nextAfter:'b'});assert.deepEqual(await discovery.list(actor,{after:first.nextAfter,limit:2}),{items:[{runId:'c',runStatus:'uncertain',dispatching:0,uncertain:1}]});assert.equal(JSON.stringify(first).includes('secret'),false);
  journal=new SqliteAgentActionJournal(path,{scope,runId:'a',leaseToken:'old',clock:()=>4});journal.reconcile('action','applied',{ok:true});assert.deepEqual((await discovery.list(actor)).items.map(item=>item.runId),['b','c']);
 }finally{journal?.close();discovery?.close();db?.close();runs.close();rmSync(dir,{recursive:true,force:true});}
});
test('discovery rechecks scope authorization and rejects corrupt or invalid requests',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'action-discovery-')),path=join(dir,'db.sqlite'),runs=new SqliteAgentRuns(path);let discovery,db;
 try{await uncertain(runs,path,scope,'a');let checks=0;discovery=new SqliteAgentActionRecoveryDiscovery(path,{scope,authorize:()=>++checks===1});await assert.rejects(discovery.list(actor),/denied/);assert.equal(checks,2);await assert.rejects(discovery.list({...actor,tenantId:'other'}),/request/);await assert.rejects(discovery.list(actor,{limit:101}),/request/);discovery.close();
  discovery=new SqliteAgentActionRecoveryDiscovery(path,{scope,authorize:()=>true});db=new DatabaseSync(path);db.prepare('UPDATE agent_action_journal SET run_id=? WHERE tenant_id=? AND agent_id=?').run('missing','tenant','agent');await assert.rejects(discovery.list(actor),/discovery data/);
 }finally{db?.close();discovery?.close();runs.close();rmSync(dir,{recursive:true,force:true});}
});


test('capability exposes only host-authorized, fixed-scope recovery pages',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'action-discovery-cap-')),path=join(dir,'db.sqlite'),runs=new SqliteAgentRuns(path),events=[];let discovery,allowed=true,started,release;
 try{await uncertain(runs,path,scope,'a');await uncertain(runs,path,scope,'b');discovery=new SqliteAgentActionRecoveryDiscovery(path,{scope,authorize:()=>allowed});const registry=new CapabilityRegistry(event=>events.push(event.outcome)),options={discovery,scope:{...scope},operationId:'recovery_list',path:'/recovery',limit:1,authorize:who=>who.principalId==='operator'};registerActionRecoveryDiscovery(registry,options);options.scope.tenantId='other';options.limit=100;options.authorize=()=>false;const context={...actor,origin:'ui'};
  assert.deepEqual(await registry.invoke('recovery_list',{query:{}},context),{items:[{runId:'a',runStatus:'uncertain',dispatching:0,uncertain:1}],nextAfter:'a'});assert.equal((await registry.invoke('recovery_list',{query:{after:'a'}},context)).items[0].runId,'b');
  await assert.rejects(registry.invoke('recovery_list',{query:{tenantId:'other'}},context),/invalid/i);await assert.rejects(registry.invoke('recovery_list',{query:{limit:'100'}},context),/invalid/i);await assert.rejects(registry.invoke('recovery_list',{query:{}},{...context,tenantId:'other'}),/forbidden/i);await assert.rejects(registry.invoke('recovery_list',{query:{}},{...context,principalId:'denied'}),/forbidden/i);allowed=false;await assert.rejects(registry.invoke('recovery_list',{query:{}},context),/denied/i);assert.ok(events.includes('succeeded'));assert.ok(events.includes('denied'));
  assert.throws(()=>registerActionRecoveryDiscovery(registry,{...options,scope:{tenantId:'other',agentId:'agent'},operationId:'other',authorize:()=>true}),/Invalid action recovery discovery capability/);
 }finally{discovery?.close();runs.close();rmSync(dir,{recursive:true,force:true});}
});

test('capability fails closed if discovery permission is revoked while reading',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'action-discovery-cap-')),path=join(dir,'db.sqlite'),runs=new SqliteAgentRuns(path);let discovery,started,release,checks=0;const ready=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);
 try{await uncertain(runs,path,scope,'a');discovery=new SqliteAgentActionRecoveryDiscovery(path,{scope,authorize:async()=>{if(++checks===2){started();await gate;return false;}return true;}});const registry=new CapabilityRegistry(()=>{});registerActionRecoveryDiscovery(registry,{discovery,scope,operationId:'recovery',path:'/recovery',limit:10,authorize:()=>true});const pending=registry.invoke('recovery',{query:{}},{...actor,origin:'ui'});await ready;release();await assert.rejects(pending,/denied/);}finally{release?.();discovery?.close();runs.close();rmSync(dir,{recursive:true,force:true});}
});


test('recovery discovery capability enforces HTTP authentication and tenant policy',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'action-discovery-http-')),path=join(dir,'db.sqlite'),runs=new SqliteAgentRuns(path);let discovery,server;
 try{await uncertain(runs,path,scope,'a');discovery=new SqliteAgentActionRecoveryDiscovery(path,{scope,authorize:()=>true});const registry=new CapabilityRegistry(()=>{});registerActionRecoveryDiscovery(registry,{discovery,scope,operationId:'recovery',path:'/recovery',limit:5,authorize:()=>true});server=createCapabilityServer(registry,req=>req.headers.authorization==='Bearer valid'?actor:req.headers.authorization==='Bearer other'?{tenantId:'other',principalId:'operator'}:undefined,()=>{});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const call=(token,query)=>fetch(`http://127.0.0.1:${server.address().port}/capabilities/recovery/invoke`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({origin:'ui',input:{query}})});assert.equal((await call('bad',{})).status,401);assert.equal((await call('other',{})).status,403);assert.equal((await call('valid',{limit:'99'})).status,400);const result=await (await call('valid',{})).json();assert.deepEqual(result.result.items,[{runId:'a',runStatus:'uncertain',dispatching:0,uncertain:1}]);
 }finally{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}discovery?.close();runs.close();rmSync(dir,{recursive:true,force:true});}
});


test('coordinator fairly scans authorized uncertain runs and records per-action evidence',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'action-coordinator-')),path=join(dir,'db.sqlite'),runs=new SqliteAgentRuns(path);let discovery;const opened=[],closed=[],errors=[];
 try{for(const name of ['a','b','c'])await uncertain(runs,path,scope,name);await uncertain(runs,path,{...scope,tenantId:'other'},'foreign');discovery=new SqliteAgentActionRecoveryDiscovery(path,{scope,authorize:()=>true});let allowed=false;
  const coordinator=new AgentActionRecoveryCoordinator({scope,discovery,actor,maxRunsPerPass:1,pollMs:100,authorize:item=>item.runId!=='a'||allowed,open:item=>{opened.push(item.runId);const journal=new SqliteAgentActionJournal(path,{scope,runId:item.runId,leaseToken:'old',clock:()=>4});return {worker:new AgentActionRecoveryWorker({journal,maxPerPass:2,pollMs:100,authorize:()=>true,evidence:()=>({principalId:'operator',reference:'case'}),verify:async()=>({outcome:'applied',result:{ok:true}}),onError:error=>errors.push(error)}),close:()=>{closed.push(item.runId);journal.close();}};},onError:error=>errors.push(error)});
  assert.equal(await coordinator.runOnce(),0);assert.equal(await coordinator.runOnce(),1);assert.equal(await coordinator.runOnce(),1);allowed=true;assert.equal(await coordinator.runOnce(),1);assert.deepEqual(opened,['b','c','a']);assert.deepEqual(closed,opened);assert.deepEqual((await discovery.list(actor)).items,[]);assert.deepEqual(errors,[]);await coordinator.stop();
 }finally{discovery?.close();runs.close();rmSync(dir,{recursive:true,force:true});}
});

test('coordinator stop cancels verification, closes the session and retries the run',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'action-coordinator-stop-')),path=join(dir,'db.sqlite'),runs=new SqliteAgentRuns(path);let discovery,started,seen,blocking=true,closed=0;const ready=new Promise(resolve=>started=resolve);
 try{await uncertain(runs,path,scope,'a');discovery=new SqliteAgentActionRecoveryDiscovery(path,{scope,authorize:()=>true});const coordinator=new AgentActionRecoveryCoordinator({scope,discovery,actor,maxRunsPerPass:2,pollMs:100,authorize:()=>true,open:item=>{const journal=new SqliteAgentActionJournal(path,{scope,runId:item.runId,leaseToken:'old',clock:()=>4});return {worker:new AgentActionRecoveryWorker({journal,maxPerPass:2,pollMs:100,authorize:()=>true,evidence:()=>({principalId:'operator',reference:'case'}),verify:async(_request,signal)=>{if(blocking){seen=signal;started();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));}return {outcome:'applied',result:{ok:true}};},onError:()=>{}}),close:()=>{closed++;journal.close();}};},onError:()=>{}});const pending=coordinator.runOnce();await ready;await coordinator.stop();assert.equal(seen.aborted,true);assert.equal(await pending,0);assert.equal(closed,1);assert.equal((await discovery.list(actor)).items[0].uncertain,1);blocking=false;assert.equal(await coordinator.runOnce(),1);assert.equal(closed,2);await coordinator.stop();
 }finally{discovery?.close();runs.close();rmSync(dir,{recursive:true,force:true});}
});

test('coordinator rejects mismatched sessions and rechecks authorization before verification',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'action-coordinator-fence-')),path=join(dir,'db.sqlite'),runs=new SqliteAgentRuns(path);let discovery,closed=0,verify=0,allowed=true,checks=0;const errors=[];
 try{await uncertain(runs,path,scope,'a');await uncertain(runs,path,{...scope,tenantId:'other'},'foreign');discovery=new SqliteAgentActionRecoveryDiscovery(path,{scope,authorize:()=>true});let wrong=true;
  const coordinator=new AgentActionRecoveryCoordinator({scope,discovery,actor,maxRunsPerPass:2,pollMs:100,authorize:()=>{checks++;return allowed;},open:()=>{const selected=wrong?{tenantId:'other',agentId:'agent'}:scope,runId=wrong?'foreign':'a',journal=new SqliteAgentActionJournal(path,{scope:selected,runId,leaseToken:'old',clock:()=>4});return {worker:new AgentActionRecoveryWorker({journal,maxPerPass:2,pollMs:100,authorize:()=>true,evidence:()=>({principalId:'operator',reference:'case'}),verify:async()=>{verify++;return {outcome:'applied',result:{ok:true}};},onError:()=>{}}),close:()=>{closed++;journal.close();}};},onError:error=>errors.push(error.message)});
  assert.equal(await coordinator.runOnce(),0);assert.match(errors[0],/Invalid action recovery session/);assert.equal(closed,1);assert.equal(verify,0);wrong=false;allowed=true;checks=0;const revoked=new AgentActionRecoveryCoordinator({scope,discovery,actor,maxRunsPerPass:2,pollMs:100,authorize:()=>++checks===1,open:()=>{const journal=new SqliteAgentActionJournal(path,{scope,runId:'a',leaseToken:'old',clock:()=>4});return {worker:new AgentActionRecoveryWorker({journal,maxPerPass:2,pollMs:100,authorize:()=>true,evidence:()=>({principalId:'operator',reference:'case'}),verify:async()=>{verify++;return {outcome:'applied',result:{ok:true}};},onError:()=>{}}),close:()=>{closed++;journal.close();}};},onError:()=>{}});assert.equal(await revoked.runOnce(),0);assert.equal(checks,2);assert.equal(closed,2);assert.equal(verify,0);assert.equal((await discovery.list(actor)).items[0].uncertain,1);await coordinator.stop();await revoked.stop();
 }finally{discovery?.close();runs.close();rmSync(dir,{recursive:true,force:true});}
});
