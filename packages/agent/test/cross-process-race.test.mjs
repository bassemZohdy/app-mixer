import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SqliteAgentRuns,SqliteAgentTriggers,SqliteAgentSchedules} from '../dist/index.js';

const scope={tenantId:'tenant',agentId:'agent'},fixture=name=>fileURLToPath(new URL(`./fixtures/${name}`,import.meta.url));
const spawn=(file,args)=>{const child=fork(fixture(file),args,{stdio:['ignore','ignore','ignore','ipc']});child.messages=[];child.waiters=[];child.on('message',message=>{child.messages.push(message);child.waiters.splice(0).forEach(resolve=>resolve());});return child;};
const next=async(child,type)=>{for(;;){const found=child.messages.find(message=>message.type===type||message.type==='rejected'||message.type==='reserved'||message.type==='dispatching');if(found)return child.messages.shift();await new Promise(resolve=>child.waiters.push(resolve));}};
const ready=async child=>{for(;;){const index=child.messages.findIndex(message=>message.type==='ready');if(index>=0){child.messages.splice(index,1);return;}await new Promise(resolve=>child.waiters.push(resolve));}};
const stop=async children=>{for(const child of children){if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}}};
function claimed(path){const runs=new SqliteAgentRuns(path);runs.create(scope,'run',{definitionVersion:1,maxAttempts:3,deadline:100000},0);const run=runs.claim(scope,'run',runs.get(scope,'run').revision,'racer',60000,10);runs.close();return run.leaseToken;}

test('two processes racing to reserve more tokens than the run budget allows get exactly one reservation',{timeout:30000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'agent-budget-race-')),path=join(dir,'runs.sqlite'),children=[];
 try{
  const token=claimed(path);children.push(spawn('race-budget-worker.mjs',[path,token,'call-a']),spawn('race-budget-worker.mjs',[path,token,'call-b']));
  await Promise.all(children.map(ready));children.forEach(child=>child.send('go'));
  const results=await Promise.all(children.map(child=>next(child,'reserved')));
  // 60 + 60 exceeds the 100-token budget: exactly one process may hold a reservation.
  assert.equal(results.filter(result=>result.type==='reserved').length,1,JSON.stringify(results));assert.equal(results.filter(result=>result.type==='rejected').length,1);assert.match(results.find(result=>result.type==='rejected').message,/Token budget exhausted/);
 }finally{await stop(children);rmSync(dir,{recursive:true,force:true});}
});

test('two processes dispatching the same journaled action never both run the effect',{timeout:30000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'agent-journal-race-')),path=join(dir,'runs.sqlite'),children=[];
 try{
  const token=claimed(path);children.push(spawn('race-journal-worker.mjs',[path,token]),spawn('race-journal-worker.mjs',[path,token]));
  await Promise.all(children.map(ready));children.forEach(child=>child.send('go'));
  const results=await Promise.all(children.map(child=>next(child,'dispatching')));
  // The first claimant is stuck inside its effect; the other must be refused rather than dispatching a second time.
  assert.equal(results.filter(result=>result.type==='dispatching').length,1,JSON.stringify(results));assert.equal(results.filter(result=>result.type==='rejected').length,1);assert.match(results.find(result=>result.type==='rejected').message,/requires reconciliation/);
 }finally{await stop(children);rmSync(dir,{recursive:true,force:true});}
});

test('two schedule workers sharing a store fire each due occurrence exactly once',{timeout:30000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'agent-schedule-race-')),path=join(dir,'runs.sqlite'),children=[],ids=['a','b','c','d','e'];
 try{
  const runs=new SqliteAgentRuns(path),triggers=new SqliteAgentTriggers(path),schedules=new SqliteAgentSchedules(path);
  for(const id of ids)schedules.save(scope,id,{enabled:true,principalId:'scheduler',rule:{kind:'interval',intervalMs:1000}},0,1000);
  schedules.close();triggers.close();runs.close();
  children.push(spawn('race-schedule-worker.mjs',[path]),spawn('race-schedule-worker.mjs',[path]));
  await Promise.all(children.map(ready));children.forEach(child=>child.send('go'));
  const results=await Promise.all(children.map(async child=>{for(;;){const index=child.messages.findIndex(message=>message.type==='done');if(index>=0)return child.messages.splice(index,1)[0];await new Promise(resolve=>child.waiters.push(resolve));}}));
  // Both workers see every schedule due at 2000; between them each occurrence becomes exactly one run, and the loser is not reported as an error.
  assert.deepEqual(results.flatMap(result=>result.errors),[],JSON.stringify(results));assert.equal(results.reduce((sum,result)=>sum+result.fired,0),ids.length,JSON.stringify(results));
  const check=new SqliteAgentRuns(path),after=new SqliteAgentSchedules(path);
  try{assert.equal(check.list(scope).length,ids.length);for(const id of ids){const schedule=after.get(scope,id);assert.equal(schedule.nextAt,3000);assert.equal(schedule.revision,2);assert.ok(after.getOccurrence(scope,id,schedule.generation,2000));}}finally{after.close();check.close();}
 }finally{await stop(children);rmSync(dir,{recursive:true,force:true});}
});
