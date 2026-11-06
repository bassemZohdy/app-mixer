// One run "node": its own process and PostgreSQL pool. It recovers runs whose lease expired (verifying each
// unresolved action against the effect server instead of replaying it), then claims queued runs and performs their
// three journaled actions, until told to stop (or killed).
import pg from 'pg';
import {PostgresAgentRuns} from '../../dist/index.js';
const [url,schema,nodeId,effects]=process.argv.slice(2),scope={tenantId:'tenant',agentId:'agent'};
const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:4});
const transaction=async operation=>{const client=await pool.connect();try{await client.query('BEGIN');const result=await operation((sql,args)=>client.query(sql,args));await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}};
const runs=new PostgresAgentRuns({enabled:true,query:(sql,args)=>pool.query(sql,args),transaction});
const lost=/revision conflict|cannot be claimed|Lease is active/;
let stopping=false;process.on('message',message=>{if(message==='stop')stopping=true;});

async function recover(){
 for(const run of await runs.expiredLeases(scope)){
  let current;try{current=await runs.recoverExpired(scope,run.runId,run.revision);}catch(error){if(lost.test(error.message))continue;throw error;}
  process.send({type:'recovered',runId:run.runId});
  const journal=runs.journal(scope,run.runId,'recovery');
  for(const action of await journal.unresolved()){
   if(action.status==='dispatching')await journal.markUncertain(action.actionId);
   const outcome=await journal.reconcileWith(action.actionId,async request=>{const response=await fetch(`${effects}/effects/${request.action.idempotencyKey}`);if(response.status===404)return {outcome:'not_applied'};return {outcome:'applied',result:await response.json()};});
   process.send({type:'reconciled',runId:run.runId,actionId:action.actionId,outcome});
  }
  await runs.reconcile(scope,run.runId,current.revision,'retry');
 }
}
async function work(){
 for(const run of await runs.queued(scope)){
  let lease;try{lease=await runs.claim(scope,run.runId,run.revision,nodeId,1500,{maxConcurrentRuns:100});}catch(error){if(lost.test(error.message))continue;throw error;}
  process.send({type:'claimed',runId:run.runId,attempt:lease.attempts});
  const journal=runs.journal(scope,run.runId,lease.leaseToken);
  for(const actionId of ['a1','a2','a3'])await journal.invoke(actionId,'effect.apply',{runId:run.runId,actionId},3,async(input,key)=>{
   const response=await fetch(`${effects}/effects/${key}`,{method:'POST',headers:{'content-type':'application/json','x-node':nodeId},body:JSON.stringify(input)});
   if(!response.ok)throw Error('effect '+response.status);return response.json();
  });
  await runs.settle(scope,run.runId,lease.revision,lease.leaseToken,'succeeded');
  process.send({type:'completed',runId:run.runId});
 }
}
process.send({type:'ready'});
while(!stopping){await recover();await work();await new Promise(resolve=>setTimeout(resolve,50));}
await pool.end();process.exit(0);
