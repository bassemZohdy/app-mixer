// One scheduling "node": its own process and PostgreSQL pool, polling the shared schedules, firing due occurrences
// and claiming run requests until told to stop (or killed).
import pg from 'pg';
import {PostgresAgentSchedules} from '../../dist/index.js';
const [url,schema,nodeId]=process.argv.slice(2),scope={tenantId:'tenant',agentId:'agent'};
const policy={definitionVersion:1,maxAttempts:3,runTimeoutMs:60000,maxPending:10000};
const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:4});
const transaction=async operation=>{const client=await pool.connect();try{await client.query('BEGIN');const result=await operation((sql,args)=>client.query(sql,args));await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}};
const schedules=new PostgresAgentSchedules({enabled:true,query:(sql,args)=>pool.query(sql,args),transaction});
let stopping=false;const totals={fired:0,conflicts:0,started:0};
process.on('message',message=>{if(message==='stop')stopping=true;});
process.send({type:'ready'});
while(!stopping){
 const pass=await schedules.fireDue(scope,policy,{nodeId});totals.fired+=pass.fired.length;totals.conflicts+=pass.conflicts;
 for(let claim;(claim=await schedules.claimRun(scope,nodeId,1500));){
  process.send({type:'claimed',runId:claim.runId});
  if(await schedules.markStarted(scope,claim.runId,claim.token))totals.started++;
 }
 process.send({type:'totals',...totals});
 await new Promise(resolve=>setTimeout(resolve,50));
}
await pool.end();process.send({type:'totals',...totals});process.exit(0);
