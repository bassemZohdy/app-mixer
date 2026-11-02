import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {SqliteAgentRuns,SqliteAgentActionJournal,SqliteAgentActionRecoveryDiscovery} from '../dist/index.js';
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
