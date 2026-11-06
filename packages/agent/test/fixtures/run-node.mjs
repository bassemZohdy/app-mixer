// One run "node": its own process and PostgreSQL pool running a PostgresRunSupervisor. It recovers runs whose lease
// expired (verifying each interrupted action against the effect server instead of replaying it) and executes queued
// runs of three journaled actions, until told to stop (drain) or killed.
import pg from 'pg';
import {PostgresAgentRuns,PostgresRunSupervisor} from '../../dist/index.js';
const [url,schema,nodeId,effects,concurrency='4']=process.argv.slice(2),scope={tenantId:'tenant',agentId:'agent'};
const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:4});
const transaction=async operation=>{const client=await pool.connect();try{await client.query('BEGIN');const result=await operation((sql,args)=>client.query(sql,args));await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}};
const runs=new PostgresAgentRuns({enabled:true,query:(sql,args)=>pool.query(sql,args),transaction});
const supervisor=new PostgresRunSupervisor({
 runs,scope,workerId:nodeId,leaseMs:1500,pollMs:50,recoveryGraceMs:300,maxConcurrent:Number(concurrency),limits:{maxConcurrentRuns:100},
 async execute({run,journal,signal}){
  for(const actionId of ['a1','a2','a3']){
   signal.throwIfAborted();
   await journal.invoke(actionId,'effect.apply',{runId:run.runId,actionId},3,async(input,key)=>{
    const response=await fetch(`${effects}/effects/${key}`,{method:'POST',headers:{'content-type':'application/json','x-node':nodeId},body:JSON.stringify(input)});
    if(!response.ok)throw Error('effect '+response.status);return response.json();
   });
  }
  return 'succeeded';
 },
 async verify(request){const response=await fetch(`${effects}/effects/${request.action.idempotencyKey}`);if(response.status===404)return {outcome:'not_applied'};return {outcome:'applied',result:await response.json()};},
 onEvent(event){process.send({...event,type:event.type==='settled'&&event.status==='succeeded'?'completed':event.type});},
 onError(error){process.send({type:'error',message:String(error?.stack??error)});},
});
process.on('message',async message=>{if(message==='stop'){await supervisor.stop();await pool.end();process.exit(0);}});
process.send({type:'ready'});supervisor.start();
