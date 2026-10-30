import pg from 'pg';
import {PostgresAgentDefinitions} from '../../dist/index.js';

const phase=process.env.APP_MIXER_TEST_PHASE;
const pool=new pg.Pool({connectionString:process.env.APP_MIXER_TEST_POSTGRES_URL,options:`-c search_path=${process.env.APP_MIXER_TEST_SCHEMA}`});
const hold=()=>new Promise(()=>{});
const store=new PostgresAgentDefinitions({enabled:true,clock:()=>200,authorize:()=>true,query:(sql,args)=>pool.query(sql,args),transaction:async operation=>{
 const client=await pool.connect();try{
  await client.query('BEGIN');
  const result=await operation(async(sql,args)=>{const response=await client.query(sql,args);if(phase==='before-audit'&&sql.startsWith('INSERT INTO app_mixer_agent_definitions ')){process.send(phase);await hold();}return response;});
  if(phase==='before-commit'){process.send(phase);await hold();}
  await client.query('COMMIT');if(phase==='after-commit'){process.send(phase);await hold();}return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}});
const manifest={manifestVersion:1,tenantId:'tenant',agentId:'agent',name:phase,owner:{kind:'organization',id:'org'},administrators:['admin'],servicePrincipalId:'svc',model:{provider:'local',model:'test'},allowedCapabilities:['lookup'],lifecycle:{enabled:true,maxAttempts:2,runTimeoutMs:60000},quotas:{maxConcurrentRuns:2,maxTokensPerRun:100,maxRunsPerDay:10}};
try{await store.save({tenantId:'tenant',principalId:'worker'},manifest,1);throw Error('Expected termination');}catch(error){process.send({error:String(error)});process.exitCode=1;await pool.end();}
