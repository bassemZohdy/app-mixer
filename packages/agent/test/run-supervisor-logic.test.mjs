import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {PostgresRunSupervisor} from '../dist/index.js';
import {AgentError} from '../dist/errors.js';

const scope={tenantId:'tenant',agentId:'agent'};
/** An in-memory stand-in for PostgresAgentRuns that implements only what the supervisor calls. */
function fakeRuns(options={}){
 const state={queued:[...(options.queued??[])],uncertain:[...(options.uncertain??[])],claims:[],settles:[],settleFailures:options.settleFailures??0,reconciles:[],verified:[],lease:undefined,statusNow:'running'};
 const lease=(runId,revision=1)=>({runId,revision,status:'running',leaseToken:'token-'+runId,attempts:1,maxAttempts:3,deadline:Date.now()+600000});
 const runs={
  state,
  expiredLeases:async()=>[],recoverExpired:async()=>{},
  queued:async()=>state.queued.map(id=>({runId:id,revision:1,status:'queued'})),
  uncertain:async(_scope,limit=50,after)=>state.uncertain.filter(id=>after===undefined||id>after).sort().slice(0,limit).map(id=>({runId:id,revision:1,status:'uncertain'})),
  claim:async(_scope,runId,_revision,worker,_leaseMs,limits)=>{
   state.claims.push({runId,limits});if(options.claimError)throw options.claimError;
   state.queued=state.queued.filter(id=>id!==runId);state.lease=lease(runId);return state.lease;
  },
  renew:async(_scope,runId)=>lease(runId),
  get:async(_scope,runId)=>{if(state.uncertain.includes(runId))return {runId,revision:1,status:'uncertain'};return state.lease&&state.lease.runId===runId?{...state.lease,status:state.statusNow,revision:state.settles.length+state.settleFailures+1}:undefined;},
  settle:async(_scope,runId,revision,_token,status)=>{
   if(state.settleFailures>0){state.settleFailures--;state.statusNow='cancel_requested';throw new AgentError('lost_race','Run changed');}
   state.settles.push({runId,revision,status});return {runId,status};
  },
  reconcile:async(_scope,runId,_revision,mode)=>{state.reconciles.push({runId,mode});if(options.reconcileError)throw options.reconcileError;state.uncertain=state.uncertain.filter(id=>id!==runId);},
  journal:()=>({unresolved:async()=>options.unresolved??[],markUncertain:async()=>{},reconcileWith:async(actionId,verify)=>{state.verified.push(actionId);return (await verify({action:{actionId}})).outcome;}})
 };
 return runs;
}
const supervisor=(runs,extra={})=>{
 const events=[],errors=[];
 const s=new PostgresRunSupervisor({runs,scope,workerId:'worker',leaseMs:1000,pollMs:10,recoveryGraceMs:0,execute:async()=>'succeeded',verify:async()=>({outcome:'unknown'}),onError:error=>errors.push(error.message),onEvent:event=>events.push(event),...extra});
 return {s,events,errors};
};

test('a supervisor that was stopped claims queued runs again after it is started',async()=>{
 const runs=fakeRuns({queued:['run-1']}),{s,events}=supervisor(runs);
 await s.runOnce();await s.stop();
 runs.state.queued=['run-2'];
 s.start();for(let i=0;i<100&&!events.some(event=>event.type==='claimed'&&event.runId==='run-2');i++)await delay(20);
 await s.stop();
 assert.ok(events.some(event=>event.type==='claimed'&&event.runId==='run-2'),'run-2 was claimed after the restart');
});

test('a settle that loses a race to a pause or cancel request is retried instead of leaving the run leased',async()=>{
 const runs=fakeRuns({queued:['run-1'],settleFailures:1}),{s,events,errors}=supervisor(runs);
 await s.runOnce();await s.stop();
 assert.deepEqual(runs.state.settles.map(item=>[item.runId,item.status]),[['run-1','succeeded']],'the run was settled on the second attempt');
 assert.ok(events.some(event=>event.type==='settled'),'a settled event was emitted');assert.deepEqual(errors,[]);
});

test('a run that stays uncertain only because of an open reservation is reported for review, not as an error on every pass',async()=>{
 const runs=fakeRuns({uncertain:['run-1'],reconcileError:new Error('Action requires reconciliation')}),{s,events,errors}=supervisor(runs);
 await s.runOnce();await s.runOnce();await s.stop();
 assert.deepEqual(errors,[],'it is not an error');
 assert.equal(events.filter(event=>event.type==='review'&&event.runId==='run-1').length,1,'one review event, not one per pass (a cooldown applies)');
 assert.equal(runs.state.reconciles.length,1,'the second pass did not try again straight away');
});

test('uncertain runs beyond the first page are reached, and a run waiting for review is not verified on every pass',async()=>{
 const ids=Array.from({length:120},(_,i)=>'run-'+String(i).padStart(3,'0')),stuck=new Set(ids.slice(0,60)),verifiedRuns=[];
 const runs=fakeRuns({uncertain:ids,unresolved:[{actionId:'a',status:'uncertain'}]}),{s}=supervisor(runs,{verify:async()=>({outcome:'unknown'})});
 // Every run has an unresolved action whose verification is unknown, so each is "waiting for review"; with 120 of them the 50-run first page cannot cover them all.
 const original=runs.journal;runs.journal=(scopeArg,runId,token)=>{const journal=original(scopeArg,runId,token);return {...journal,reconcileWith:async(actionId,verify)=>{verifiedRuns.push(runId);return (await verify({action:{actionId}})).outcome;}};};
 await s.runOnce();await s.stop();
 assert.equal(new Set(verifiedRuns).size,120,'all 120 uncertain runs were examined in one pass');
 const before=verifiedRuns.length;await s.runOnce();await s.stop();
 assert.equal(verifiedRuns.length,before,'runs under review are left alone during the cooldown instead of being verified again');
 void stuck;
});

test('a claim refused by the agent concurrency limit is reported once and stops the pass',async()=>{
 const runs=fakeRuns({queued:['run-1','run-2','run-3'],claimError:new AgentError('lost_race','Agent concurrency limit')}),{s,events,errors}=supervisor(runs,{maxConcurrent:3});
 await s.runOnce();await s.stop();
 assert.deepEqual(events.filter(event=>event.type==='limited').map(event=>event.runId),['run-1'],'one limited event for the first refused claim');
 assert.equal(runs.state.claims.length,1,'the other queued runs were not tried against a limit that was just reached');
 assert.deepEqual(errors,[],'it is routine, not an error');
});

test('other claim failures are still errors and do not stop the pass',async()=>{
 const runs=fakeRuns({queued:['run-1','run-2'],claimError:new Error('database unavailable')}),{s,errors}=supervisor(runs,{maxConcurrent:2});
 await s.runOnce();await s.stop();
 assert.deepEqual(errors,['database unavailable','database unavailable']);assert.equal(runs.state.claims.length,2);
});

test('the review cooldown is validated',()=>{
 const runs=fakeRuns();
 for(const bad of [-1,1.5,'30',86400001])assert.throws(()=>supervisor(runs,{reviewCooldownMs:bad}),/Invalid run supervisor configuration/);
 assert.doesNotThrow(()=>supervisor(runs,{reviewCooldownMs:0}));
});
