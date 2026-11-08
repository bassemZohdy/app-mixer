// Boundary tests for the parts of the run registry that connect a run to approvals, delegations and unresolved work: pausing a
// run to wait for an approval or for a delegation renewal, resuming it, expiring it at its deadline with evidence, pruning
// start records and the guards that stop a run from being settled or retried while an outbound action or a token reservation
// is unresolved. A mutation run (scripts/mutate.mjs) found these paths almost untested. Every case below fails when its
// condition is removed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {SqliteAgentRuns,SqliteAgentApprovals,SqliteAgentDelegations,SqliteAgentActionJournal,SqliteAgentTokenBudget} from '../dist/index.js';

const scope={tenantId:'tenant',agentId:'agent'},service={tenantId:'tenant',principalId:'service'},human={tenantId:'tenant',principalId:'human'},admin={tenantId:'tenant',principalId:'admin'};
const grantFor=(extra={})=>({...scope,runId:'run',grantId:'grant',principalId:'user',permissionVersion:'v1',expiresAt:500,...extra});

/** A run claimed at time 10 (lease until 1010) with every store bound to it. */
function world({deadline=100_000,maxAttempts=3,claim=true}={}){
 const dir=mkdtempSync(join(tmpdir(),'run-waits-')),path=join(dir,'runs.sqlite'),runs=new SqliteAgentRuns(path),state={now:10};
 let run=runs.create(scope,'run',{definitionVersion:1,maxAttempts,deadline},0);if(claim)run=runs.claim(scope,'run',run.revision,'worker',1000,10);
 const token=run.leaseToken??'unclaimed-run-token',clock=()=>state.now;
 const approvals=new SqliteAgentApprovals(path,{scope,runId:'run',clock,authorize:()=>true}),delegations=new SqliteAgentDelegations(path,{scope,runId:'run',clock,authorize:()=>true}),journal=new SqliteAgentActionJournal(path,{scope,runId:'run',leaseToken:token,clock});
 return {runs,approvals,delegations,journal,state,path,token,get run(){return runs.get(scope,'run');},close(){journal.close();delegations.close();approvals.close();runs.close();rmSync(dir,{recursive:true,force:true});}};
}
const withWorld=async(options,body)=>{const w=world(options);try{await body(w);}finally{w.close();}};

test('pausing for an approval needs a running run, the lease and an approval that can still be granted',async()=>{
 await withWorld({},async w=>{
  await w.approvals.request(service,w.token,'act','pay',{n:1},500);
  const wait=(overrides={})=>{const a={token:w.token,actionId:'act',now:20,...overrides};return w.runs.pauseForApproval(scope,'run',w.run.revision,a.token,a.actionId,a.now);};
  for(const [label,overrides] of Object.entries({'token invalid':{token:''},'action id invalid':{actionId:''},'time negative':{now:-1},'time fractional':{now:1.5}}))assert.throws(()=>wait(overrides),/Invalid approval wait/,label);
  assert.throws(()=>wait({token:'another-token'}),/Invalid or expired lease/,'another lease token');assert.throws(()=>wait({now:1010}),/Invalid or expired lease/,'the lease has ended');
  assert.throws(()=>wait({actionId:'unknown'}),/Approval unavailable/,'no approval for that action');
  assert.equal(w.run.status,'running','refusals change nothing');
  const paused=wait();assert.deepEqual([paused.status,paused.approvalWait,paused.leaseToken,paused.leaseOwner,paused.leaseUntil],['paused',{actionId:'act'},null,null,null],'a pending approval is enough to wait for it');
 });
 await withWorld({},async w=>{                       // an approval that is already decided against, or expired
  await w.approvals.request(service,w.token,'no','pay',{n:1},500);await w.approvals.decide(human,'no','rejected');
  assert.throws(()=>w.runs.pauseForApproval(scope,'run',w.run.revision,w.token,'no',20),/Approval unavailable/,'rejected');
  await w.approvals.request(service,w.token,'yes','pay',{n:1},500);await w.approvals.decide(human,'yes','approved');
  assert.equal(w.runs.pauseForApproval(scope,'run',w.run.revision,w.token,'yes',20).status,'paused','an approved one can be waited for until it is used');
 });
 for(const [now,allowed] of [[59,true],[60,false]])await withWorld({},async w=>{
  await w.approvals.request(service,w.token,'edge','pay',{n:1},60);
  if(allowed)assert.equal(w.runs.pauseForApproval(scope,'run',w.run.revision,w.token,'edge',now).status,'paused','one millisecond before it expires');
  else assert.throws(()=>w.runs.pauseForApproval(scope,'run',w.run.revision,w.token,'edge',now),/Approval unavailable/,'at the moment it expires');
 });
 await withWorld({},async w=>{                       // only a running run waits; an unresolved action blocks it
  await w.approvals.request(service,w.token,'act','pay',{n:1},500);
  const asked=w.runs.request(scope,'run',w.run.revision,'pause',20);assert.equal(asked.status,'pause_requested');
  assert.throws(()=>w.runs.pauseForApproval(scope,'run',asked.revision,w.token,'act',21),/Invalid run state/,'a run that was asked to pause is not waiting yet');
 });
 await withWorld({},async w=>{
  await w.approvals.request(service,w.token,'act','pay',{n:1},500);
  await assert.rejects(w.journal.invoke('lost','op',{},1,async()=>{throw new Error('connection reset');}),/uncertain/);
  assert.throws(()=>w.runs.pauseForApproval(scope,'run',w.run.revision,w.token,'act',20),/Action requires reconciliation|Action require/,'an action whose outcome is unknown');
 });
});

test('a run waiting for an approval resumes only once the approval is granted and still valid',async()=>{
 // The run pauses while the approval is pending (a decided-against approval cannot be waited for); the decision comes afterwards.
 const pause=async(w,expiresAt,decide)=>{await w.approvals.request(service,w.token,'act','pay',{n:1},expiresAt);w.runs.pauseForApproval(scope,'run',w.run.revision,w.token,'act',20);if(decide)await w.approvals.decide(human,'act',decide);};
 await withWorld({},async w=>{await pause(w,500,null);assert.throws(()=>w.runs.request(scope,'run',w.run.revision,'resume',30),/Approval required/,'still pending');});
 await withWorld({},async w=>{await pause(w,500,'rejected');assert.throws(()=>w.runs.request(scope,'run',w.run.revision,'resume',30),/Approval required/,'rejected');});
 await withWorld({},async w=>{await pause(w,500,'approved');const resumed=w.runs.request(scope,'run',w.run.revision,'resume',30);assert.deepEqual([resumed.status,resumed.approvalWait],['queued',null],'approved: back in the queue, wait cleared');
  assert.equal(w.runs.get(scope,'run').approvalWait,null);});
 // The approval must still be unexpired when the run is resumed.
 for(const [now,resumes] of [[59,true],[60,false]])await withWorld({},async w=>{await pause(w,60,'approved');if(resumes)assert.equal(w.runs.request(scope,'run',w.run.revision,'resume',now).status,'queued','one millisecond before the approval expires');else assert.throws(()=>w.runs.request(scope,'run',w.run.revision,'resume',now),/Approval required/,'at the moment it expires');});
 // The run's own deadline still applies.
 await withWorld({deadline:100},async w=>{await pause(w,90,'approved');assert.throws(()=>w.runs.request(scope,'run',w.run.revision,'resume',100),/deadline expired/,'at the deadline');});
 // Cancelling a waiting run drops the wait.
 await withWorld({},async w=>{await pause(w,500,null);const cancelled=w.runs.request(scope,'run',w.run.revision,'cancel',30);assert.deepEqual([cancelled.status,cancelled.approvalWait],['cancelled',null]);});
});

test('pausing for a delegation renewal needs a running run and a grant that has really expired',async()=>{
 const issue=(w,extra)=>w.delegations.issue(admin,grantFor(extra));
 await withWorld({},async w=>{
  await issue(w,{expiresAt:100});
  const wait=(o={})=>{const a={token:w.token,grantId:'grant',revision:1,now:150,...o};return w.runs.pauseForDelegation(scope,'run',w.run.revision,a.token,a.grantId,a.revision,a.now);};
  for(const [label,overrides] of Object.entries({'token invalid':{token:''},'grant id invalid':{grantId:''},'revision 0':{revision:0},'revision fractional':{revision:1.5},'time negative':{now:-1},'time fractional':{now:1.5}}))assert.throws(()=>wait(overrides),/Invalid delegation wait/,label);
  assert.throws(()=>wait({token:'another-token'}),/Invalid or expired lease/,'another lease token');assert.throws(()=>wait({now:1010}),/Invalid or expired lease/,'the lease has ended');
  assert.throws(()=>wait({grantId:'unknown'}),/Delegation is not expired/,'no such grant');assert.throws(()=>wait({revision:2}),/Delegation is not expired/,'another revision');
  assert.throws(()=>wait({now:99}),/Delegation is not expired/,'still valid');
  assert.equal(w.run.status,'running');
  const paused=wait({now:100});assert.deepEqual([paused.status,paused.delegationWait,paused.leaseToken],['paused',{grantId:'grant',revision:1,principalId:'user'},null],'a grant is expired from its expiry time');
 });
 await withWorld({},async w=>{await issue(w,{expiresAt:100});await w.delegations.revoke(admin,'grant',1);assert.throws(()=>w.runs.pauseForDelegation(scope,'run',w.run.revision,w.token,'grant',1,150),/Delegation is not expired/,'a revoked grant is not waited for');});
 await withWorld({},async w=>{await issue(w,{expiresAt:100});const asked=w.runs.request(scope,'run',w.run.revision,'cancel',20);assert.throws(()=>w.runs.pauseForDelegation(scope,'run',asked.revision,w.token,'grant',1,150),/Invalid run state/,'only a running run waits');});
 await withWorld({},async w=>{
  await issue(w,{expiresAt:100});
  await assert.rejects(w.journal.invoke('lost','op',{},1,async()=>{throw new Error('connection reset');}),/uncertain/);
  assert.throws(()=>w.runs.pauseForDelegation(scope,'run',w.run.revision,w.token,'grant',1,150),/Action requires reconciliation|Action requir/,'an action whose outcome is unknown');
 });
});

test('a run waiting for a delegation renewal resumes only after a newer, valid grant of the same person',async()=>{
 const pause=async w=>{await w.delegations.issue(admin,grantFor({expiresAt:100}));w.state.now=150;return w.runs.pauseForDelegation(scope,'run',w.run.revision,w.token,'grant',1,150);};
 const resume=(w,now)=>w.runs.request(scope,'run',w.run.revision,'resume',now);
 await withWorld({},async w=>{await pause(w);assert.throws(()=>resume(w,160),/renewal required/,'nothing renewed yet');});
 await withWorld({},async w=>{await pause(w);await w.delegations.renew(admin,'grant',1,'v2',800);const resumed=resume(w,160);assert.deepEqual([resumed.status,resumed.delegationWait],['queued',null],'a renewed grant resumes the run');});
 await withWorld({},async w=>{await pause(w);const renewed=await w.delegations.renew(admin,'grant',1,'v2',800);await w.delegations.revoke(admin,'grant',renewed.revision);assert.throws(()=>resume(w,160),/renewal required/,'a revoked renewal');});
 // The renewed grant has to outlive the moment of resuming.
 for(const [now,resumes] of [[799,true],[800,false]])await withWorld({},async w=>{await pause(w);await w.delegations.renew(admin,'grant',1,'v2',800);if(resumes)assert.equal(resume(w,now).status,'queued');else assert.throws(()=>resume(w,now),/renewal required/,'at the moment the renewed grant expires');});
 await withWorld({deadline:700},async w=>{await pause(w);await w.delegations.renew(admin,'grant',1,'v2',650);assert.throws(()=>resume(w,700),/deadline expired/,'at the deadline');});
 await withWorld({},async w=>{await pause(w);const cancelled=w.runs.request(scope,'run',w.run.revision,'cancel',160);assert.deepEqual([cancelled.status,cancelled.delegationWait],['cancelled',null],'cancelling drops the wait');});
});

test('a run past its deadline can be failed with evidence, but never while work is unresolved',async()=>{
 await withWorld({deadline:100,claim:false},async w=>{
  const q=w.run,expire=(o={})=>w.runs.expireDeadline(scope,'run',q.revision,o.now??100,o.evidence);
  for(const [label,evidence] of Object.entries({'not an object':'proof','null':null,'a field short':{principalId:'human'},'an extra field':{principalId:'human',reference:'t-1',extra:1},'principal invalid':{principalId:'',reference:'t-1'},'reference invalid':{principalId:'human',reference:''},'principal missing':{reference:'t-1',other:1}}))assert.throws(()=>expire({evidence}),/Invalid expiry evidence/,label);
  for(const now of [-1,1.5])assert.throws(()=>expire({now}),/Invalid time/,String(now));
  assert.throws(()=>expire({now:99}),/not eligible/,'one millisecond before the deadline');
  const failed=expire({now:100,evidence:{principalId:'human',reference:'t-1'}});assert.equal(failed.status,'failed','from the moment of the deadline');
  const db=new DatabaseSync(w.path);try{const audit=db.prepare('SELECT run_id,previous_status,deadline,actor_id,reference,observed_at,revision FROM agent_run_expiry_audit').all();assert.deepEqual(audit.map(a=>({...a})),[{run_id:'run',previous_status:'queued',deadline:100,actor_id:'human',reference:'t-1',observed_at:100,revision:failed.revision}],'the evidence is recorded with the deadline and the previous status');}finally{db.close();}
 });
 await withWorld({deadline:100,claim:false},async w=>{const failed=w.runs.expireDeadline(scope,'run',w.run.revision,150);assert.equal(failed.status,'failed','evidence is optional');});
 await withWorld({deadline:100},async w=>{assert.throws(()=>w.runs.expireDeadline(scope,'run',w.run.revision,150),/not eligible/,'a running run is not expired this way');});
 await withWorld({deadline:100,claim:false},async w=>{
  const paused=w.runs.request(scope,'run',w.run.revision,'pause',0);assert.equal(w.runs.expireDeadline(scope,'run',paused.revision,100).status,'failed','a paused run is expired too');
 });
 await withWorld({deadline:100},async w=>{                 // waits are dropped when the run fails
  await w.approvals.request(service,w.token,'act','pay',{n:1},90);w.runs.pauseForApproval(scope,'run',w.run.revision,w.token,'act',20);
  const failed=w.runs.expireDeadline(scope,'run',w.run.revision,100);assert.deepEqual([failed.status,failed.approvalWait],['failed',null]);
 });
 await withWorld({deadline:100},async w=>{
  await assert.rejects(w.journal.invoke('lost','op',{},1,async()=>{throw new Error('connection reset');}),/uncertain/);
  const settled=w.runs.settle(scope,'run',w.run.revision,w.token,'succeeded',30);assert.equal(settled.status,'uncertain','settling with an unresolved action makes the run uncertain, whatever was reported');
  assert.throws(()=>w.runs.reconcile(scope,'run',settled.revision,'retry',40),/Action requires reconciliation/,'no retry while the action is unresolved');
  assert.throws(()=>w.runs.reconcile(scope,'run',settled.revision,'succeeded',40),/Action requires reconciliation/);
  w.journal.reconcile('lost','failed');assert.equal(w.runs.reconcile(scope,'run',settled.revision,'retry',40).status,'queued','after the action is resolved');
 });
 await withWorld({deadline:100,claim:false},async w=>{    // a reserved token call blocks expiry and reconciliation
  const claimed=w.runs.claim(scope,'run',w.run.revision,'worker',50,10);const budget=new SqliteAgentTokenBudget(w.path,{scope,runId:'run',leaseToken:claimed.leaseToken,maxTokens:100,clock:()=>20});
  try{budget.reserve('call-1',10);
   const settled=w.runs.settle(scope,'run',claimed.revision,claimed.leaseToken,'succeeded',30);assert.equal(settled.status,'uncertain','a token reservation that was never settled');
   assert.throws(()=>w.runs.reconcile(scope,'run',settled.revision,'retry',40),/Token usage requires reconciliation/);
  }finally{budget.close();}
 });
});

test('start records are pruned by age, and a run keeps its trace context',async()=>{
 await withWorld({deadline:10*86_400_000,claim:false},async w=>{
  const claimed=w.runs.claim(scope,'run',w.run.revision,'worker',100,1000);void claimed;           // records a start at 1000
  for(const [label,call] of Object.entries({'days 0':()=>w.runs.pruneStarts(0,5000),'days over ten years':()=>w.runs.pruneStarts(3661,5000),'days fractional':()=>w.runs.pruneStarts(1.5,5000),'time negative':()=>w.runs.pruneStarts(1,-1),'time fractional':()=>w.runs.pruneStarts(1,1.5)}))assert.throws(call,/Invalid retention/,label);
  w.runs.pruneStarts(1,1);w.runs.pruneStarts(3660,5000);
  assert.equal(w.runs.pruneStarts(1,1000+86_400_000),0,'a record exactly one retention period old is kept');
  assert.equal(w.runs.pruneStarts(1,1000+86_400_000+1),1,'one millisecond older is removed');
  assert.equal(w.runs.pruneStarts(1,1000+86_400_000+1),0,'nothing left to remove');
 });
 const dir=mkdtempSync(join(tmpdir(),'run-trace-')),path=join(dir,'runs.sqlite'),runs=new SqliteAgentRuns(path);
 try{
  const parent='00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
  runs.create(scope,'traced',{definitionVersion:1,maxAttempts:1,deadline:100,traceParent:parent},0);runs.create(scope,'plain',{definitionVersion:1,maxAttempts:1,deadline:100},0);
  assert.equal(runs.getTraceParent(scope,'traced'),parent);assert.equal(runs.getTraceParent(scope,'plain'),undefined);assert.equal(runs.getTraceParent(scope,'missing'),undefined);assert.throws(()=>runs.getTraceParent(scope,''),/Invalid run scope/);
  // The table is immutable by trigger; someone editing the file directly removes the triggers first.
  const db=new DatabaseSync(path);try{assert.throws(()=>db.prepare("UPDATE agent_run_trace_context SET trace_parent='damaged' WHERE run_id='traced'").run(),/immutable/);for(const trigger of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='agent_run_trace_context'").all())db.exec(`DROP TRIGGER "${trigger.name}"`);db.prepare("UPDATE agent_run_trace_context SET trace_parent='damaged' WHERE run_id='traced'").run();}finally{db.close();}
  assert.throws(()=>runs.getTraceParent(scope,'traced'),/Invalid agent trace context/,'a damaged stored trace context is an error, not a guess');
  assert.throws(()=>runs.create(scope,'bad',{definitionVersion:1,maxAttempts:1,deadline:100,traceParent:'nope'},0),/Invalid run configuration/);
  assert.equal(runs.get(scope,'bad'),undefined,'a refused run leaves no trace');
 }finally{runs.close();rmSync(dir,{recursive:true,force:true});}
});
