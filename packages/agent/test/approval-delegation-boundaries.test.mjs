// Boundary tests for the human approval store and the delegation store. A mutation run (scripts/mutate.mjs) found that 45 of 116
// changes to the approval store and 33 of 107 to the delegation store went unnoticed: the exact moment a lease, an approval or a
// grant expires, the 24-hour and per-run limits, re-requesting an action with different content, the list limits and the
// validation of each argument. Every case below fails when its condition is removed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SqliteAgentRuns,SqliteAgentApprovals,SqliteAgentDelegations} from '../dist/index.js';

const scope={tenantId:'tenant',agentId:'agent'},service={tenantId:'tenant',principalId:'service'},human={tenantId:'tenant',principalId:'human'},DAY=86_400_000;

function approvals({deadline=1000,leaseMs=100,claimAt=10,authorize}={}){
 const dir=mkdtempSync(join(tmpdir(),'approval-bounds-')),path=join(dir,'runs.sqlite'),runs=new SqliteAgentRuns(path);
 let run=runs.create(scope,'run',{definitionVersion:1,maxAttempts:3,deadline},0);run=runs.claim(scope,'run',run.revision,'worker',leaseMs,claimAt);
 const state={now:claimAt};
 const store=new SqliteAgentApprovals(path,{scope,runId:'run',clock:()=>state.now,authorize:authorize??((actor,action)=>actor.principalId==='service'?action==='request':actor.principalId==='human')});
 return {state,store,runs,get run(){return run;},set run(value){run=value;},token:run.leaseToken,dir,path,close(){store.close();runs.close();rmSync(dir,{recursive:true,force:true});}};
}

test('approvals: options are validated one at a time',()=>{
 const s=approvals();
 try{
  const base={scope,runId:'run',authorize:()=>true};
  new SqliteAgentApprovals(s.path,{...base,clock:()=>1}).close();
  for(const [label,patch] of Object.entries({
   'no options':undefined,'no scope':{scope:undefined},'tenant invalid':{scope:{...scope,tenantId:''}},'agent invalid':{scope:{...scope,agentId:''}},'run invalid':{runId:''},'authorize missing':{authorize:undefined},'authorize not a function':{authorize:'yes'},'clock not a function':{clock:'now'}
  })){assert.throws(()=>new SqliteAgentApprovals(s.path,patch===undefined?undefined:{...base,...patch}),undefined,label);}
 }finally{s.close();}
});

test('approvals: the lease and the expiry are checked at their exact edge',async()=>{
 const s=approvals({deadline:1000,leaseMs:100,claimAt:10});     // the lease runs until 110
 try{
  assert.equal((await s.store.request(service,s.token,'a1','pay',{n:1},500)).status,'pending');
  s.state.now=109;assert.equal((await s.store.request(service,s.token,'a2','pay',{n:1},500)).status,'pending','the last moment of the lease');
  s.state.now=110;await assert.rejects(s.store.request(service,s.token,'a3','pay',{n:1},500),undefined,'the lease has ended');
  s.state.now=50;await assert.rejects(s.store.request(service,'not-the-token','a4','pay',{n:1},500),undefined,'another lease token');
  // An approval must expire in the future, by the run's deadline, and within a day.
  await assert.rejects(s.store.request(service,s.token,'a5','pay',{n:1},50),undefined,'expires now');await assert.rejects(s.store.request(service,s.token,'a6','pay',{n:1},49),undefined,'already expired');
  assert.equal((await s.store.request(service,s.token,'a7','pay',{n:1},51)).status,'pending','expires one millisecond from now');
  assert.equal((await s.store.request(service,s.token,'a8','pay',{n:1},1000)).status,'pending','expires at the run deadline');
  await assert.rejects(s.store.request(service,s.token,'a9','pay',{n:1},1001),undefined,'expires after the run deadline');
  for(const bad of [1.5,NaN,'500',undefined,null,Infinity])await assert.rejects(s.store.request(service,s.token,'a10','pay',{n:1},bad),undefined,String(bad));
 }finally{s.close();}
 const far=approvals({deadline:10*DAY,leaseMs:3_600_000});
 try{
  assert.equal((await far.store.request(service,far.token,'day','pay',{n:1},10+DAY)).status,'pending','a day from now');
  await assert.rejects(far.store.request(service,far.token,'day2','pay',{n:1},10+DAY+1),undefined,'more than a day from now');
 }finally{far.close();}
});

test('approvals: argument limits and re-requesting an action',async()=>{
 const s=approvals();
 try{
  const ask=(id,op,input,expires=500,authority)=>s.store.request(service,s.token,id,op,input,expires,authority);
  await ask('a','pay',{n:1},500,'x'.repeat(1024));
  for(const [label,fn] of Object.entries({
   'authority empty':()=>ask('b','pay',{n:1},500,''),'authority over 1024':()=>ask('b','pay',{n:1},500,'x'.repeat(1025)),'authority not text':()=>ask('b','pay',{n:1},500,7),
   'action id invalid':()=>ask('','pay',{n:1}),'operation id invalid':()=>ask('b','',{n:1}),'lease token invalid':()=>s.store.request(service,'','b','pay',{n:1},500)
  }))await assert.rejects(fn,undefined,label);
  // The same request again returns the same approval; different content for the same action is refused.
  const first=await ask('same','pay',{n:1}),again=await ask('same','pay',{n:1});assert.equal(again.status,first.status);
  await assert.rejects(ask('same','refund',{n:1}),undefined,'another operation');await assert.rejects(ask('same','pay',{n:2}),undefined,'other input');
  await assert.rejects(ask('same','pay',{n:1,extra:true}),undefined,'more input');
 }finally{s.close();}
});

test('approvals: at most a thousand per run',async()=>{
 const s=approvals({deadline:100_000,leaseMs:50_000});
 try{
  for(let i=0;i<1000;i++)await s.store.request(service,s.token,'bulk'+i,'pay',{i},90_000);
  await assert.rejects(s.store.request(service,s.token,'one-too-many','pay',{},90_000),undefined,'the 1001st');
 }finally{s.close();}
});

test('approvals: a decision is refused from the moment of expiry, and expire needs that moment',async()=>{
 const s=approvals();
 try{
  await s.store.request(service,s.token,'late','pay',{n:1},100);await s.store.request(service,s.token,'timely','pay',{n:1},100);
  s.state.now=99;assert.equal((await s.store.decide(human,'timely','approved')).status,'approved','one millisecond before expiry');
  await assert.rejects(s.store.expire(human,'late'),undefined,'not yet expired');
  s.state.now=100;await assert.rejects(s.store.decide(human,'late','approved'),undefined,'at the moment of expiry');
  assert.equal((await s.store.expire(human,'late')).status,'expired','expires exactly at its time');
  await assert.rejects(s.store.decide(human,'late','approved'),undefined,'after expiring');
  // An approved but unused approval expires too.
  assert.equal((await s.store.expire(human,'timely')).status,'expired');
  for(const bad of ['maybe','',undefined,'Approved'])await assert.rejects(s.store.decide(human,'late',bad),undefined,String(bad));
  await assert.rejects(s.store.decide(human,'','approved'),undefined,'empty action id');await assert.rejects(s.store.decide(human,'unknown','approved'),undefined,'unknown action');
 }finally{s.close();}
});

test('approvals: list limits and a finished run',async()=>{
 const s=approvals();
 try{
  for(let i=0;i<3;i++)await s.store.request(service,s.token,'item'+i,'pay',{i},500);
  const page=await s.store.list(human,{limit:1});assert.equal(page.items.length,1);assert.ok(page.nextAfter);
  const next=await s.store.list(human,{limit:1,after:page.nextAfter});assert.notEqual(next.items[0].actionId,page.items[0].actionId);
  assert.equal((await s.store.list(human,{limit:100})).items.length,3);assert.equal((await s.store.list(human)).items.length,3);
  for(const bad of [{limit:0},{limit:101},{limit:1.5},{limit:-1},{limit:'5'},{after:''},{after:7}])await assert.rejects(s.store.list(human,bad),undefined,JSON.stringify(bad));
  // Once the run has ended, no decision can be taken.
  s.run=s.runs.settle(scope,'run',s.run.revision,s.token,'failed',20);
  await assert.rejects(s.store.decide(human,'item0','approved'),undefined,'the run has ended');
 }finally{s.close();}
});

function delegations({deadline=1000}={}){
 const dir=mkdtempSync(join(tmpdir(),'delegation-bounds-')),path=join(dir,'runs.sqlite'),runs=new SqliteAgentRuns(path);runs.create(scope,'run',{definitionVersion:1,maxAttempts:3,deadline},0);
 const state={now:10},admin={tenantId:'tenant',principalId:'admin'};
 const store=new SqliteAgentDelegations(path,{scope,runId:'run',clock:()=>state.now,authorize:()=>true});
 return {state,store,runs,admin,close(){store.close();runs.close();rmSync(dir,{recursive:true,force:true});},path};
}
const grant=(extra={})=>({...scope,runId:'run',grantId:'grant',principalId:'user',permissionVersion:'v1',expiresAt:500,...extra});

test('delegations: options and grants are validated one at a time',async()=>{
 const s=delegations();
 try{
  const base={scope,runId:'run',authorize:()=>true};
  for(const [label,patch] of Object.entries({'no scope':{scope:undefined},'tenant invalid':{scope:{...scope,tenantId:''}},'agent invalid':{scope:{...scope,agentId:''}},'run invalid':{runId:''},'authorize missing':{authorize:undefined},'clock not a function':{clock:'now'}}))assert.throws(()=>new SqliteAgentDelegations(s.path,{...base,...patch}),undefined,label);
  assert.throws(()=>new SqliteAgentDelegations(s.path,undefined));
  await s.store.issue(s.admin,grant());
  const bad={'another tenant':{tenantId:'other'},'another agent':{agentId:'other'},'another run':{runId:'other'},'grant id invalid':{grantId:''},'principal invalid':{principalId:''},'permission version invalid':{permissionVersion:''},'expiry fractional':{expiresAt:1.5},'expiry missing':{expiresAt:undefined},'expiry negative':{expiresAt:-1},'revision given':{revision:1}};
  for(const [label,patch] of Object.entries(bad))await assert.rejects(s.store.issue(s.admin,grant({grantId:'g'+label.length+label[0],...patch})),undefined,label);
  await assert.rejects(s.store.issue(s.admin,grant()),undefined,'the same grant twice');
 }finally{s.close();}
});

test('delegations: expiry and run deadline are checked at their exact edge',async()=>{
 const s=delegations({deadline:1000});
 try{
  await assert.rejects(s.store.issue(s.admin,grant({grantId:'now',expiresAt:10})),undefined,'expires now');await s.store.issue(s.admin,grant({grantId:'next',expiresAt:11}));
  await s.store.issue(s.admin,grant({grantId:'deadline',expiresAt:1000}));await assert.rejects(s.store.issue(s.admin,grant({grantId:'past',expiresAt:1001})),undefined,'after the run deadline');
  const record=await s.store.get(s.admin,'next');
  s.state.now=10;assert.equal(await s.store.verify(s.admin,record.grant),true);
  s.state.now=11;assert.equal(await s.store.verify(s.admin,record.grant),false,'valid until its expiry, not at it');
  // The run deadline ends every grant: from that moment nothing verifies and nothing is issued.
  const open=await s.store.get(s.admin,'deadline');s.state.now=999;assert.equal(await s.store.verify(s.admin,open.grant),true);s.state.now=1000;assert.equal(await s.store.verify(s.admin,open.grant),false,'at the run deadline');
  await assert.rejects(s.store.issue(s.admin,grant({grantId:'late',expiresAt:1000})),undefined,'issuing at the run deadline');
 }finally{s.close();}
 const far=delegations({deadline:10*DAY});
 try{
  await far.store.issue(far.admin,grant({grantId:'day',expiresAt:10+DAY}));await assert.rejects(far.store.issue(far.admin,grant({grantId:'day2',expiresAt:10+DAY+1})),undefined,'more than a day from now');
 }finally{far.close();}
});

test('delegations: verification needs every part of the grant to match, and renew and revoke need the current revision',async()=>{
 const s=delegations();
 try{
  const issued=await s.store.issue(s.admin,grant());
  assert.equal(await s.store.verify(s.admin,issued.grant),true);
  for(const [label,patch] of Object.entries({'another principal':{principalId:'other'},'another permission version':{permissionVersion:'v2'},'another expiry':{expiresAt:400},'another revision':{revision:2}}))assert.equal(await s.store.verify(s.admin,{...issued.grant,...patch}),false,label);
  assert.equal(await s.store.verify(s.admin,{...issued.grant,grantId:'unknown'}),false,'an unknown grant');
  // Renewal and revocation are refused for bad arguments and for a stale revision, and the grant is unchanged by the refusals.
  for(const [label,args] of Object.entries({'revision 0':['grant',0,'v2',600],'revision fractional':['grant',1.5,'v2',600],'permission version empty':['grant',1,'',600],'expiry fractional':['grant',1,'v2',1.5],'grant id empty':['',1,'v2',600],'stale revision':['grant',2,'v2',600]}))await assert.rejects(s.store.renew(s.admin,...args),undefined,label);
  for(const [label,args] of Object.entries({'revision 0':['grant',0],'revision fractional':['grant',1.5],'grant id empty':['',1],'stale revision':['grant',2],'unknown grant':['nope',1]}))await assert.rejects(s.store.revoke(s.admin,...args),undefined,label);
  await assert.rejects(s.store.renew(s.admin,'nope',1,'v2',600),undefined,'renewing an unknown grant');
  assert.equal(await s.store.verify(s.admin,issued.grant),true,'unchanged by the refusals');
  const renewed=await s.store.renew(s.admin,'grant',1,'v2',600);assert.equal(renewed.revision,2);
  assert.equal(await s.store.verify(s.admin,issued.grant),false,'the old revision stops verifying');
  const revoked=await s.store.revoke(s.admin,'grant',2);assert.equal(await s.store.verify(s.admin,renewed.grant),false,'revoked');
  await assert.rejects(s.store.renew(s.admin,'grant',3,'v3',700),undefined,'renewing a revoked grant');
  await assert.rejects(s.store.revoke(s.admin,'grant',3),undefined,'revoking twice');
  assert.deepEqual((await s.store.history(s.admin,'grant')).map(entry=>entry.event),['issued','renewed','revoked']);
  await assert.rejects(s.store.history(s.admin,''),undefined);await assert.rejects(s.store.history(s.admin,'nope'),undefined);void revoked;
 }finally{s.close();}
});

test('delegations: at most a thousand per run',async()=>{
 const s=delegations({deadline:100_000});
 try{
  for(let i=0;i<1000;i++)await s.store.issue(s.admin,grant({grantId:'g'+i,expiresAt:90_000}));
  await assert.rejects(s.store.issue(s.admin,grant({grantId:'one-too-many',expiresAt:90_000})),undefined,'the 1001st');
 }finally{s.close();}
});

test('approvals: cancelling and deciding are separate permissions, and the status reflects time',async()=>{
 const s=approvals({authorize:(actor,action)=>actor.principalId==='service'?action==='request':actor.principalId==='approver'?['decide','read','list','history','expire'].includes(action):actor.principalId==='canceller'?['cancel','read','list','history'].includes(action):false});
 const approver={tenantId:'tenant',principalId:'approver'},canceller={tenantId:'tenant',principalId:'canceller'};
 try{
  for(const id of ['one','two','three','four'])await s.store.request(service,s.token,id,'pay',{id},500);
  await assert.rejects(s.store.decide(approver,'one','cancelled'),undefined,'an approver may not cancel');
  await assert.rejects(s.store.decide(canceller,'one','approved'),undefined,'a canceller may not approve');await assert.rejects(s.store.decide(canceller,'one','rejected'),undefined,'a canceller may not reject');
  assert.equal((await s.store.decide(canceller,'one','cancelled')).status,'cancelled');assert.equal((await s.store.decide(approver,'two','approved')).status,'approved');assert.equal((await s.store.decide(approver,'three','rejected')).status,'rejected');
  // A decided approval carries who and when; a pending one does not.
  const pending=await s.store.get(approver,'four'),decided=await s.store.get(approver,'two');
  assert.equal(pending.status,'pending');assert.equal(pending.decidedAt,null);assert.equal(decided.decidedBy,'approver');assert.equal(typeof decided.decidedAt,'number');
  // Past its expiry, a pending or approved approval reads as expired before anything sweeps it; a rejected one stays rejected.
  s.state.now=500;
  assert.equal((await s.store.get(approver,'four')).status,'expired');assert.equal((await s.store.get(approver,'two')).status,'expired');assert.equal((await s.store.get(approver,'three')).status,'rejected');assert.equal((await s.store.get(approver,'one')).status,'cancelled');
  s.state.now=499;assert.equal((await s.store.get(approver,'four')).status,'pending','still pending one millisecond earlier');
 }finally{s.close();}
});

test('approvals: a request needs a running run with the current lease, and one-character values are valid',async()=>{
 const s=approvals();
 try{
  assert.equal((await s.store.request(service,s.token,'short','p',{},500,'a')).status,'pending','an authority of one character');
  const record=await s.store.get(human,'short');assert.ok(record);
  // After the run has ended (or been paused), the old lease token no longer opens a request.
  s.run=s.runs.settle(scope,'run',s.run.revision,s.token,'succeeded',20);
  await assert.rejects(s.store.request(service,s.token,'after','p',{},500),undefined,'the run has ended');
 }finally{s.close();}
 const paused=approvals();
 try{
  const running=paused.runs.request(scope,'run',paused.run.revision,'pause');
  await assert.rejects(paused.store.request(service,paused.token,'while-pausing','p',{},500),undefined,'a pause has been requested');void running;
 }finally{paused.close();}
});

test('delegations: a finished run ends issuing, renewing and verifying; the revision in a grant must be a positive integer',async()=>{
 const s=delegations();
 try{
  const issued=await s.store.issue(s.admin,grant());
  for(const revision of [0,-1,1.5,'1'])await assert.rejects(s.store.verify(s.admin,{...issued.grant,revision}),undefined,'revision '+String(revision));
  assert.equal(await s.store.verify(s.admin,issued.grant),true);
  const run=s.runs.get(scope,'run');const done=s.runs.claim(scope,'run',run.revision,'worker',100,10);s.runs.settle(scope,'run',done.revision,done.leaseToken,'succeeded',20);
  assert.equal(await s.store.verify(s.admin,issued.grant),false,'the run has ended');
  await assert.rejects(s.store.issue(s.admin,grant({grantId:'later',expiresAt:200})),undefined,'issuing after the run ended');
  await assert.rejects(s.store.renew(s.admin,'grant',1,'v2',200),undefined,'renewing after the run ended');
  // Revocation is never blocked: a grant can still be revoked after its run has ended.
  assert.equal((await s.store.revoke(s.admin,'grant',1)).revoked,true,'revoking after the run ended');
 }finally{s.close();}
});
