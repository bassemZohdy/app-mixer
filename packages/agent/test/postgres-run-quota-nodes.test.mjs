// Two separate processes, each with its own PostgreSQL pool, start more runs than one agent's quota allows at the
// same instant, over many rounds. Exactly the limit is admitted every time, and the database records exactly that.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import pg from 'pg';

const url=process.env.APP_MIXER_TEST_POSTGRES_URL,nodePath=fileURLToPath(new URL('./fixtures/quota-node.mjs',import.meta.url));

test('two nodes exceeding an agent run quota at the same instant admit exactly the limit',{skip:!url&&'set APP_MIXER_TEST_POSTGRES_URL to run against PostgreSQL',timeout:180000},async t=>{
 const schema='run_quota_nodes_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:url}),nodes=[];
 try{
  await admin.query(`CREATE SCHEMA "${schema}"`);
  // Create the tables once, so the race is over admission rather than over table creation.
  const {PostgresAgentRunSlots}=await import('../dist/index.js'),setup=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
  try{await new PostgresAgentRunSlots({enabled:true,query:(sql,args)=>setup.query(sql,args),transaction:async operation=>operation((sql,args)=>setup.query(sql,args))}).initialize();}finally{await setup.end();}
  for(const nodeId of ['node-a','node-b']){const child=fork(nodePath,[url,schema,nodeId],{stdio:['ignore','inherit','inherit','ipc']});nodes.push(child);}
  await Promise.all(nodes.map(child=>new Promise((resolve,reject)=>{child.once('message',message=>message.type==='ready'?resolve():reject(Error('node not ready')));child.once('exit',code=>reject(Error('node exited '+code)));})));
  const round=async(index,limits,perNode)=>{
   const scope={tenantId:'tenant',agentId:'agent-'+index},startAt=Date.now()+300;
   const replies=Promise.all(nodes.map(child=>new Promise(resolve=>{const listener=message=>{if(message.type==='result'&&message.round===index){child.off('message',listener);resolve(message);}};child.on('message',listener);})));
   nodes.forEach((child,n)=>child.send({type:'round',round:index,scope,limits,startAt,runIds:Array.from({length:perNode},(_,i)=>`run-${n}-${i}`)}));
   const results=await replies,admitted=results.flatMap(result=>result.admitted);
   for(const result of results)for(const message of result.errors)assert.equal(message,'Agent run quota exceeded','only quota refusals: '+message);
   const slots=Number((await admin.query(`SELECT COUNT(*)::int AS n FROM "${schema}".app_mixer_agent_run_slots WHERE tenant_id=$1 AND agent_id=$2`,[scope.tenantId,scope.agentId])).rows[0].n);
   const starts=Number((await admin.query(`SELECT COUNT(*)::int AS n FROM "${schema}".app_mixer_agent_run_starts WHERE tenant_id=$1 AND agent_id=$2`,[scope.tenantId,scope.agentId])).rows[0].n);
   return {admitted,byNode:results.map(result=>result.admitted.length),slots,starts};
  };
  const rounds=20,perNode=15;let bothNodesWon=0;
  for(let i=0;i<rounds;i++){
   // Concurrency limit: 30 simultaneous starts against maxConcurrentRuns 5.
   const concurrent=await round(i*2,{maxConcurrentRuns:5},perNode);
   assert.equal(concurrent.admitted.length,5,`round ${i}: concurrency admitted ${concurrent.admitted.length}`);assert.equal(concurrent.slots,5);assert.equal(new Set(concurrent.admitted).size,5);
   // Daily limit: 30 simultaneous starts against maxRunsPerDay 7 with room for all of them concurrently.
   const daily=await round(i*2+1,{maxConcurrentRuns:50,maxRunsPerDay:7},perNode);
   assert.equal(daily.admitted.length,7,`round ${i}: daily admitted ${daily.admitted.length}`);assert.equal(daily.starts,7);assert.equal(daily.slots,7);
   if(concurrent.byNode.every(count=>count>0)||daily.byNode.every(count=>count>0))bothNodesWon++;
   if(i===0||i===rounds-1)t.diagnostic(`round ${i}: concurrency 5 admitted ${concurrent.byNode.join('+')}, daily 7 admitted ${daily.byNode.join('+')} of ${2*perNode} each`);
  }
  t.diagnostic(`${rounds} rounds, ${2*rounds*2*perNode} simultaneous attempts; both nodes were admitted in the same round ${bothNodesWon} times`);
  assert.ok(bothNodesWon>0,'the nodes really competed: both were admitted within one round at least once');
 }finally{
  for(const child of nodes)if(child.exitCode===null){child.send({type:'stop'});await Promise.race([once(child,'exit'),new Promise(resolve=>setTimeout(resolve,5000))]);if(child.exitCode===null)child.kill('SIGKILL');}
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(()=>{});await admin.end();
 }
});
