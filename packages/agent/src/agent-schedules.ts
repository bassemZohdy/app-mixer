import {DatabaseSync} from 'node:sqlite';
import {Temporal} from '@js-temporal/polyfill';
import {createHash,randomUUID} from 'node:crypto';
import {type AgentRunScope} from './durable-runs.js';

type ScheduleRule={kind:'interval';intervalMs:number}|{kind:'cron';expression:string;timeZone?:string};
type ScheduleConfig={enabled:boolean;principalId:string;rule:ScheduleRule;misfire?:'catchUp'|'coalesce'};
export type AgentSchedule={tenantId:string;agentId:string;scheduleId:string;revision:number;generation:number;nextAt:number;config:ScheduleConfig};
export type AgentScheduleCursor={nextAt:number;scheduleId:string};
export type AgentSchedulePage={items:AgentSchedule[];next?:AgentScheduleCursor};
type FireOptions={definitionVersion:number;maxAttempts:number;runTimeoutMs:number;maxPending:number};
const id=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(x);
const integer=(x:unknown):x is number=>Number.isSafeInteger(x)&&Number(x)>=0;
function field(raw:string,min:number,max:number):Set<number>{
 const values=new Set<number>();for(const piece of raw.split(',')){
  const parts=piece.split('/');if(parts.length>2||!parts[0]||parts[1]===''||(parts[1]!==undefined&&!/^\d+$/.test(parts[1])))throw Error('Invalid cron expression');
  if(parts[1]!==undefined&&parts[0]!=='*'&&!parts[0].includes('-'))throw Error('Invalid cron expression');
  const step=parts[1]===undefined?1:Number(parts[1]);if(!Number.isSafeInteger(step)||step<1||step>max-min+1)throw Error('Invalid cron expression');
  let start:number,end:number;if(parts[0]==='*'){start=min;end=max;}else{const range=parts[0].split('-');if(range.length>2||range.some(x=>!/^\d+$/.test(x)))throw Error('Invalid cron expression');start=Number(range[0]);end=range.length===2?Number(range[1]):start;}
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<min||end>max||start>end)throw Error('Invalid cron expression');for(let n=start;n<=end;n+=step)values.add(n);
 }return values;
}
function cron(expression:string){
 if(typeof expression!=='string'||expression.length>200)throw Error('Invalid cron expression');const parts=expression.trim().split(/\s+/);if(parts.length!==5)throw Error('Invalid cron expression');
 return {minutes:field(parts[0],0,59),hours:field(parts[1],0,23),days:field(parts[2],1,31),months:field(parts[3],1,12),weekdays:field(parts[4],0,6),dayAny:parts[2]==='*',weekdayAny:parts[4]==='*'};
}
function checkConfig(config:ScheduleConfig):ScheduleConfig{
 if(!config||typeof config!=='object'||Object.keys(config).some(k=>!['enabled','principalId','rule','misfire'].includes(k))||typeof config.enabled!=='boolean'||!id(config.principalId)||(config.misfire!==undefined&&!['catchUp','coalesce'].includes(config.misfire))||!config.rule||typeof config.rule!=='object')throw Error('Invalid schedule');
 if(config.rule.kind==='interval'){if(Object.keys(config.rule).length!==2||!integer(config.rule.intervalMs)||config.rule.intervalMs<1000||config.rule.intervalMs>30*86400000)throw Error('Invalid schedule');return structuredClone(config);}
 if(config.rule.kind==='cron'){if(Object.keys(config.rule).some(key=>!['kind','expression','timeZone'].includes(key)))throw Error('Invalid schedule');cron(config.rule.expression);if(config.rule.timeZone!==undefined)checkZone(config.rule.timeZone);return structuredClone(config);}
 throw Error('Invalid schedule');
}
function checkZone(zone:unknown):asserts zone is string{
 if(typeof zone!=='string'||zone.length>128||!/^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)*$/.test(zone))throw Error('Invalid schedule time zone');
 try{new Intl.DateTimeFormat('en-US',{timeZone:zone}).format(0);}catch{throw Error('Invalid schedule time zone');}
}
function nextZoned(expression:string,zone:string,after:number):number{
 const c=cron(expression),start=Temporal.Instant.fromEpochMilliseconds(after).toZonedDateTimeISO(zone).toPlainDate().subtract({days:2}),hours=[...c.hours].sort((a,b)=>a-b),minutes=[...c.minutes].sort((a,b)=>a-b);let best:number|undefined;
 for(let offset=0;offset<366*9+4;offset++){
  const date=start.add({days:offset}),lower=date.toPlainDateTime().toZonedDateTime('UTC').epochMilliseconds-86400000;
  if(best!==undefined&&lower>best)return best;if(lower+3*86400000<=after)continue;
  const dom=c.days.has(date.day),dow=c.weekdays.has(date.dayOfWeek%7),dayMatch=c.dayAny?dow:c.weekdayAny?dom:dom||dow;if(!c.months.has(date.month)||!dayMatch)continue;
  for(const hour of hours)for(const minute of minutes){
   const parts={timeZone:zone,year:date.year,month:date.month,day:date.day,hour,minute};
   const early=Temporal.ZonedDateTime.from(parts,{disambiguation:'earlier'}),late=Temporal.ZonedDateTime.from(parts,{disambiguation:'later'});
   for(const candidate of [early,late]){if(candidate.year!==date.year||candidate.month!==date.month||candidate.day!==date.day||candidate.hour!==hour||candidate.minute!==minute)continue;const instant=candidate.epochMilliseconds;if(instant>after&&Number.isSafeInteger(instant)&&(best===undefined||instant<best))best=instant;}
   if(best!==undefined&&early.epochMilliseconds>best)break;
  }
 }
 if(best!==undefined)return best;throw Error('Cron has no occurrence within nine years');
}
function next(rule:ScheduleRule,after:number):number{
 if(rule.kind==='interval'){const value=after+rule.intervalMs;if(!Number.isSafeInteger(value))throw Error('Invalid schedule time');return value;}
 if(rule.timeZone!==undefined)return nextZoned(rule.expression,rule.timeZone,after);
 const c=cron(rule.expression),start=Math.floor(after/60000)*60000+60000,date=new Date(start);if(!Number.isFinite(date.getTime()))throw Error('Invalid schedule time');
 const midnight=Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate());
 for(let day=0;day<366*9;day++){
  const base=midnight+day*86400000,d=new Date(base);if(!Number.isFinite(d.getTime()))break;
  const dom=c.days.has(d.getUTCDate()),dow=c.weekdays.has(d.getUTCDay()),dayMatch=c.dayAny?dow:c.weekdayAny?dom:dom||dow;
  if(!c.months.has(d.getUTCMonth()+1)||!dayMatch)continue;
  for(const hour of [...c.hours].sort((a,b)=>a-b))for(const minute of [...c.minutes].sort((a,b)=>a-b)){const candidate=base+hour*3600000+minute*60000;if(candidate>=start&&Number.isSafeInteger(candidate))return candidate;}
 }
 throw Error('Cron has no occurrence within nine years');
}
/** SQLite-backed schedules and atomic occurrence enqueue. Host supplies authorization and time. */
export class SqliteAgentSchedules {
 private readonly db:DatabaseSync;
 constructor(path:string){this.db=new DatabaseSync(path);try{this.db.exec(`PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS agent_schedules (tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,schedule_id TEXT NOT NULL,revision INTEGER NOT NULL,generation INTEGER NOT NULL,next_at INTEGER NOT NULL,enabled INTEGER NOT NULL,config TEXT NOT NULL,PRIMARY KEY(tenant_id,agent_id,schedule_id));
  CREATE INDEX IF NOT EXISTS agent_schedules_due ON agent_schedules(tenant_id,agent_id,enabled,next_at,schedule_id);
  CREATE TABLE IF NOT EXISTS agent_schedule_events (id INTEGER PRIMARY KEY AUTOINCREMENT,tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,schedule_id TEXT NOT NULL,kind TEXT NOT NULL,revision INTEGER NOT NULL,generation INTEGER NOT NULL,next_at INTEGER NOT NULL,config TEXT NOT NULL,actor_id TEXT,run_id TEXT,scheduled_at INTEGER,observed_at INTEGER NOT NULL,UNIQUE(tenant_id,agent_id,schedule_id,revision));
  CREATE TRIGGER IF NOT EXISTS agent_schedule_events_no_replace BEFORE INSERT ON agent_schedule_events WHEN (NEW.id>0 AND EXISTS(SELECT 1 FROM agent_schedule_events WHERE id=NEW.id)) OR EXISTS(SELECT 1 FROM agent_schedule_events WHERE tenant_id=NEW.tenant_id AND agent_id=NEW.agent_id AND schedule_id=NEW.schedule_id AND revision=NEW.revision) BEGIN SELECT RAISE(ABORT,'Schedule history is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS agent_schedule_events_no_update BEFORE UPDATE ON agent_schedule_events BEGIN SELECT RAISE(ABORT,'Schedule history is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS agent_schedule_events_no_delete BEFORE DELETE ON agent_schedule_events BEGIN SELECT RAISE(ABORT,'Schedule history is immutable'); END;`);
  for(const table of ['agent_runs','agent_trigger_inbox'])if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))throw Error('Trigger registry unavailable');
 }catch(error){this.db.close();throw error;}}
 close():void{this.db.close();}
 private check(scope:AgentRunScope,scheduleId:string):void{if(!scope||!id(scope.tenantId)||!id(scope.agentId)||!id(scheduleId))throw Error('Invalid schedule scope');}
 private parse(row:Record<string,unknown>):AgentSchedule{return {tenantId:String(row.tenant_id),agentId:String(row.agent_id),scheduleId:String(row.schedule_id),revision:Number(row.revision),generation:Number(row.generation),nextAt:Number(row.next_at),config:checkConfig(JSON.parse(String(row.config)))};}
 get(scope:AgentRunScope,scheduleId:string):AgentSchedule|undefined{this.check(scope,scheduleId);const row=this.db.prepare('SELECT * FROM agent_schedules WHERE tenant_id=? AND agent_id=? AND schedule_id=?').get(scope.tenantId,scope.agentId,scheduleId);return row?this.parse(row):undefined;}
 due(scope:AgentRunScope,now:number,limit=100):AgentSchedule[]{
  this.check(scope,'validation');if(!integer(now)||!integer(limit)||limit<1||limit>100)throw Error('Invalid schedule query');
  const rows=this.db.prepare('SELECT * FROM agent_schedules WHERE tenant_id=? AND agent_id=? AND enabled=1 AND next_at<=? ORDER BY next_at,schedule_id LIMIT ?').all(scope.tenantId,scope.agentId,now,limit);return rows.map(row=>this.parse(row));
 }
 /** Bounded keyset scan; callers must restart a scan to revisit changed schedules. */
 duePage(scope:AgentRunScope,now:number,limit=100,after?:AgentScheduleCursor):AgentSchedulePage{
  this.check(scope,'validation');if(!integer(now)||!integer(limit)||limit<1||limit>100||(after!==undefined&&(!after||!integer(after.nextAt)||!id(after.scheduleId))))throw Error('Invalid schedule query');
  const rows=after===undefined?this.db.prepare('SELECT * FROM agent_schedules WHERE tenant_id=? AND agent_id=? AND enabled=1 AND next_at<=? ORDER BY next_at,schedule_id LIMIT ?').all(scope.tenantId,scope.agentId,now,limit+1):this.db.prepare('SELECT * FROM agent_schedules WHERE tenant_id=? AND agent_id=? AND enabled=1 AND next_at<=? AND (next_at>? OR (next_at=? AND schedule_id>?)) ORDER BY next_at,schedule_id LIMIT ?').all(scope.tenantId,scope.agentId,now,after.nextAt,after.nextAt,after.scheduleId,limit+1);
  const items=rows.slice(0,limit).map(row=>this.parse(row)),last=items.at(-1);return {items,...(rows.length>limit&&last?{next:{nextAt:last.nextAt,scheduleId:last.scheduleId}}:{})};
 }
 save(scope:AgentRunScope,scheduleId:string,config:ScheduleConfig,expectedRevision:number,now=Date.now(),actorId?:string):AgentSchedule{
  this.check(scope,scheduleId);if(!integer(expectedRevision)||expectedRevision>=Number.MAX_SAFE_INTEGER||!integer(now)||(actorId!==undefined&&!id(actorId)))throw Error('Invalid schedule');const safe=checkConfig(config),nextAt=next(safe.rule,now);
  this.db.exec('BEGIN IMMEDIATE');try{const old=this.get(scope,scheduleId);if((old?.revision??0)!==expectedRevision)throw Error('Schedule revision conflict');const revision=expectedRevision+1,generation=(old?.generation??0)+1;if(!Number.isSafeInteger(generation))throw Error('Invalid schedule');
   this.db.prepare('INSERT INTO agent_schedules VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,agent_id,schedule_id) DO UPDATE SET revision=excluded.revision,generation=excluded.generation,next_at=excluded.next_at,enabled=excluded.enabled,config=excluded.config').run(scope.tenantId,scope.agentId,scheduleId,revision,generation,nextAt,safe.enabled?1:0,JSON.stringify(safe));this.db.prepare('INSERT INTO agent_schedule_events (tenant_id,agent_id,schedule_id,kind,revision,generation,next_at,config,actor_id,run_id,scheduled_at,observed_at) VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL,?)').run(scope.tenantId,scope.agentId,scheduleId,old?'updated':'created',revision,generation,nextAt,JSON.stringify(safe),actorId??null,now);this.db.exec('COMMIT');return this.get(scope,scheduleId)!;
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 getOccurrence(scope:AgentRunScope,scheduleId:string,generation:number,scheduledAt:number):string|undefined {
  this.check(scope,scheduleId);if(!integer(generation)||generation<1||!integer(scheduledAt))throw Error('Invalid schedule occurrence');
  const sourceId='schedule.'+createHash('sha256').update(scheduleId).digest('hex'),eventId=`g${generation}:t${scheduledAt}`;
  const row=this.db.prepare('SELECT run_id FROM agent_trigger_inbox WHERE tenant_id=? AND agent_id=? AND source_id=? AND event_id=?').get(scope.tenantId,scope.agentId,sourceId,eventId);return row?String(row.run_id):undefined;
 }
 fire(scope:AgentRunScope,scheduleId:string,expectedRevision:number,policy:FireOptions,now=Date.now(),actorId?:string):{runId:string;scheduledAt:number}{
  this.check(scope,scheduleId);if(!integer(expectedRevision)||expectedRevision<1||expectedRevision>=Number.MAX_SAFE_INTEGER||!integer(now)||(actorId!==undefined&&!id(actorId))||!policy||!integer(policy.definitionVersion)||policy.definitionVersion<1||!integer(policy.maxAttempts)||policy.maxAttempts<1||policy.maxAttempts>100||!integer(policy.runTimeoutMs)||policy.runTimeoutMs<1000||policy.runTimeoutMs>86400000||!integer(policy.maxPending)||policy.maxPending<1||policy.maxPending>10000||!Number.isSafeInteger(now+policy.runTimeoutMs))throw Error('Invalid schedule fire');
  this.db.exec('BEGIN IMMEDIATE');try{
   const schedule=this.get(scope,scheduleId);if(!schedule||schedule.revision!==expectedRevision)throw Error('Schedule revision conflict');if(!schedule.config.enabled||schedule.nextAt>now)throw Error('Schedule not due');
   const count=this.db.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE tenant_id=? AND agent_id=? AND status IN ('queued','running','pause_requested','cancel_requested','paused','uncertain')").get(scope.tenantId,scope.agentId);if(Number(count?.n)>=policy.maxPending)throw Error('Trigger backlog full');
   const scheduledAt=schedule.nextAt,coalesce=schedule.config.misfire==='coalesce',rule=schedule.config.rule;let nextAt=coalesce&&rule.kind==='interval'?now+(rule.intervalMs-((now-scheduledAt)%rule.intervalMs)):next(rule,coalesce?now:scheduledAt);if(!Number.isSafeInteger(nextAt))throw Error('Invalid schedule time');const runId=randomUUID(),sourceId='schedule.'+createHash('sha256').update(scheduleId).digest('hex'),eventId=`g${schedule.generation}:t${scheduledAt}`,payload=JSON.stringify({scheduleId,scheduledAt,...(coalesce?{coalescedThrough:now}:{})}),hash=createHash('sha256').update(payload).digest('hex');
   this.db.prepare("INSERT INTO agent_runs VALUES (?,?,?,?,1,'queued',0,?,?,NULL,NULL,NULL,0)").run(scope.tenantId,scope.agentId,runId,policy.definitionVersion,policy.maxAttempts,now+policy.runTimeoutMs);
   this.db.prepare('INSERT INTO agent_trigger_inbox VALUES (?,?,?,?,?,?,?,?,?)').run(scope.tenantId,scope.agentId,sourceId,eventId,schedule.config.principalId,'schedule.tick',payload,hash,runId);
   this.db.prepare('UPDATE agent_schedules SET revision=?,next_at=? WHERE tenant_id=? AND agent_id=? AND schedule_id=?').run(schedule.revision+1,nextAt,scope.tenantId,scope.agentId,scheduleId);
   this.db.prepare("INSERT INTO agent_schedule_events (tenant_id,agent_id,schedule_id,kind,revision,generation,next_at,config,actor_id,run_id,scheduled_at,observed_at) VALUES (?,?,?,'fired',?,?,?,?,?,?,?,?)").run(scope.tenantId,scope.agentId,scheduleId,schedule.revision+1,schedule.generation,nextAt,JSON.stringify(schedule.config),actorId??null,runId,scheduledAt,now);
   this.db.exec('COMMIT');return {runId,scheduledAt};
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
}
export type {ScheduleRule as AgentScheduleRule,ScheduleConfig as AgentScheduleConfig,FireOptions as AgentScheduleFireOptions};
