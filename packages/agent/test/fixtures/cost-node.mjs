// One "node" spending from shared agent cost budgets: its own process and pool. For each round it receives an agent
// scope and a run lease, then four concurrent callers reserve and settle model-call costs until the budget is spent.
import pg from 'pg';
import {PostgresAgentCostBudget} from '../../dist/index.js';
const [url,schema,nodeId]=process.argv.slice(2);
const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:3});
const transaction=async operation=>{const client=await pool.connect();try{await client.query('BEGIN');const result=await operation((sql,args)=>client.query(sql,args));await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}};
const budget=new PostgresAgentCostBudget({enabled:true,query:(sql,args)=>pool.query(sql,args),transaction});
process.on('message',async message=>{
 if(message==='stop'){await pool.end();process.exit(0);}
 const {round,agentId,runId,token}=message,scope={tenantId:'tenant',agentId};let admitted=0,next=0;const errors=[];
 await Promise.all(Array.from({length:4},async()=>{
  for(;;){
   const callId=`${nodeId}-${next++}`;
   try{await budget.reserve(scope,runId,token,callId,1000);}catch(error){if(!/Cost budget exhausted/.test(error.message))errors.push(error.message);return;}
   admitted++;await budget.settle(scope,runId,token,callId,1000);
  }
 }));
 process.send({round,admitted,errors});
});
process.send('ready');
