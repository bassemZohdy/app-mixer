// Boundary tests for the durable run registry (SqliteAgentRuns), the state machine behind pause, resume, cancel, leases and
// recovery. A mutation run (scripts/mutate.mjs) found that 179 of 299 small changes went unnoticed (40% caught): the validation
// of each argument, the exact moment a lease or a deadline ends, the per-agent limits, and which transitions are legal from
// which states. Every case below fails when its condition is removed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SqliteAgentRuns} from '../dist/index.js';

const scope={tenantId:'tenant',agentId:'agent'},DAY=86_400_000;
function open(){const dir=mkdtempSync(join(tmpdir(),'runs-bounds-')),runs=new SqliteAgentRuns(join(dir,'runs.sqlite'));return {runs,close(){runs.close();rmSync(dir,{recursive:true,force:true});}};}
const make=(runs,id,{deadline=1000,maxAttempts=3,now=0,agent='agent'}={})=>runs.create({...scope,agentId:agent},id,{definitionVersion:1,maxAttempts,deadline},now);

test('queries validate their arguments and page in a stable order',()=>{
 const {runs,close}=open();
 try{
  for(const id of ['c','a','b'])make(runs,id);
  for(const [label,call] of Object.entries({
   'get: no scope':()=>runs.get(undefined,'a'),'get: tenant invalid':()=>runs.get({...scope,tenantId:''},'a'),'get: agent invalid':()=>runs.get({...scope,agentId:''},'a'),'get: run id invalid':()=>runs.get(scope,'')
  }))assert.throws(call,/Invalid run scope/,label);
  assert.equal(runs.get(scope,'missing'),undefined);assert.equal(runs.get(scope,'a').status,'queued');assert.equal(runs.get({...scope,agentId:'other'},'a'),undefined,'runs belong to one agent');
  // list: sorted by run id, with a cursor and a limit of 1 to 100; archived runs only on request.
  assert.deepEqual(runs.list(scope).map(r=>r.runId),['a','b','c']);assert.deepEqual(runs.list(scope,{limit:2}).map(r=>r.runId),['a','b']);assert.deepEqual(runs.list(scope,{after:'a',limit:1}).map(r=>r.runId),['b']);assert.equal(runs.list(scope,{limit:100}).length,3);
  for(const [label,options] of Object.entries({'limit 0':{limit:0},'limit 101':{limit:101},'limit fractional':{limit:1.5},'limit text':{limit:'5'},'limit negative':{limit:-1},'after invalid':{after:''},'includeArchived text':{includeArchived:'yes'},'null':null}))assert.throws(()=>runs.list(scope,options),/Invalid run listing/,label);
  assert.throws(()=>runs.list(undefined),/Invalid run scope/);
  // queuedPage: oldest first, a cursor that is a run id, an unknown cursor starts from the beginning.
  assert.deepEqual(runs.queuedPage(scope).runIds,['c','a','b'],'creation order');const first=runs.queuedPage(scope,{limit:2});assert.deepEqual(first.runIds,['c','a']);assert.equal(first.next,'a');
  assert.deepEqual(runs.queuedPage(scope,{after:first.next}).runIds,['b']);assert.equal(runs.queuedPage(scope,{after:first.next}).next,undefined);assert.deepEqual(runs.queuedPage(scope,{after:'unknown'}).runIds,['c','a','b']);assert.equal(runs.queuedPage(scope,{limit:3}).next,undefined);
  for(const [label,options] of Object.entries({'limit 0':{limit:0},'limit 101':{limit:101},'limit fractional':{limit:1.5},'after invalid':{after:''},'null':null}))assert.throws(()=>runs.queuedPage(scope,options),/Invalid queued run query/,label);
  assert.equal(runs.queuedPage(scope,{limit:100}).runIds.length,3);
 }finally{close();}
});

test('expired runs are found from the moment of their deadline, only when queued or paused',()=>{
 const {runs,close}=open();
 try{
  make(runs,'q',{deadline:100});make(runs,'p',{deadline:100});make(runs,'r',{deadline:100});make(runs,'late',{deadline:200});
  const p=runs.get(scope,'p');runs.request(scope,'p',p.revision,'pause',0);
  const r=runs.get(scope,'r');runs.claim(scope,'r',r.revision,'worker',50,10,5);
  assert.deepEqual(runs.expiredPage(scope,99).items,[],'one millisecond before');
  assert.deepEqual(runs.expiredPage(scope,100).items.map(x=>x.runId),['p','q'],'queued and paused, not running; ordered by deadline then id');
  assert.deepEqual(runs.expiredPage(scope,200).items.map(x=>x.runId),['p','q','late']);
  const page=runs.expiredPage(scope,200,{limit:2});assert.equal(page.items.length,2);assert.deepEqual(page.next,{deadline:100,runId:'q'});
  assert.deepEqual(runs.expiredPage(scope,200,{after:page.next}).items.map(x=>x.runId),['late'],'continues after the cursor');
  assert.deepEqual(runs.expiredPage(scope,200,{after:{deadline:100,runId:'p'},limit:1}).items.map(x=>x.runId),['q']);
  for(const [label,call] of Object.entries({'now negative':()=>runs.expiredPage(scope,-1),'now fractional':()=>runs.expiredPage(scope,1.5),'null options':()=>runs.expiredPage(scope,100,null),'limit 0':()=>runs.expiredPage(scope,100,{limit:0}),'limit 101':()=>runs.expiredPage(scope,100,{limit:101}),'cursor missing deadline':()=>runs.expiredPage(scope,100,{after:{runId:'p'}}),'cursor run invalid':()=>runs.expiredPage(scope,100,{after:{deadline:1,runId:''}}),'cursor null':()=>runs.expiredPage(scope,100,{after:null})}))assert.throws(call,/Invalid expired run query/,label);
  runs.expiredPage(scope,100,{limit:100});
 }finally{close();}
});

test('creating a run validates its configuration',()=>{
 const {runs,close}=open();
 try{
  const good={definitionVersion:1,maxAttempts:1,deadline:1};
  assert.equal(runs.create(scope,'one',good,0).revision,1);runs.create(scope,'hundred',{...good,maxAttempts:100},0);runs.create(scope,'v',{...good,definitionVersion:7},0);
  assert.deepEqual([runs.get(scope,'one').status,runs.get(scope,'one').attempts,runs.get(scope,'one').maxAttempts,runs.get(scope,'one').deadline,runs.get(scope,'v').definitionVersion],['queued',0,1,1,7]);
  for(const [label,config] of Object.entries({
   'no config':undefined,'a class instance':new (class Config{constructor(){Object.assign(this,good);}})(),'definition 0':{...good,definitionVersion:0},'definition fractional':{...good,definitionVersion:1.5},'attempts 0':{...good,maxAttempts:0},'attempts 101':{...good,maxAttempts:101},
   'deadline now':{...good,deadline:0},'deadline text':{...good,deadline:'5'},'deadline missing':{definitionVersion:1,maxAttempts:1},'trace parent invalid':{...good,traceParent:'nope'}
  }))assert.throws(()=>runs.create(scope,'bad',config,0),/Invalid run configuration/,label);
  assert.throws(()=>runs.create(scope,'bad',good,-1),/Invalid run configuration/,'a negative time');assert.throws(()=>runs.create(scope,'bad',{...good,deadline:5},5),/Invalid run configuration/,'a deadline at the creation time');
  assert.equal(runs.create(scope,'bare',Object.assign(Object.create(null),good),0).status,'queued','a configuration without a prototype');
  assert.equal(runs.create(scope,'traced',{...good,traceParent:'00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'},0).runId,'traced');
  assert.throws(()=>runs.create(scope,'one',good,0),/Run already exists/);assert.throws(()=>runs.create(scope,'',good,0),/Invalid run scope/);
 }finally{close();}
});

test('every transition checks the revision it was given',()=>{
 const {runs,close}=open();
 try{
  const run=make(runs,'r');
  for(const revision of [0,-1,1.5,Number.MAX_SAFE_INTEGER,'1',undefined])assert.throws(()=>runs.claim(scope,'r',revision,'worker',10,0),/Invalid run revision/,String(revision));
  assert.throws(()=>runs.claim(scope,'missing',1,'worker',10,0),/Run not found/);
  assert.throws(()=>runs.claim(scope,'r',run.revision+1,'worker',10,0),/revision conflict/,'a revision that is not current');
  const claimed=runs.claim(scope,'r',run.revision,'worker',10,0);assert.equal(claimed.revision,run.revision+1,'a transition bumps the revision');
  assert.throws(()=>runs.claim(scope,'r',run.revision,'worker',10,0),/revision conflict/,'the old revision is stale');
 }finally{close();}
});

test('claiming checks its arguments, the deadline, the attempts and the per-agent limits',()=>{
 const {runs,close}=open();
 try{
  const fresh=(id,options)=>{const run=make(runs,id,options);return run.revision;};
  let sequence=0;const claimable=()=>{const id='arg'+(sequence++);return [id,fresh(id,{deadline:DAY})];};
  for(const [label,args] of Object.entries({'worker invalid':['',10,0],'lease 0':['w',0,0],'lease over an hour':['w',3600001,0],'lease fractional':['w',1.5,0],'now negative':['w',10,-1],'now fractional':['w',10,1.5],'now too large for the lease':['w',10,Number.MAX_SAFE_INTEGER]})){const [id,revision]=claimable();assert.throws(()=>runs.claim(scope,id,revision,...args),/Invalid lease/,label);}
  for(const [label,limits] of Object.entries({'concurrency 0':[0],'concurrency 101':[101],'concurrency fractional':[1.5],'daily 0':[1,0],'daily over a million':[1,1000001],'daily fractional':[1,1.5]})){const [id,revision]=claimable();assert.throws(()=>runs.claim(scope,id,revision,'w',10,0,...limits),/Invalid lease/,label);}
  {const [id,revision]=claimable();assert.equal(runs.claim(scope,id,revision,'w',10,0,100,1000000).status,'running','the largest limits are allowed');}
  // Lease edges: 1 ms and an hour are allowed; the lease never outlives the run's deadline.
  assert.equal(runs.claim(scope,'lease1',fresh('lease1',{deadline:DAY}),'w',1,10,100).leaseUntil,11);
  assert.equal(runs.claim(scope,'lease-hour',fresh('lease-hour',{deadline:2*DAY}),'w',3600000,10,100).leaseUntil,3600010);
  assert.equal(runs.claim(scope,'capped',fresh('capped',{deadline:100}),'w',500,10,100).leaseUntil,100,'capped by the deadline');
  // Deadline: claimable up to the millisecond before it.
  const edge=fresh('edge',{deadline:100});assert.throws(()=>runs.claim(scope,'edge',edge,'w',10,100,100),/cannot be claimed/,'at the deadline');assert.equal(runs.claim(scope,'edge',edge,'w',10,99,100).status,'running','one millisecond before');
  // A run that is not queued, or has no attempts left, cannot be claimed.
  const running=runs.get(scope,'edge');assert.throws(()=>runs.claim(scope,'edge',running.revision,'w',10,99,100),/cannot be claimed/,'already running');
  const once=make(runs,'once',{maxAttempts:1,deadline:DAY});const used=runs.claim(scope,'once',once.revision,'w',10,0,100);const settled=runs.settle(scope,'once',used.revision,used.leaseToken,'failed',1);
  assert.equal(settled.status,'failed');assert.throws(()=>runs.claim(scope,'once',settled.revision,'w',10,2,100),/cannot be claimed/,'not queued after a failure');
  // Concurrency per agent: a running run counts, a run of another agent does not.
  const {runs:isolated,close:closeIsolated}=open();
  try{
   const a=make(isolated,'a1',{deadline:DAY}),b=make(isolated,'a2',{deadline:DAY}),c=make(isolated,'a3',{deadline:DAY}),other=make(isolated,'o1',{deadline:DAY,agent:'other'});
   isolated.claim(scope,'a1',a.revision,'w',100,0);assert.throws(()=>isolated.claim(scope,'a2',b.revision,'w',100,0),/concurrency limit/,'one at a time by default');
   assert.equal(isolated.claim({...scope,agentId:'other'},'o1',other.revision,'w',100,0).status,'running','another agent is not counted');
   isolated.claim(scope,'a2',b.revision,'w',100,0,2);assert.throws(()=>isolated.claim(scope,'a3',c.revision,'w',100,0,2),/concurrency limit/,'two at a time');isolated.claim(scope,'a3',c.revision,'w',100,0,3);
  }finally{closeIsolated();}
  // Starts per day: counted on the first claim of a run, per calendar day; a retry of the same run is not a new start.
  const {runs:daily,close:closeDaily}=open();
  try{
   const ids=['d1','d2','d3'].map(id=>make(daily,id,{deadline:10*DAY,maxAttempts:5}));
   const first=daily.claim(scope,'d1',ids[0].revision,'w',100,DAY+5,5,2);
   const second=daily.claim(scope,'d2',ids[1].revision,'w',100,DAY+6,5,2);assert.equal(second.status,'running');
   assert.throws(()=>daily.claim(scope,'d3',ids[2].revision,'w',100,DAY+7,5,2),/daily run limit/,'the third start of the day');
   assert.equal(daily.claim(scope,'d3',ids[2].revision,'w',100,2*DAY,5,2).status,'running','the first moment of the next day');
   // d1 is retried the same day: it already started, so it is not counted again.
   const stopped=daily.settle(scope,'d1',first.revision,first.leaseToken,'uncertain',DAY+8);const queued=daily.reconcile(scope,'d1',stopped.revision,'retry',DAY+9);
   assert.equal(daily.claim(scope,'d1',queued.revision,'w',100,DAY+10,5,2).status,'running','a retry is not a new start');
  }finally{closeDaily();}
 }finally{close();}
});

test('a lease ends at its last millisecond and can only be renewed while it is held',()=>{
 const {runs,close}=open();
 try{
  const created=make(runs,'r',{deadline:10_000}),claimed=runs.claim(scope,'r',created.revision,'worker',100,10);          // the lease runs until 110
  assert.equal(claimed.leaseUntil,110);assert.equal(claimed.leaseOwner,'worker');assert.match(claimed.leaseToken,/^[0-9a-f-]{36}$/);
  for(const [label,args] of Object.entries({'token invalid':['',10,50],'lease 0':[claimed.leaseToken,0,50],'lease over an hour':[claimed.leaseToken,3600001,50],'now negative':[claimed.leaseToken,10,-1],'now too large':[claimed.leaseToken,10,Number.MAX_SAFE_INTEGER]}))assert.throws(()=>runs.renew(scope,'r',claimed.revision,...args),/Invalid lease/,label);
  assert.throws(()=>runs.renew(scope,'r',claimed.revision,'wrong-token',10,50),/Invalid or expired lease/,'another token');
  assert.throws(()=>runs.renew(scope,'r',claimed.revision,claimed.leaseToken,10,110),/Invalid or expired lease/,'at the moment the lease ends');
  const renewed=runs.renew(scope,'r',claimed.revision,claimed.leaseToken,200,109);assert.equal(renewed.leaseUntil,309,'renewed from now, not from the old end');
  const capped=runs.renew(scope,'r',renewed.revision,claimed.leaseToken,20_000,200);assert.equal(capped.leaseUntil,10_000,'never beyond the deadline');
  // Only a running run can be renewed: a pause request keeps the lease but stops renewals.
  const asked=runs.request(scope,'r',capped.revision,'pause',200);assert.equal(asked.status,'pause_requested');
  assert.throws(()=>runs.renew(scope,'r',asked.revision,claimed.leaseToken,10,201),/cannot be renewed/);
  const queuedRun=make(runs,'q');assert.throws(()=>runs.renew(scope,'q',queuedRun.revision,'token',10,0),/Invalid or expired lease/,'a queued run holds no lease');
 }finally{close();}
});

test('pause, resume and cancel are legal only from the right states',()=>{
 const {runs,close}=open();
 try{
  const act=(id,action,now=0)=>{const run=runs.get(scope,id);return runs.request(scope,id,run.revision,action,now);};
  for(const bad of ['stop','','PAUSE',undefined])assert.throws(()=>runs.request(scope,'x',1,bad,0),/Invalid run action/,String(bad));assert.throws(()=>runs.request(scope,'x',1,'pause',-1),/Invalid run action/);assert.throws(()=>runs.request(scope,'x',1,'pause',1.5),/Invalid run action/);
  // queued
  make(runs,'q');assert.equal(act('q','pause').status,'paused');assert.equal(act('q','resume').status,'queued','resume puts it back in the queue');assert.equal(act('q','cancel').status,'cancelled');
  assert.throws(()=>act('q','pause'),/Invalid run state/,'a cancelled run cannot be paused');assert.throws(()=>act('q','resume'),/Invalid run state/);assert.throws(()=>act('q','cancel'),/Invalid run state/);
  make(runs,'resume-queued');assert.throws(()=>act('resume-queued','resume'),/Invalid run state/,'only a paused run is resumed');
  // running
  const r=make(runs,'r',{deadline:10_000});const claimed=runs.claim(scope,'r',r.revision,'w',100,10);
  assert.equal(act('r','pause',20).status,'pause_requested');assert.throws(()=>act('r','pause',20),/Invalid run state/,'pause twice');assert.equal(act('r','cancel',20).status,'cancel_requested','cancelling a pausing run');assert.throws(()=>act('r','resume',20),/Invalid run state/);assert.throws(()=>act('r','cancel',20),/Invalid run state/,'cancel twice');
  const r2=make(runs,'r2',{deadline:10_000});runs.claim(scope,'r2',r2.revision,'w',100,10,5);assert.equal(act('r2','cancel',20).status,'cancel_requested');
  // resume has a deadline and an attempts limit
  make(runs,'late',{deadline:100});act('late','pause');assert.throws(()=>act('late','resume',100),/deadline expired/,'at the deadline');assert.equal(act('late','resume',99).status,'queued','one millisecond before');
  const spent=make(runs,'spent',{maxAttempts:1,deadline:10_000});const used=runs.claim(scope,'spent',spent.revision,'w',100,10,5);const stopped=runs.request(scope,'spent',used.revision,'pause',20);runs.settle(scope,'spent',stopped.revision,used.leaseToken,'stopped',30);
  assert.equal(runs.get(scope,'spent').status,'paused');assert.throws(()=>act('spent','resume',40),/attempts exhausted/,'a paused run with no attempts left');
  void claimed;
 }finally{close();}
});

test('settling needs the lease and maps each outcome to a status',()=>{
 const {runs,close}=open();
 try{
  const start=(id,options)=>{const created=make(runs,id,{deadline:10_000,...options});return runs.claim(scope,id,created.revision,'w',100,10,10);};
  const done=start('ok');
  for(const [label,args] of Object.entries({'token invalid':['','succeeded',20],'outcome unknown':[done.leaseToken,'done',20],'outcome missing':[done.leaseToken,undefined,20],'now negative':[done.leaseToken,'succeeded',-1],'now fractional':[done.leaseToken,'succeeded',1.5]}))assert.throws(()=>runs.settle(scope,'ok',done.revision,...args),/Invalid run outcome/,label);
  assert.throws(()=>runs.settle(scope,'ok',done.revision,'wrong-token','succeeded',20),/Invalid or expired lease/,'another token');
  assert.throws(()=>runs.settle(scope,'ok',done.revision,done.leaseToken,'succeeded',110),/Invalid or expired lease/,'the lease has ended');
  assert.throws(()=>runs.settle(scope,'ok',done.revision,done.leaseToken,'stopped',20),/Invalid run state/,'stopped needs a pause or cancel request');
  const succeeded=runs.settle(scope,'ok',done.revision,done.leaseToken,'succeeded',109);assert.deepEqual([succeeded.status,succeeded.leaseOwner,succeeded.leaseToken,succeeded.leaseUntil],['succeeded',null,null,null],'settled one millisecond before the lease ended, and the lease is released');
  const failed=start('bad');assert.equal(runs.settle(scope,'bad',failed.revision,failed.leaseToken,'failed',20).status,'failed');
  const unsure=start('unsure');assert.equal(runs.settle(scope,'unsure',unsure.revision,unsure.leaseToken,'uncertain',20).status,'uncertain');
  const pausing=start('pausing'),paused=runs.request(scope,'pausing',pausing.revision,'pause',20);assert.equal(runs.settle(scope,'pausing',paused.revision,pausing.leaseToken,'stopped',30).status,'paused','a pause request ends paused');
  const cancelling=start('cancelling'),cancel=runs.request(scope,'cancelling',cancelling.revision,'cancel',20);assert.equal(runs.settle(scope,'cancelling',cancel.revision,cancelling.leaseToken,'stopped',30).status,'cancelled','a cancel request ends cancelled');
  const asked=start('asked'),pause=runs.request(scope,'asked',asked.revision,'pause',20);assert.equal(runs.settle(scope,'asked',pause.revision,asked.leaseToken,'succeeded',30).status,'succeeded','a run that finished anyway is succeeded');
 }finally{close();}
});

test('an expired lease is recovered into uncertain, and uncertain runs are reconciled explicitly',()=>{
 const {runs,close}=open();
 try{
  const created=make(runs,'r',{deadline:1000}),claimed=runs.claim(scope,'r',created.revision,'w',100,10);               // the lease runs until 110
  assert.throws(()=>runs.recoverExpired(scope,'r',claimed.revision,109),/Lease is active/,'one millisecond before the end');
  assert.throws(()=>runs.recoverExpired(scope,'r',claimed.revision,-1),/Invalid time/);assert.throws(()=>runs.recoverExpired(scope,'r',claimed.revision,1.5),/Invalid time/);
  const q=make(runs,'queued');assert.throws(()=>runs.recoverExpired(scope,'queued',q.revision,10_000),/Lease is active/,'a queued run has no lease');
  const uncertain=runs.recoverExpired(scope,'r',claimed.revision,110);assert.deepEqual([uncertain.status,uncertain.leaseOwner,uncertain.leaseToken,uncertain.leaseUntil],['uncertain',null,null,null],'recoverable from the moment the lease ends');
  assert.throws(()=>runs.recoverExpired(scope,'r',uncertain.revision,500),/Lease is active/,'only a leased run is recovered');
  // reconcile
  for(const bad of ['cancel','','done',undefined])assert.throws(()=>runs.reconcile(scope,'r',uncertain.revision,bad,200),/Invalid reconciliation/,String(bad));assert.throws(()=>runs.reconcile(scope,'r',uncertain.revision,'failed',-1),/Invalid reconciliation/);
  assert.throws(()=>runs.reconcile(scope,'queued',q.revision,'failed',200),/Invalid run state/,'only an uncertain run is reconciled');
  assert.throws(()=>runs.reconcile(scope,'r',uncertain.revision,'retry',1000),/cannot be retried/,'at the deadline');
  const retried=runs.reconcile(scope,'r',uncertain.revision,'retry',999);assert.equal(retried.status,'queued','one millisecond before the deadline');
  // each outcome
  for(const [outcome,status] of [['succeeded','succeeded'],['failed','failed'],['cancelled','cancelled'],['paused','paused']]){
   const id='o-'+outcome,fresh=make(runs,id,{deadline:1000}),got=runs.claim(scope,id,fresh.revision,'w',10,0,10),stuck=runs.recoverExpired(scope,id,got.revision,10);
   assert.equal(runs.reconcile(scope,id,stuck.revision,outcome,20).status,status,outcome);
  }
  // no retry once every attempt has been used
  const one=make(runs,'one',{maxAttempts:1,deadline:1000}),got=runs.claim(scope,'one',one.revision,'w',10,0,10),stuck=runs.recoverExpired(scope,'one',got.revision,10);
  assert.throws(()=>runs.reconcile(scope,'one',stuck.revision,'retry',20),/cannot be retried/,'no attempts left');
 }finally{close();}
});

test('only a finished run can be archived, and an archived run is frozen',()=>{
 const {runs,close}=open();
 try{
  const created=make(runs,'r',{deadline:1000});
  for(const status of ['queued','running'])assert.throws(()=>runs.archive(scope,'r',runs.get(scope,'r').revision),/Invalid run state/,status+' run'),status==='queued'&&runs.claim(scope,'r',runs.get(scope,'r').revision,'w',100,0);
  const running=runs.get(scope,'r'),settled=runs.settle(scope,'r',running.revision,running.leaseToken,'succeeded',10);
  assert.equal(runs.get(scope,'r').archived,false);const archived=runs.archive(scope,'r',settled.revision);assert.equal(archived.archived,true);
  assert.throws(()=>runs.archive(scope,'r',archived.revision),/archived/,'archiving twice');assert.throws(()=>runs.request(scope,'r',archived.revision,'cancel',20),/archived/,'an archived run takes no request');
  assert.deepEqual(runs.list(scope).map(r=>r.runId),[],'archived runs are left out of listings');assert.deepEqual(runs.list(scope,{includeArchived:true}).map(r=>r.runId),['r']);
  for(const status of ['failed','cancelled']){const id='end-'+status,run=make(runs,id,{deadline:1000});if(status==='failed'){const got=runs.claim(scope,id,run.revision,'w',100,0,10),done=runs.settle(scope,id,got.revision,got.leaseToken,'failed',10);assert.equal(runs.archive(scope,id,done.revision).archived,true,status);}else{const cancelled=runs.request(scope,id,run.revision,'cancel',0);assert.equal(runs.archive(scope,id,cancelled.revision).archived,true,status);}}
  void created;
 }finally{close();}
});
