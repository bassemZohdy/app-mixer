import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once,EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {AgentWorkerHost,SqliteAgentRuns,SqliteAgentTriggers,SqliteAgentSchedules} from '../dist/index.js';

const fake=(log,name,{startError,stop}={})=>({start(){if(startError)throw startError;log.push('start '+name);},async stop(){log.push('stop '+name);if(stop)await stop();}});

test('worker host validates its configuration',()=>{
 const worker=fake([],'a');
 for(const bad of [undefined,{},{workers:{},stopTimeoutMs:1000},{workers:{a:worker},stopTimeoutMs:50},{workers:{a:worker},stopTimeoutMs:1.5},{workers:{'Bad Name':worker},stopTimeoutMs:1000},{workers:{a:{start(){}}},stopTimeoutMs:1000},{workers:{a:worker,b:worker},stopTimeoutMs:1000},{workers:[worker],stopTimeoutMs:1000},{workers:{a:worker},stopTimeoutMs:1000,onError:1}])assert.throws(()=>new AgentWorkerHost(bad),/Invalid worker host/);
 const host=new AgentWorkerHost({workers:{a:worker},stopTimeoutMs:1000});
 for(const [source,signals] of [[{},undefined],[new EventEmitter(),[]],[new EventEmitter(),['TERM']]])assert.throws(()=>host.handleSignals(source,()=>{},signals),/Invalid worker host signals/);
});

test('worker host starts in order, reports readiness and stops every worker once',async()=>{
 const log=[],host=new AgentWorkerHost({workers:{schedules:fake(log,'schedules'),recovery:fake(log,'recovery')},stopTimeoutMs:1000});
 assert.equal(host.state(),'idle');assert.equal(host.ready(),false);
 await host.start();assert.deepEqual(log,['start schedules','start recovery']);assert.equal(host.ready(),true);await assert.rejects(host.start(),/already started/);
 const first=host.stop(),second=host.stop();assert.equal(first,second);assert.equal(host.state(),'stopping');assert.equal(host.ready(),false);
 assert.deepEqual(await first,{stopped:['schedules','recovery'],timedOut:[],failed:[]});assert.equal(host.state(),'stopped');assert.deepEqual(log.filter(x=>x.startsWith('stop')),['stop schedules','stop recovery']);
 const idle=new AgentWorkerHost({workers:{a:fake([],'a')},stopTimeoutMs:1000});assert.deepEqual(await idle.stop(),{stopped:[],timedOut:[],failed:[]});await assert.rejects(idle.start(),/already started/);
});

test('a worker that fails to start stops those already started',async()=>{
 const log=[],host=new AgentWorkerHost({workers:{a:fake(log,'a'),b:fake(log,'b',{startError:Error('bad config')}),c:fake(log,'c')},stopTimeoutMs:1000});
 await assert.rejects(host.start(),/bad config/);assert.deepEqual(log,['start a','stop a']);assert.equal(host.state(),'stopped');
});

test('a slow or failing stop is bounded and reported without blocking the others',async()=>{
 const log=[],errors=[],host=new AgentWorkerHost({workers:{slow:fake(log,'slow',{stop:()=>new Promise(()=>{})}),broken:fake(log,'broken',{stop:async()=>{throw Error('stop failed');}}),fine:fake(log,'fine')},stopTimeoutMs:100,onError:(name,error)=>{errors.push(name+': '+error.message);throw Error('ignored');}});
 await host.start();const started=Date.now(),result=await host.stop();
 assert.deepEqual(result,{stopped:['fine'],timedOut:['slow'],failed:['broken']});assert.ok(Date.now()-started<2000);assert.deepEqual(errors.sort(),['broken: stop failed','slow: Worker stop timed out']);assert.equal(host.state(),'stopped');
});

test('signal handling stops once on the first signal and can be removed',async()=>{
 const source=new EventEmitter(),log=[],results=[],host=new AgentWorkerHost({workers:{a:fake(log,'a')},stopTimeoutMs:1000});await host.start();
 host.handleSignals(source,result=>results.push(result));assert.equal(source.listenerCount('SIGTERM'),1);assert.equal(source.listenerCount('SIGINT'),1);
 source.emit('SIGINT');source.emit('SIGTERM');await new Promise(resolve=>setTimeout(resolve,20));
 assert.deepEqual(results,[{stopped:['a'],timedOut:[],failed:[]}]);assert.equal(source.listenerCount('SIGTERM'),0);assert.equal(source.listenerCount('SIGINT'),0);
 const other=new AgentWorkerHost({workers:{b:fake([],'b')},stopTimeoutMs:1000}),remove=other.handleSignals(source,()=>results.push('unexpected'),['SIGHUP']);remove();source.emit('SIGHUP');await new Promise(resolve=>setTimeout(resolve,20));assert.equal(results.length,1);
});

const fixture=fileURLToPath(new URL('./fixtures/worker-host-process.mjs',import.meta.url));
async function drain(trigger){
 const dir=mkdtempSync(join(tmpdir(),'agent-worker-host-')),path=join(dir,'runs.sqlite');let child;
 try{
  const runs=new SqliteAgentRuns(path),triggers=new SqliteAgentTriggers(path),schedules=new SqliteAgentSchedules(path);schedules.save({tenantId:'tenant',agentId:'agent'},'tick',{enabled:true,principalId:'scheduler',rule:{kind:'interval',intervalMs:1000}},0,1000);schedules.close();triggers.close();runs.close();
  child=fork(fixture,[path],{stdio:['ignore','ignore','inherit','ipc']});const messages=[],waiters=[];child.on('message',message=>{messages.push(message);waiters.splice(0).forEach(resolve=>resolve());});
  const next=async type=>{for(;;){const index=messages.findIndex(message=>message.type===type);if(index>=0)return messages.splice(index,1)[0];await new Promise(resolve=>waiters.push(resolve));}};
  assert.equal((await next('ready')).ready,true);await next('in-pass');
  trigger(child);await new Promise(resolve=>setTimeout(resolve,100));assert.equal(messages.some(message=>message.type==='stopped'),false,'stop must wait for the in-flight pass');
  child.send('release');const stopped=await next('stopped'),[code]=await once(child,'exit');
  assert.deepEqual(stopped.result,{stopped:['schedules'],timedOut:[],failed:[]});assert.equal(stopped.state,'stopped');assert.equal(code,0);
  // A pass interrupted by stop does not fire after the request, and the occurrence stays due for the next worker instead of being lost.
  const check=new SqliteAgentRuns(path),after=new SqliteAgentSchedules(path);try{assert.equal(check.list({tenantId:'tenant',agentId:'agent'}).length,0);const schedule=after.get({tenantId:'tenant',agentId:'agent'},'tick');assert.equal(schedule.nextAt,2000);assert.equal(schedule.revision,1);assert.equal(after.due({tenantId:'tenant',agentId:'agent'},2000).length,1);}finally{after.close();check.close();}
 }finally{if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit');}rmSync(dir,{recursive:true,force:true});}
}

test('a worker process drains an in-flight schedule pass on shutdown before exiting',{timeout:30000},()=>drain(child=>child.send('emit-sigterm')));
test('a worker process drains on a real SIGTERM',{timeout:30000,skip:process.platform==='win32'?'Windows cannot deliver SIGTERM to a Node.js handler':false},()=>drain(child=>child.kill('SIGTERM')));
