import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SqliteAgentRuns,SqliteAgentApprovals,SqliteAgentNotices} from '../dist/index.js';
const scope={tenantId:'tenant',agentId:'agent'},other={tenantId:'other',agentId:'agent'},reviewer={tenantId:'tenant',principalId:'reviewer'},foreign={tenantId:'other',principalId:'reviewer'};
async function killAtBarrier(path,barrier,kind,phase,id){
 const child=fork(fileURLToPath(new URL('./fixtures/crash-review-decision.mjs',import.meta.url)),[path,barrier,kind,phase,String(id)],{stdio:['ignore','ignore','pipe','ipc']});let errors='',problem,exited=false;child.stderr.on('data',data=>errors+=String(data));child.on('message',message=>{if(message?.error)problem=message.error;});const exit=new Promise(resolve=>child.once('exit',()=>{exited=true;resolve();}));
 try{const limit=Date.now()+15000;while(!existsSync(barrier)){if(exited||problem)throw Error(`Worker exited before checkpoint: ${problem??errors}`);if(Date.now()>limit)throw Error('Worker did not reach checkpoint');await new Promise(resolve=>setTimeout(resolve,20));}child.kill('SIGKILL');await exit;}finally{if(!exited){child.kill('SIGKILL');await exit;}}
}
for(const kind of ['decision','acknowledgement'])for(const phase of ['before','after'])test(`review ${kind} survives process termination ${phase} commit`,{timeout:30000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'review-crash-')),path=join(dir,'db'),barrier=join(dir,'barrier');let runs=new SqliteAgentRuns(path),approvals,notices,foreignApprovals,foreignNotices,db;
 const approvalOptions=(target)=>({scope:target,runId:'run',clock:()=>10,authorize:()=>true}),noticeOptions=target=>({scope:target,clock:()=>10,authorize:()=>true});
 try{
  for(const target of [scope,other]){let run=runs.create(target,'run',{definitionVersion:1,maxAttempts:2,deadline:1000},0);run=runs.claim(target,'run',run.revision,'worker',100,10);const store=new SqliteAgentApprovals(path,approvalOptions(target));await store.request({tenantId:target.tenantId,principalId:'service'},run.leaseToken,'action','pay',{},90);store.close();}
  notices=new SqliteAgentNotices(path,noticeOptions(scope));const id=(await notices.list(reviewer)).items[0].id;notices.close();notices=undefined;runs.close();runs=undefined;
  await killAtBarrier(path,barrier,kind,phase,id);db=new DatabaseSync(path);db.exec('DROP TRIGGER IF EXISTS test_review_crash');db.close();db=undefined;
  approvals=new SqliteAgentApprovals(path,approvalOptions(scope));notices=new SqliteAgentNotices(path,noticeOptions(scope));foreignApprovals=new SqliteAgentApprovals(path,approvalOptions(other));foreignNotices=new SqliteAgentNotices(path,noticeOptions(other));const committed=phase==='after';
  assert.equal((await approvals.get(reviewer,'action')).status,kind==='decision'&&committed?'approved':'pending');assert.deepEqual((await approvals.history(reviewer,'action')).map(event=>event.event),kind==='decision'&&committed?['requested','approved']:['requested']);assert.equal((await notices.list(reviewer)).items[0].acknowledgedAt,kind==='acknowledgement'&&committed?20:null);
  assert.equal((await foreignApprovals.get(foreign,'action')).status,'pending');assert.deepEqual((await foreignApprovals.history(foreign,'action')).map(event=>event.event),['requested']);assert.equal((await foreignNotices.list(foreign)).items[0].acknowledgedAt,null);
  if(kind==='decision'){if(committed)await assert.rejects(approvals.decide(reviewer,'action','approved'),/already decided/);else assert.equal((await approvals.decide(reviewer,'action','approved')).status,'approved');assert.deepEqual((await approvals.history(reviewer,'action')).map(event=>event.event),['requested','approved']);}else{assert.equal((await notices.acknowledge(reviewer,id)).acknowledgedAt,committed?20:10);}
 }finally{db?.close();foreignNotices?.close();foreignApprovals?.close();notices?.close();approvals?.close();runs?.close();rmSync(dir,{recursive:true,force:true});}
});

for(const phase of ['event','notice','after'])test(`approval request and notice survive process termination at ${phase}`,{timeout:30000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'approval-request-crash-')),path=join(dir,'db'),barrier=join(dir,'barrier');let runs=new SqliteAgentRuns(path),approvals,notices,foreignApprovals,foreignNotices,db;
 const approvalOptions=target=>({scope:target,runId:'run',clock:()=>10,authorize:()=>true}),noticeOptions=target=>({scope:target,clock:()=>10,authorize:()=>true});
 try{
  let lease;for(const target of [scope,other]){let run=runs.create(target,'run',{definitionVersion:1,maxAttempts:2,deadline:1000},0);run=runs.claim(target,'run',run.revision,'worker',100,10);if(target===scope)lease=run.leaseToken;else{const store=new SqliteAgentApprovals(path,approvalOptions(target));await store.request({tenantId:'other',principalId:'service'},run.leaseToken,'action','pay',{amount:99},90,'foreign');store.close();}}
  runs.close();runs=undefined;await killAtBarrier(path,barrier,'request',phase,lease);db=new DatabaseSync(path);db.exec('DROP TRIGGER IF EXISTS test_review_crash');const committed=phase==='after';for(const table of ['agent_approvals','agent_approval_authority','agent_approval_events','agent_notices'])assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id=? AND agent_id=?`).get('tenant','agent').n,committed?1:0,table);db.close();db=undefined;
  approvals=new SqliteAgentApprovals(path,approvalOptions(scope));notices=new SqliteAgentNotices(path,noticeOptions(scope));foreignApprovals=new SqliteAgentApprovals(path,approvalOptions(other));foreignNotices=new SqliteAgentNotices(path,noticeOptions(other));const service={tenantId:'tenant',principalId:'service'};
  assert.equal((await notices.list(reviewer)).items.length,committed?1:0);const request=await approvals.request(service,lease,'action','pay',{amount:12},90,'service,user');assert.equal(request.status,'pending');assert.equal(request.authority,'service,user');assert.deepEqual((await approvals.history(reviewer,'action')).map(event=>event.event),['requested']);assert.equal((await notices.list(reviewer)).items.length,1);await assert.rejects(approvals.request(service,lease,'action','pay',{amount:13},90,'service,user'),/identity conflict/);assert.equal((await foreignApprovals.get(foreign,'action')).authority,'foreign');assert.equal((await foreignNotices.list(foreign)).items.length,1);
 }finally{db?.close();foreignNotices?.close();foreignApprovals?.close();notices?.close();approvals?.close();runs?.close();rmSync(dir,{recursive:true,force:true});}
});
