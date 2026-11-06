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
