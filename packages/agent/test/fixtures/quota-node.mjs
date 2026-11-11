// One "node" for the multi-node quota test: its own process and PostgreSQL pool. For each round it waits for the
// parent's start instant, fires all its acquisitions at once, and reports which runs it was admitted for.
import pg from 'pg';
import {PostgresAgentRunSlots} from '../../dist/index.js';
const [url,schema,nodeId]=process.argv.slice(2);
const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:16});
const transaction=async operation=>{const client=await pool.connect();try{await client.query('BEGIN');const result=await operation((sql,args)=>client.query(sql,args));await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}};
const slots=new PostgresAgentRunSlots({enabled:true,query:(sql,args)=>pool.query(sql,args),transaction});
// Warm every connection so the round measures contention, not connection setup.
await Promise.all(Array.from({length:16},()=>pool.query('SELECT 1')));
process.send({type:'ready'});
process.on('message',async message=>{
 if(message.type==='stop'){await pool.end();process.exit(0);}
 const {round,scope,runIds,limits,startAt}=message;
 while(Date.now()<startAt)await new Promise(resolve=>setImmediate(resolve));
 const results=await Promise.allSettled(runIds.map(runId=>slots.acquire(scope,runId,nodeId,60000,limits)));
 process.send({type:'result',round,admitted:runIds.filter((_,i)=>results[i].status==='fulfilled'),errors:[...new Set(results.filter(result=>result.status==='rejected').map(result=>result.reason.message))]});
});
