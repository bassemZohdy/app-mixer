import pg from 'pg';
import {PostgresAgentRunSlots,SqliteAgentDefinitions,SqliteAgentRuns,DurableAgentWorker} from '../../dist/index.js';

const phase=process.env.APP_MIXER_TEST_PHASE,scope={tenantId:'tenant',agentId:process.env.APP_MIXER_TEST_AGENT},pool=new pg.Pool({connectionString:process.env.APP_MIXER_TEST_POSTGRES_URL,options:`-c search_path=${process.env.APP_MIXER_TEST_SCHEMA}`}),runs=new SqliteAgentRuns(process.env.APP_MIXER_TEST_DB),definitions=new SqliteAgentDefinitions(process.env.APP_MIXER_TEST_DB),hold=()=>new Promise(()=>{});
const transaction=async operation=>{const client=await pool.connect();try{await client.query('BEGIN');const result=await operation((sql,args)=>client.query(sql,args));await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}};
const slots=new PostgresAgentRunSlots({enabled:true,query:(sql,args)=>pool.query(sql,args),transaction});
const acquire=slots.acquire.bind(slots);slots.acquire=async(...args)=>{const token=await acquire(...args);if(phase==='after-slot-acquired'){process.send(phase);await hold();}return token;};
try{const worker=new DurableAgentWorker({runs,definitions,workerId:'dead-worker',leaseMs:2000,pollMs:100,authorizeStart:()=>true,sharedSlots:slots,execute:async()=>{process.send('during-execution');await hold();return 'uncertain';}});await worker.runOnce(scope,'one');throw Error('Expected termination');}catch(error){process.send({error:String(error)});process.exitCode=1;await pool.end();runs.close();definitions.close();}
