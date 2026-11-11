import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {SqliteAgentMemory,SqliteAgentRuns,SqliteAgentRunMetrics} from '../dist/index.js';

const scope={tenantId:'tenant',agentId:'agent'},other={tenantId:'other',agentId:'agent'},actor={tenantId:'tenant',principalId:'auditor'};
function setup(){
 const dir=mkdtempSync(join(tmpdir(),'agent-memory-metrics-')),path=join(dir,'runs.sqlite'),runs=new SqliteAgentRuns(path),memory=new SqliteAgentMemory(path,{enabled:true,maxEntries:10,maxTtlMs:1000,authorize:()=>true});
 return {path,close:()=>{memory.close?.();runs.close?.();}};
}
function insert(path,who,owner,id,expiresAt,deleted=0){
 const db=new DatabaseSync(path);try{db.prepare('INSERT INTO agent_memories VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(who.tenantId,who.agentId,'user',owner,'fact',id,1,deleted?null:'"v"',deleted?null:'{}',expiresAt,deleted);}finally{db.close();}
}

test('memory metrics count live, expired and deleted memories across owners and ignore other scopes',async()=>{
 const s=setup();let metrics;try{
  insert(s.path,scope,'u1','a',9000);insert(s.path,scope,'u2','b',9000);insert(s.path,scope,'u1','c',5000);insert(s.path,scope,'u2','d',1000);insert(s.path,scope,'u1','e',0,1);insert(s.path,other,'u1','f',1000);
  metrics=new SqliteAgentRunMetrics(s.path,{scope,authorize:()=>true,includeMemories:true,clock:()=>5000});
  assert.deepEqual(await metrics.memories(actor),[{state:'live',count:2},{state:'expired',count:2},{state:'deleted',count:1}]);
  const text=await metrics.render(actor);assert.match(text,/^app_mixer_agent_memories\{state="expired"\} 2$/m);assert.doesNotMatch(text,/u1|u2|fact/);
  const later=new SqliteAgentRunMetrics(s.path,{scope,authorize:()=>true,includeMemories:true,clock:()=>9000});try{assert.deepEqual(await later.memories(actor),[{state:'live',count:0},{state:'expired',count:4},{state:'deleted',count:1}]);}finally{later.close();}
  insert(s.path,scope,'u3','g',9000,2);await assert.rejects(metrics.memories(actor),/Invalid agent metrics data/);
 }finally{metrics?.close();s.close();}
});

test('memory metrics are opt-in, authorized, need a valid clock and the memory table',async()=>{
 const s=setup();let denied,badClock;try{
  const plain=new SqliteAgentRunMetrics(s.path,{scope,authorize:()=>true});try{await assert.rejects(plain.memories(actor),/not enabled/);assert.doesNotMatch(await plain.render(actor),/app_mixer_agent_memories/);}finally{plain.close();}
  assert.throws(()=>new SqliteAgentRunMetrics(s.path,{scope,authorize:()=>true,includeMemories:'yes'}),/Invalid agent metrics configuration/);
  denied=new SqliteAgentRunMetrics(s.path,{scope,authorize:()=>false,includeMemories:true});await assert.rejects(denied.memories(actor),/denied/);
  badClock=new SqliteAgentRunMetrics(s.path,{scope,authorize:()=>true,includeMemories:true,clock:()=>-1});await assert.rejects(badClock.memories(actor),/Invalid agent metrics clock/);
 }finally{denied?.close();badClock?.close();s.close();}
 const dir=mkdtempSync(join(tmpdir(),'agent-memory-metrics-')),path=join(dir,'runs.sqlite'),runs=new SqliteAgentRuns(path);
 try{assert.throws(()=>new SqliteAgentRunMetrics(path,{scope,authorize:()=>true,includeMemories:true}),/unavailable/);}finally{runs.close?.();}
});
