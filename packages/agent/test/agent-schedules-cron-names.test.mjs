import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteAgentRuns,SqliteAgentTriggers,SqliteAgentSchedules} from '../dist/index.js';

const scope={tenantId:'tenant',agentId:'agent'},base={enabled:true,principalId:'scheduler'};
// 2026-10-29 is a Thursday and 2026-11-01 is a Sunday.
const now=Date.parse('2026-10-29T07:15:30Z'),at=text=>Date.parse(text);

test('cron accepts 7 as Sunday and three-letter month and weekday names',()=>{
 const dir=mkdtempSync(join(tmpdir(),'app-mixer-cron-names-')),path=join(dir,'db.sqlite'),runs=new SqliteAgentRuns(path),triggers=new SqliteAgentTriggers(path),schedules=new SqliteAgentSchedules(path);
 let n=0;const next=(expression,timeZone)=>schedules.save(scope,'s'+n++,{...base,rule:{kind:'cron',expression,...(timeZone?{timeZone}:{})}},0,now).nextAt;
 try{
  const sunday=at('2026-11-01T00:00:00Z');
  for(const expression of ['0 0 * * 0','0 0 * * 7','0 0 * * SUN','0 0 * * sun','0 0 * * Sun'])assert.equal(next(expression),sunday,expression);
  assert.equal(next('0 0 * * 5-7'),at('2026-10-30T00:00:00Z'));        // Friday, Saturday, Sunday
  assert.equal(next('0 0 * * MON-FRI'),at('2026-10-30T00:00:00Z'));
  assert.equal(next('0 0 * * 1-5'),next('0 0 * * mon-fri'));
  assert.equal(next('0 0 * * SAT,SUN'),at('2026-10-31T00:00:00Z'));
  assert.equal(next('0 0 1 JAN *'),at('2027-01-01T00:00:00Z'));
  assert.equal(next('0 0 1 feb-mar *'),at('2027-02-01T00:00:00Z'));
  assert.equal(next('0 0 1 1 *'),next('0 0 1 JAN *'));
  assert.equal(next('0 0 * * 7','America/New_York'),at('2026-11-01T04:00:00Z')); // local midnight Sunday, before the clocks change
  assert.equal(next('0 0 1 JAN *','America/New_York'),at('2027-01-01T05:00:00Z'));
  // Existing semantics are unchanged: `*` and steps on `*` still cover Sunday through Saturday only.
  assert.equal(next('0 0 * * */2'),at('2026-10-31T00:00:00Z'));          // 0,2,4,6 -> Saturday is next after Thursday
  for(const expression of ['0 0 * * 8','0 0 * * 7-8','0 0 * * SUNDAY','0 0 * * FOO','0 0 * * SU','0 0 1 JANUARY *','0 0 1 FOO *','0 0 1 0 *','0 0 * * 3-1','0 0 * * SUN-','0 0 * * -SUN'])assert.throws(()=>next(expression),/Invalid/,expression);
 }finally{schedules.close();triggers.close();runs.close();rmSync(dir,{recursive:true,force:true});}
});

test('a cron time that does not exist on a daylight-saving day is skipped and one that happens twice fires twice',()=>{
 // This pins the current behaviour so a change to it is deliberate; docs/agent-schedules.md describes it.
 const dir=mkdtempSync(join(tmpdir(),'app-mixer-cron-dst-')),path=join(dir,'db.sqlite'),runs=new SqliteAgentRuns(path),triggers=new SqliteAgentTriggers(path),schedules=new SqliteAgentSchedules(path);
 try{
  let n=0;const after=(expression,timeZone,instant)=>schedules.save(scope,'dst'+n++,{...base,rule:{kind:'cron',expression,timeZone}},0,instant).nextAt;
  const walk=(expression,timeZone,start,count)=>{const out=[];let instant=at(start);for(let i=0;i<count;i++){instant=after(expression,timeZone,instant);out.push(new Date(instant).toISOString());}return out;};
  // America/New_York springs forward on 2026-03-08: 02:30 local does not exist that day.
  assert.deepEqual(walk('30 2 * * *','America/New_York','2026-03-06T12:00:00Z',3),['2026-03-07T07:30:00.000Z','2026-03-09T06:30:00.000Z','2026-03-10T06:30:00.000Z'],'the occurrence on 8 March is skipped');
  // It falls back on 2026-11-01: 01:30 local happens twice, once in EDT and once in EST.
  assert.deepEqual(walk('30 1 * * *','America/New_York','2026-10-30T12:00:00Z',4),['2026-10-31T05:30:00.000Z','2026-11-01T05:30:00.000Z','2026-11-01T06:30:00.000Z','2026-11-02T06:30:00.000Z'],'1 November has two occurrences');
  // A time outside the 01:00 to 03:00 window, or a UTC schedule, has exactly one occurrence a day throughout.
  assert.deepEqual(walk('30 4 * * *','America/New_York','2026-03-06T12:00:00Z',4).map(value=>value.slice(0,10)),['2026-03-07','2026-03-08','2026-03-09','2026-03-10']);
  assert.deepEqual(walk('30 1 * * *','UTC','2026-10-30T12:00:00Z',4).map(value=>value.slice(0,10)),['2026-10-31','2026-11-01','2026-11-02','2026-11-03']);
 }finally{triggers.close?.();schedules.close?.();runs.close?.();rmSync(dir,{recursive:true,force:true});}
});
