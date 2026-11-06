import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteAgentRuns,SqliteAgentTriggers,SqliteAgentSchedules} from '../dist/index.js';

const scope={tenantId:'tenant',agentId:'agent'},schedule={enabled:true,principalId:'scheduler',rule:{kind:'interval',intervalMs:1000}},run={definitionVersion:1,maxAttempts:3,deadline:1000};

test('run and schedule configuration must be own plain data, not inherited fields',()=>{
 const dir=mkdtempSync(join(tmpdir(),'agent-inherited-')),path=join(dir,'db.sqlite'),runs=new SqliteAgentRuns(path),triggers=new SqliteAgentTriggers(path),schedules=new SqliteAgentSchedules(path);
 try{
  class Config{constructor(){Object.assign(this,run);}}
  for(const bad of [Object.create(run),new Config()])assert.throws(()=>runs.create(scope,'bad',bad,0),/Invalid/);
  assert.equal(runs.list(scope).length,0);
  assert.equal(runs.create(scope,'ok',run,0).status,'queued');assert.equal(runs.create(scope,'null-proto',Object.assign(Object.create(null),run),0).status,'queued');
  // Schedules fail with the controlled error, never a raw TypeError, and persist nothing.
  for(const bad of [Object.create(schedule),{...schedule,rule:Object.create(schedule.rule)},Object.assign(Object.create({extra:1}),schedule)])assert.throws(()=>schedules.save(scope,'bad',bad,0,1000),error=>error instanceof Error&&!(error instanceof TypeError)&&/Invalid schedule/.test(error.message));
  assert.equal(schedules.get(scope,'bad'),undefined);
  assert.equal(schedules.save(scope,'ok',schedule,0,1000).nextAt,2000);
 }finally{schedules.close();triggers.close();runs.close();rmSync(dir,{recursive:true,force:true});}
});
