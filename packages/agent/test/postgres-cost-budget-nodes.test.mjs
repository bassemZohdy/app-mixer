// An agent-wide daily cost budget shared by separate processes through PostgreSQL: concurrent nodes together never
// spend more than the limit, reservations are fenced on the run lease, and a provider overrun stops all spending.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {PostgresAgentRuns,PostgresAgentCostBudget} from '../dist/index.js';

const url=process.env.APP_MIXER_TEST_POSTGRES_URL,nodePath=fileURLToPath(new URL('./fixtures/cost-node.mjs',import.meta.url));
const scope={tenantId:'tenant',agentId:'agent'},skip=!url&&'set APP_MIXER_TEST_POSTGRES_URL to run against PostgreSQL';
const transaction=pool=>async operation=>{const client=await pool.connect();try{await client.query('BEGIN');const result=await operation((sql,args)=>client.query(sql,args));await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}};
async function database(prefix){
 const schema=prefix+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:url}),pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
 await admin.query(`CREATE SCHEMA "${schema}"`);const options={enabled:true,query:(sql,args)=>pool.query(sql,args),transaction:transaction(pool)};
 const runs=new PostgresAgentRuns(options),budget=new PostgresAgentCostBudget(options);await runs.initialize();await budget.initialize();
 const lease=async(runId,agentId='agent')=>{const scope={tenantId:'tenant',agentId};const run=await runs.create(scope,runId,{definitionVersion:1,maxAttempts:3,deadline:Date.now()+600000});return runs.claim(scope,runId,run.revision,'worker',600000,{maxConcurrentRuns:100});};
 return {schema,runs,budget,lease,close:async()=>{await pool.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(()=>{});await admin.end();}};
}

test('the shared cost budget fences on the run lease, stops at the limit and after a provider overrun',{skip,timeout:60000},async()=>{
 const db=await database('cost_');
 try{
  const {runs,budget}=db;assert.throws(()=>new PostgresAgentCostBudget({enabled:true,query:()=>{}}),/Invalid cost budget configuration/);
  const first=await db.lease('r1');
  await assert.rejects(budget.reserve(scope,'r1',first.leaseToken,'c0',100),/Cost budget unavailable/);
  await assert.rejects(budget.configure(scope,{currency:'usd',maxMicrosPerDay:5000}),/Invalid cost budget/);
  await budget.configure(scope,{currency:'USD',maxMicrosPerDay:5000});
  await assert.rejects(budget.reserve(scope,'r1',randomUUID(),'c1',100),/lease unavailable/,'a stale lease cannot spend');
  const call=await budget.reserve(scope,'r1',first.leaseToken,'c1',3000);assert.equal(call.status,'reserved');
  await assert.rejects(budget.reserve(scope,'r1',first.leaseToken,'c1',100),/already exists/);
  const second=await db.lease('r2');
  await assert.rejects(budget.reserve(scope,'r2',second.leaseToken,'c1',2001),/Cost budget exhausted/,'the limit spans runs');
  await budget.reserve(scope,'r2',second.leaseToken,'c1',2000);
  assert.deepEqual(await budget.summary(scope).then(s=>[s.currency,s.limit,s.committed,s.reserved,s.overrun]),['USD',5000,0,5000,false]);
  await budget.settle(scope,'r1',first.leaseToken,'c1',1000);await assert.rejects(budget.settle(scope,'r1',first.leaseToken,'c1',1000),/Invalid cost call state/);
  // A run settled with an open reservation becomes uncertain; the reservation is reconciled once usage is known.
  const open=await runs.settle(scope,'r2',second.revision,second.leaseToken,'succeeded');assert.equal(open.status,'uncertain');
  await assert.rejects(budget.settle(scope,'r2',second.leaseToken,'c1',500),/lease unavailable/);
  await assert.rejects(budget.reconcile(scope,'r1',  'c1',500),/not uncertain/);
  await budget.reconcile(scope,'r2','c1',500);assert.equal((await runs.reconcile(scope,'r2',open.revision,'succeeded')).status,'succeeded');
  // A provider that charged more than was reserved stops every node from spending for the day.
  await budget.reserve(scope,'r1',first.leaseToken,'c2',1000);await budget.settle(scope,'r1',first.leaseToken,'c2',1500);
  assert.deepEqual(await budget.summary(scope).then(s=>[s.committed,s.reserved,s.overrun]),[3000,0,true]);
  await assert.rejects(budget.reserve(scope,'r1',first.leaseToken,'c3',1),/provider limit violated/);
  await assert.rejects(budget.configure(scope,{currency:'EUR',maxMicrosPerDay:5000}),/currency conflict/);
  assert.equal((await budget.summary(scope,0)).committed,0,'other days are separate');
  await assert.rejects(budget.summary({tenantId:'other',agentId:'agent'}),/Cost budget unavailable/,'budgets are tenant-scoped');
 }finally{await db.close();}
});

test('four nodes spending at once never exceed the shared daily cost budget',{skip,timeout:180000},async t=>{
 const db=await database('cost_nodes_'),nodes=[],results=new Map();
 try{
  for(const nodeId of ['n1','n2','n3','n4']){const child=fork(nodePath,[url,db.schema,nodeId],{stdio:['ignore','inherit','inherit','ipc']}),ready=once(child,'message');child.on('message',message=>{if(message!=='ready')results.get(message.round).push({nodeId,...message});});nodes.push({nodeId,child,ready});}
  await Promise.all(nodes.map(node=>node.ready));
  // Round 0 spends a large budget; rounds 1-30 are tight (three calls), so all 16 callers contend at the limit at once.
  const rounds=[{limit:100000},...Array.from({length:30},()=>({limit:3000}))];let overall='';
  for(const [round,{limit}] of rounds.entries()){
   const agentId='agent-'+round,scope={tenantId:'tenant',agentId};await db.budget.configure(scope,{currency:'USD',maxMicrosPerDay:limit});results.set(round,[]);
   const leases=await Promise.all(nodes.map(node=>db.lease(node.nodeId,agentId)));
   nodes.forEach((node,i)=>node.child.send({round,agentId,runId:leases[i].runId,token:leases[i].leaseToken}));
   while(results.get(round).length<nodes.length)await new Promise(resolve=>setTimeout(resolve,5));
   const outcome=results.get(round),admitted=outcome.reduce((sum,result)=>sum+result.admitted,0),summary=await db.budget.summary(scope);
   assert.deepEqual(outcome.flatMap(result=>result.errors),[]);
   assert.equal(admitted,limit/1000,`round ${round}: exactly the budget was admitted across nodes`);
   assert.deepEqual([summary.committed,summary.reserved,summary.overrun],[limit,0,false],`round ${round}: committed spend equals the limit, never more`);
   if(round===0){assert.ok(outcome.filter(result=>result.admitted>0).length>=2,'several nodes spent from the budget');overall=outcome.map(result=>result.admitted).join(' + ');}
  }
  t.diagnostic(`4 nodes x 4 concurrent callers: ${overall} = 100 calls against a 100000-micro budget, then 30 rounds of 16 callers racing for a 3-call budget each admitted exactly 3`);
 }finally{for(const {child} of nodes)if(child.exitCode===null)child.kill('SIGKILL');await db.close();}
});
