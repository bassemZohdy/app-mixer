import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteAgentRuns,SqliteAgentTriggers,SqliteAgentSchedules,SqliteAgentScheduleHistory,SqliteAgentDefinitions,AgentScheduleWorker,DurableAgentWorker} from '../dist/index.js';
const scope={tenantId:'tenant',agentId:'agent'},config={enabled:true,principalId:'scheduler',rule:{kind:'interval',intervalMs:1000}},policy={definitionVersion:1,maxAttempts:2,runTimeoutMs:10000,maxPending:10};
const manifest={manifestVersion:1,tenantId:'tenant',agentId:'agent',name:'Agent',owner:{kind:'organization',id:'org'},administrators:['admin'],servicePrincipalId:'svc',model:{provider:'local',model:'test'},allowedCapabilities:[],lifecycle:{enabled:true,maxAttempts:2,runTimeoutMs:10000},quotas:{maxConcurrentRuns:1,maxTokensPerRun:100,maxRunsPerDay:10}};
function setup(){const dir=mkdtempSync(join(tmpdir(),'app-mixer-schedules-')),path=join(dir,'db.sqlite'),runs=new SqliteAgentRuns(path),triggers=new SqliteAgentTriggers(path),schedules=new SqliteAgentSchedules(path);return {dir,path,runs,triggers,schedules};}
function close(s){s.schedules.close();s.triggers.close();s.runs.close();rmSync(s.dir,{recursive:true,force:true});}

test('scheduler supports asynchronous definitions and stops safely during recheck',async()=>{const s=setup(),store=new SqliteAgentDefinitions(':memory:');try{store.save('tenant',manifest,0);s.schedules.save(scope,'timer',config,0,0);let block=false,started,release,reads=0;const ready=new Promise(r=>started=r),gate=new Promise(r=>release=r),definitions={get:async(tenant,agent)=>{if(block&&++reads===2){started();await gate;}return store.get(tenant,agent);}},worker=new AgentScheduleWorker({schedules:s.schedules,scope,definitions,authorize:()=>true,maxPending:5,maxPerPass:2,pollMs:100,onError:()=>{},clock:()=>1000});block=true;worker.start();await ready;const stopped=worker.stop();release();await stopped;assert.equal(s.runs.list(scope).length,0);block=false;assert.equal(await worker.runOnce(),1);assert.equal(s.runs.list(scope)[0].definitionVersion,1);}finally{store.close();close(s)}});

test('scheduled occurrences are atomic, deduplicated and survive competing schedulers',()=>{
 const s=setup();let other;try{let schedule=s.schedules.save(scope,'daily',config,0,1000);assert.equal(schedule.nextAt,2000);other=new SqliteAgentSchedules(s.path);const first=s.schedules.fire(scope,'daily',schedule.revision,policy,2000);assert.equal(first.scheduledAt,2000);assert.equal(s.runs.get(scope,first.runId).status,'queued');assert.deepEqual(s.triggers.get(scope,first.runId).payload,{scheduleId:'daily',scheduledAt:2000});assert.equal(other.getOccurrence(scope,'daily',schedule.generation,2000),first.runId);assert.throws(()=>other.fire(scope,'daily',schedule.revision,policy,2000),/revision conflict/);
  schedule=other.get(scope,'daily');assert.equal(schedule.nextAt,3000);const second=other.fire(scope,'daily',schedule.revision,policy,5000);assert.equal(second.scheduledAt,3000);assert.notEqual(second.runId,first.runId);
  assert.equal(other.get({...scope,tenantId:'other'},'daily'),undefined);schedule=other.get(scope,'daily');const disabled=other.save(scope,'daily',{...config,enabled:false},schedule.revision,5000);assert.equal(other.due(scope,10000).length,0);assert.throws(()=>other.fire(scope,'daily',disabled.revision,policy,10000),/not due/);
 }finally{other?.close();close(s);}
});

test('schedule history records immutable scoped changes and fired occurrences',async()=>{
 const s=setup();let history,db;try{let schedule=s.schedules.save(scope,'daily',config,0,1000,'admin');const fired=s.schedules.fire(scope,'daily',schedule.revision,policy,2000,'worker');schedule=s.schedules.get(scope,'daily');s.schedules.save(scope,'daily',{...config,enabled:false},schedule.revision,2500);history=new SqliteAgentScheduleHistory(s.path,{scope,authorize:(actor,action,event)=>actor.principalId==='reviewer'&&(action==='list'||event.scheduleId==='daily')});const actor={tenantId:'tenant',principalId:'reviewer'},first=await history.list(actor,{limit:2}),second=await history.list(actor,{after:first.nextAfter,limit:2}),events=[...first.items,...second.items];assert.deepEqual(events.map(event=>event.kind),['created','fired','updated']);assert.deepEqual(events.map(event=>event.revision),[1,2,3]);assert.deepEqual(events.map(event=>event.actorId),['admin','worker',null]);assert.equal(events[1].runId,fired.runId);assert.equal(events[1].scheduledAt,2000);assert.equal(events[2].config.enabled,false);await assert.rejects(history.list({...actor,tenantId:'other'}),/actor/);await assert.rejects(history.list({...actor,principalId:'other'}),/denied/);db=new DatabaseSync(s.path);assert.throws(()=>db.exec('UPDATE agent_schedule_events SET kind=\'created\''),/immutable/);assert.throws(()=>db.exec('DELETE FROM agent_schedule_events'),/immutable/);assert.throws(()=>db.exec("INSERT OR REPLACE INTO agent_schedule_events(tenant_id,agent_id,schedule_id,kind,revision,generation,next_at,config,observed_at) VALUES ('tenant','agent','daily','created',1,1,1000,'{}',1)"),/immutable/);}finally{db?.close();history?.close();close(s)}
});

test('schedule audit failure rolls back both configuration and occurrence creation',()=>{
 const s=setup();let db;try{db=new DatabaseSync(s.path);db.exec("CREATE TRIGGER fail_schedule_audit BEFORE INSERT ON agent_schedule_events BEGIN SELECT RAISE(ABORT,'audit failed'); END");assert.throws(()=>s.schedules.save(scope,'timer',config,0,0,'admin'),/audit failed/);assert.equal(s.schedules.get(scope,'timer'),undefined);db.exec('DROP TRIGGER fail_schedule_audit');const schedule=s.schedules.save(scope,'timer',config,0,0,'admin');db.exec("CREATE TRIGGER fail_schedule_audit BEFORE INSERT ON agent_schedule_events WHEN NEW.kind='fired' BEGIN SELECT RAISE(ABORT,'audit failed'); END");assert.throws(()=>s.schedules.fire(scope,'timer',schedule.revision,policy,1000,'worker'),/audit failed/);assert.equal(s.runs.list(scope).length,0);assert.equal(s.schedules.getOccurrence(scope,'timer',1,1000),undefined);assert.equal(s.schedules.get(scope,'timer').revision,1);}finally{db?.close();close(s)}
});

test('schedule worker snapshots its audit actor and denied activations do not add events',async()=>{
 const s=setup(),definitions=new SqliteAgentDefinitions(':memory:');let history;try{definitions.save('tenant',manifest,0);s.schedules.save(scope,'timer',config,0,0,'admin');let allowed=false;const options={schedules:s.schedules,scope,definitions,authorize:()=>allowed,maxPending:5,maxPerPass:2,pollMs:100,onError:()=>{},clock:()=>1000,auditActorId:'worker'};const worker=new AgentScheduleWorker(options);options.auditActorId='other';assert.equal(await worker.runOnce(),0);allowed=true;assert.equal(await worker.runOnce(),1);history=new SqliteAgentScheduleHistory(s.path,{scope,authorize:()=>true});const events=(await history.list({tenantId:'tenant',principalId:'reviewer'})).items;assert.deepEqual(events.map(event=>event.actorId),['admin','worker']);assert.deepEqual(events.map(event=>event.kind),['created','fired']);}finally{history?.close();definitions.close();close(s)}
});

test('UTC cron schedules honor month, weekday and day-of-month rules',()=>{
 const s=setup();try{
  const now=Date.parse('2026-10-29T07:15:30Z');let daily=s.schedules.save(scope,'cron',{...config,rule:{kind:'cron',expression:'0 8 * * 1-5'}},0,now);assert.equal(daily.nextAt,Date.parse('2026-10-29T08:00:00Z'));
  let leap=s.schedules.save(scope,'leap',{...config,rule:{kind:'cron',expression:'0 0 29 2 *'}},0,now);assert.equal(leap.nextAt,Date.parse('2028-02-29T00:00:00Z'));
  let either=s.schedules.save(scope,'either',{...config,rule:{kind:'cron',expression:'0 0 1 * 1'}},0,Date.parse('2026-11-01T00:00:00Z'));assert.equal(either.nextAt,Date.parse('2026-11-02T00:00:00Z'));
  for(const expression of ['* * *','60 * * * *','0 24 * * *','0 0 * * 7','5/2 * * * *','0 0 31 2 *'])assert.throws(()=>s.schedules.save(scope,'bad',{...config,rule:{kind:'cron',expression}},0,now));
 }finally{close(s);}
});

test('backpressure and inbox failure leave schedule cursor unchanged',()=>{
 const s=setup();let db;try{let schedule=s.schedules.save(scope,'timer',config,0,0);s.runs.create(scope,'other',{definitionVersion:1,maxAttempts:1,deadline:10000},0);assert.throws(()=>s.schedules.fire(scope,'timer',schedule.revision,{...policy,maxPending:1},1000),/backlog/);assert.equal(s.schedules.get(scope,'timer').nextAt,1000);
  db=new DatabaseSync(s.path);db.exec("CREATE TRIGGER fail_tick BEFORE INSERT ON agent_trigger_inbox BEGIN SELECT RAISE(ABORT,'test failure'); END;");assert.throws(()=>s.schedules.fire(scope,'timer',schedule.revision,policy,1000),/test failure/);assert.equal(s.schedules.get(scope,'timer').revision,schedule.revision);assert.equal(s.runs.list(scope).length,1);
 }finally{db?.close();close(s);}
});

test('authorized scheduler creates a run and a worker consumes the trigger',async()=>{
 const s=setup(),definitions=new SqliteAgentDefinitions(':memory:');try{definitions.save('tenant',manifest,0);s.schedules.save(scope,'timer',config,0,0);let now=1000,allow=false;const errors=[];
  const scheduler=new AgentScheduleWorker({schedules:s.schedules,scope,definitions,authorize:()=>allow,maxPending:5,maxPerPass:2,pollMs:100,onError:e=>errors.push(e),clock:()=>now});assert.equal(await scheduler.runOnce(),0);assert.equal(s.runs.list(scope).length,0);allow=true;assert.equal(await scheduler.runOnce(),1);const run=s.runs.list(scope)[0];let event;
  const worker=new DurableAgentWorker({runs:s.runs,definitions,workerId:'worker',leaseMs:300,pollMs:50,clock:()=>1001,authorizeStart:()=>true,execute:async item=>{event=s.triggers.get(scope,item.runId);return 'succeeded';}});assert.equal((await worker.runOnce(scope,run.runId)).status,'succeeded');assert.equal(event.eventType,'schedule.tick');assert.equal(event.payload.scheduledAt,1000);assert.deepEqual(errors,[]);
  now=2000;assert.equal(await scheduler.runOnce(),1);
 }finally{definitions.close();close(s);}
});

test('stopping scheduler during authorization prevents enqueue',async()=>{
 const s=setup(),definitions=new SqliteAgentDefinitions(':memory:');try{definitions.save('tenant',manifest,0);s.schedules.save(scope,'timer',config,0,0);let started,resume;const ready=new Promise(r=>started=r),gate=new Promise(r=>resume=r);
  const scheduler=new AgentScheduleWorker({schedules:s.schedules,scope,definitions,authorize:async()=>{started();await gate;return true;},maxPending:5,maxPerPass:2,pollMs:100,onError:()=>{},clock:()=>1000});scheduler.start();await ready;const stopped=scheduler.stop();resume();await stopped;assert.equal(s.runs.list(scope).length,0);
 }finally{definitions.close();close(s);}
});


test('schedule generation distinguishes reconfigured occurrences',()=>{
 const s=setup();try{let schedule=s.schedules.save(scope,'timer',config,0,0);const first=s.schedules.fire(scope,'timer',schedule.revision,policy,1000);schedule=s.schedules.get(scope,'timer');const updated=s.schedules.save(scope,'timer',config,schedule.revision,0);assert.equal(updated.nextAt,1000);const second=s.schedules.fire(scope,'timer',updated.revision,policy,1000);assert.notEqual(first.runId,second.runId);assert.equal(s.schedules.getOccurrence(scope,'timer',1,1000),first.runId);assert.equal(s.schedules.getOccurrence(scope,'timer',2,1000),second.runId);}
 finally{close(s);}
});


test('schedule keyset pages preserve due order and scope across ties',()=>{
 const s=setup();try{for(const id of ['a','b','c'])s.schedules.save(scope,id,config,0,0);s.schedules.save(scope,'later',config,0,100);s.schedules.save({...scope,tenantId:'other'},'hidden',config,0,0);const first=s.schedules.duePage(scope,1100,2);assert.deepEqual(first.items.map(x=>x.scheduleId),['a','b']);assert.deepEqual(first.next,{nextAt:1000,scheduleId:'b'});const second=s.schedules.duePage(scope,1100,2,first.next);assert.deepEqual(second.items.map(x=>x.scheduleId),['c','later']);assert.equal(second.next,undefined);assert.deepEqual(s.schedules.duePage(scope,999,2).items,[]);for(const cursor of [{nextAt:-1,scheduleId:'a'},{nextAt:1000,scheduleId:'bad id'}])assert.throws(()=>s.schedules.duePage(scope,1100,2,cursor),/Invalid schedule query/);}finally{close(s);}
});

test('denied and failing schedules do not starve later due schedules',async()=>{
 const s=setup(),definitions=new SqliteAgentDefinitions(':memory:');try{definitions.save('tenant',manifest,0);for(const id of ['a','b','c'])s.schedules.save(scope,id,config,0,0);let attempts=[];const errors=[],worker=new AgentScheduleWorker({schedules:s.schedules,scope,definitions,authorize:schedule=>{attempts.push(schedule.scheduleId);if(schedule.scheduleId==='a')return false;if(schedule.scheduleId==='b')throw Error('policy unavailable');return true;},maxPending:5,maxPerPass:1,pollMs:100,onError:e=>errors.push(e.message),clock:()=>1000});assert.equal(await worker.runOnce(),0);assert.equal(await worker.runOnce(),0);assert.equal(await worker.runOnce(),1);assert.deepEqual(attempts,['a','b','c']);assert.deepEqual(errors,['policy unavailable']);assert.equal(s.triggers.get(scope,s.runs.list(scope)[0].runId).payload.scheduleId,'c');assert.equal(await worker.runOnce(),0);assert.equal(attempts.at(-1),'a');}finally{definitions.close();close(s);}
});

test('stopped authorization is retried instead of skipped on the next pass',async()=>{
 const s=setup(),definitions=new SqliteAgentDefinitions(':memory:');try{definitions.save('tenant',manifest,0);for(const id of ['a','b'])s.schedules.save(scope,id,config,0,0);let started,resume,block=true;const ready=new Promise(r=>started=r),gate=new Promise(r=>resume=r);const worker=new AgentScheduleWorker({schedules:s.schedules,scope,definitions,authorize:async schedule=>{if(block&&schedule.scheduleId==='a'){started();await gate;}return true;},maxPending:5,maxPerPass:1,pollMs:100,onError:()=>{},clock:()=>1000});worker.start();await ready;assert.throws(()=>worker.runOnce(),/already running/);const stopped=worker.stop();block=false;resume();await stopped;assert.equal(s.runs.list(scope).length,0);assert.equal(await worker.runOnce(),1);assert.equal(s.triggers.get(scope,s.runs.list(scope)[0].runId).payload.scheduleId,'a');assert.equal(await worker.runOnce(),1);}finally{definitions.close();close(s);}
});


test('coalescing creates one auditable run after downtime and keeps interval phase',async()=>{
 const s=setup();let other,history;try{const selected={...config,misfire:'coalesce'},first=s.schedules.save(scope,'timer',selected,0,100),saved=s.schedules.get(scope,'timer');assert.equal(saved.config.misfire,'coalesce');assert.equal(first.nextAt,1100);other=new SqliteAgentSchedules(s.path);s.runs.create(scope,'busy',{definitionVersion:1,maxAttempts:1,deadline:20000},0);assert.throws(()=>s.schedules.fire(scope,'timer',first.revision,{...policy,maxPending:1},5500),/backlog/);assert.equal(s.schedules.get(scope,'timer').nextAt,1100);const fired=s.schedules.fire(scope,'timer',first.revision,policy,5500,'worker');assert.deepEqual(s.triggers.get(scope,fired.runId).payload,{scheduleId:'timer',scheduledAt:1100,coalescedThrough:5500});assert.equal(s.schedules.get(scope,'timer').nextAt,6100);assert.equal(other.getOccurrence(scope,'timer',1,1100),fired.runId);assert.equal(other.getOccurrence(scope,'timer',1,2100),undefined);assert.throws(()=>other.fire(scope,'timer',first.revision,policy,5500),/revision conflict/);assert.equal(s.schedules.due(scope,5500).length,0);history=new SqliteAgentScheduleHistory(s.path,{scope,authorize:()=>true});const events=(await history.list({tenantId:'tenant',principalId:'reviewer'})).items;assert.equal(events[1].scheduledAt,1100);assert.equal(events[1].nextAt,6100);assert.equal(events[1].observedAt,5500);assert.equal(events[1].config.misfire,'coalesce');assert.equal(events[1].actorId,'worker');
 }finally{history?.close();other?.close();close(s);}
});

test('cron coalescing advances beyond observation time and default catches up',()=>{
 const s=setup();try{const start=Date.parse('2026-10-29T07:00:00Z'),now=Date.parse('2026-11-02T08:00:00Z'),rule={kind:'cron',expression:'0 8 * * *'},merged=s.schedules.save(scope,'merged',{...config,rule,misfire:'coalesce'},0,start),normal=s.schedules.save(scope,'normal',{...config,rule},0,start),a=s.schedules.fire(scope,'merged',merged.revision,policy,now),b=s.schedules.fire(scope,'normal',normal.revision,policy,now);assert.equal(a.scheduledAt,Date.parse('2026-10-29T08:00:00Z'));assert.equal(s.schedules.get(scope,'merged').nextAt,Date.parse('2026-11-03T08:00:00Z'));assert.equal(s.triggers.get(scope,a.runId).payload.coalescedThrough,now);assert.equal(s.schedules.get(scope,'normal').nextAt,Date.parse('2026-10-30T08:00:00Z'));assert.equal(Object.hasOwn(s.triggers.get(scope,b.runId).payload,'coalescedThrough'),false);for(const value of ['skip',true,null,1])assert.throws(()=>s.schedules.save(scope,'bad',{...config,misfire:value},0,start),/Invalid schedule/);
 }finally{close(s);}
});


test('zoned cron skips nonexistent wall times and fires both repeated instants',()=>{
 const s=setup();try{const rule={kind:'cron',expression:'30 2 * * *',timeZone:'America/New_York'},spring=s.schedules.save(scope,'spring',{...config,rule},0,Date.parse('2026-03-07T08:00:00Z'));assert.equal(spring.nextAt,Date.parse('2026-03-09T06:30:00Z'));const fall=s.schedules.save(scope,'fall',{...config,rule:{...rule,expression:'30 1 * * *'}},0,Date.parse('2026-11-01T04:00:00Z'));assert.equal(fall.nextAt,Date.parse('2026-11-01T05:30:00Z'));s.schedules.fire(scope,'fall',fall.revision,policy,fall.nextAt);let next=s.schedules.get(scope,'fall');assert.equal(next.nextAt,Date.parse('2026-11-01T06:30:00Z'));s.schedules.fire(scope,'fall',next.revision,policy,next.nextAt);next=s.schedules.get(scope,'fall');assert.equal(next.nextAt,Date.parse('2026-11-02T06:30:00Z'));const midway=s.schedules.save(scope,'midway',{...config,rule:{...rule,expression:'0 1 * * *'}},0,Date.parse('2026-11-01T05:45:00Z'));assert.equal(midway.nextAt,Date.parse('2026-11-01T06:00:00Z'));
 }finally{close(s);}
});

test('zoned cron handles non-hour offsets, leap days and coalescing',()=>{
 const s=setup();try{const dubai=s.schedules.save(scope,'dubai',{...config,rule:{kind:'cron',expression:'0 9 * * *',timeZone:'Asia/Kathmandu'}},0,Date.parse('2026-10-29T02:00:00Z'));assert.equal(dubai.nextAt,Date.parse('2026-10-29T03:15:00Z'));const leap=s.schedules.save(scope,'leap-zone',{...config,rule:{kind:'cron',expression:'0 0 29 2 *',timeZone:'America/New_York'}},0,Date.parse('2026-10-29T00:00:00Z'));assert.equal(leap.nextAt,Date.parse('2028-02-29T05:00:00Z'));const joined=s.schedules.save(scope,'joined',{...config,misfire:'coalesce',rule:{kind:'cron',expression:'30 1 * * *',timeZone:'America/New_York'}},0,Date.parse('2026-11-01T04:00:00Z'));const now=Date.parse('2026-11-01T06:45:00Z'),fired=s.schedules.fire(scope,'joined',joined.revision,policy,now);assert.equal(s.triggers.get(scope,fired.runId).payload.coalescedThrough,now);assert.equal(s.schedules.get(scope,'joined').nextAt,Date.parse('2026-11-02T06:30:00Z'));for(const timeZone of ['Invalid/Zone','+05:30','',null,3])assert.throws(()=>s.schedules.save(scope,'bad-zone',{...config,rule:{kind:'cron',expression:'* * * * *',timeZone}},0,0),/time zone/);
 }finally{close(s);}
});


test('zoned cron skips a whole missing local calendar day',()=>{
 const s=setup();try{const scheduled=s.schedules.save(scope,'apia',{...config,rule:{kind:'cron',expression:'0 12 * * *',timeZone:'Pacific/Apia'}},0,Date.parse('2011-12-29T23:00:00Z'));assert.equal(scheduled.nextAt,Date.parse('2011-12-30T22:00:00Z'));}finally{close(s);}
});


test('cron exclusion dates skip holidays in the schedule time zone and persist atomically',async()=>{
 const s=setup();let history;try{const now=Date.parse('2026-12-23T00:00:00Z'),rule={kind:'cron',expression:'0 9 * * *',timeZone:'Asia/Tokyo',excludeDates:['2026-12-24','2026-12-25']},scheduled=s.schedules.save(scope,'holiday',{...config,rule},0,now,'admin');rule.excludeDates.push('2026-12-26');assert.deepEqual(s.schedules.get(scope,'holiday').config.rule.excludeDates,['2026-12-24','2026-12-25']);assert.equal(scheduled.nextAt,Date.parse('2026-12-23T00:00:00Z')+86400000*3);const fire=s.schedules.fire(scope,'holiday',scheduled.revision,policy,scheduled.nextAt,'worker');assert.equal(s.triggers.get(scope,fire.runId).payload.scheduledAt,scheduled.nextAt);assert.equal(s.schedules.get(scope,'holiday').nextAt,Date.parse('2026-12-27T00:00:00Z'));history=new SqliteAgentScheduleHistory(s.path,{scope,authorize:()=>true});const events=(await history.list({tenantId:'tenant',principalId:'reviewer'})).items;assert.deepEqual(events[0].config.rule.excludeDates,['2026-12-24','2026-12-25']);const previous=s.schedules.get(scope,'holiday'),updated=s.schedules.save(scope,'holiday',{...config,rule:{...previous.config.rule,excludeDates:['2026-12-27']}},previous.revision,scheduled.nextAt,'admin');assert.equal(updated.generation,2);assert.equal(updated.nextAt,Date.parse('2026-12-28T00:00:00Z'));assert.equal(s.runs.get(scope,fire.runId).status,'queued');
 }finally{history?.close();close(s);}
});

test('cron exclusions cover repeated local times, UTC dates and coalescing',()=>{
 const s=setup();try{const start=Date.parse('2026-11-01T04:00:00Z'),rule={kind:'cron',expression:'30 1 * * *',timeZone:'America/New_York',excludeDates:['2026-11-01']},skip=s.schedules.save(scope,'fall-skip',{...config,rule},0,start);assert.equal(skip.nextAt,Date.parse('2026-11-02T06:30:00Z'));const utc=s.schedules.save(scope,'utc-skip',{...config,rule:{kind:'cron',expression:'0 0 * * *',excludeDates:['2026-11-02']}},0,start);assert.equal(utc.nextAt,Date.parse('2026-11-03T00:00:00Z'));const merged=s.schedules.save(scope,'merged-skip',{...config,misfire:'coalesce',rule:{kind:'cron',expression:'0 0 * * *',excludeDates:['2026-11-04']}},0,start),now=Date.parse('2026-11-03T12:00:00Z');s.schedules.fire(scope,'merged-skip',merged.revision,policy,now);assert.equal(s.schedules.get(scope,'merged-skip').nextAt,Date.parse('2026-11-05T00:00:00Z'));
 }finally{close(s);}
});

test('cron exclusions reject invalid calendars and no occurrence within the bounded horizon',()=>{
 const s=setup();try{const base={kind:'cron',expression:'0 0 * * *'};for(const excludeDates of [null,'2026-01-01',['2026-02-30'],['2026-1-01'],['2026-01-01','2026-01-01'],Array(367).fill('2026-01-01')])assert.throws(()=>s.schedules.save(scope,'bad',{...config,rule:{...base,excludeDates}},0,0),/excluded dates/);assert.throws(()=>s.schedules.save(scope,'bad',{...config,rule:{kind:'interval',intervalMs:1000,excludeDates:[]}},0,0),/Invalid schedule/);const years=Array.from({length:10},(_,i)=>`${2027+i}-01-01`);assert.throws(()=>s.schedules.save(scope,'none',{...config,rule:{kind:'cron',expression:'0 0 1 1 *',excludeDates:years}},0,Date.parse('2026-01-02T00:00:00Z')),/nine years/);assert.equal(s.schedules.get(scope,'none'),undefined);
 }finally{close(s);}
});

test('stopping a manual schedule pass prevents enqueue during authorization and retries the occurrence',async()=>{
 const s=setup(),definitions=new SqliteAgentDefinitions(':memory:');try{
  definitions.save('tenant',manifest,0);s.schedules.save(scope,'timer',config,0,0);let started,release,block=true;const ready=new Promise(r=>started=r),gate=new Promise(r=>release=r);
  const worker=new AgentScheduleWorker({schedules:s.schedules,scope,definitions,authorize:async()=>{if(block){started();await gate;}return true;},maxPending:5,maxPerPass:2,pollMs:100,onError:()=>{},clock:()=>1000});
  const pending=worker.runOnce();await ready;const stopped=worker.stop();block=false;release();assert.equal(await pending,0);await stopped;assert.equal(s.runs.list(scope).length,0);assert.equal(await worker.runOnce(),1);assert.equal(s.triggers.get(scope,s.runs.list(scope)[0].runId).payload.scheduleId,'timer');
 }finally{definitions.close();close(s);}
});

test('schedule worker snapshots validated bounds, scope and policy callback',async()=>{
 const s=setup(),definitions=new SqliteAgentDefinitions(':memory:');try{definitions.save('tenant',manifest,0);for(const id of ['a','b'])s.schedules.save(scope,id,config,0,0);const originalScope={...scope},options={schedules:s.schedules,scope:originalScope,definitions,authorize:()=>true,maxPending:5,maxPerPass:1,pollMs:100,onError:()=>{},clock:()=>1000},worker=new AgentScheduleWorker(options);options.authorize=()=>false;options.maxPending=0;options.maxPerPass=1000;options.pollMs=0;options.scope.tenantId='other';assert.equal(await worker.runOnce(),1);assert.equal(s.runs.list(scope).length,1);assert.equal(await worker.runOnce(),1);assert.equal(s.runs.list(scope).length,2);}finally{definitions.close();close(s);}
});
