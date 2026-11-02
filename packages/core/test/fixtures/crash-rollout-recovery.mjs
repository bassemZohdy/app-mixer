import {writeFileSync} from 'node:fs';
import pg from 'pg';
import {SqliteRemoteRollout,PostgresRemoteRollout} from '../../dist/index.js';
const [mode,path,barrier,phase]=process.argv.slice(2),actor={tenantId:'tenant',principalId:'service'},connector={rolloutConfig:{safe:true,applicationId:'demo',sourceEnvironment:'dev',targetEnvironment:'prod'},rolloutRepository:{getPublished(){},getPromotionFloor(){}}};
const hold=()=>{writeFileSync(barrier,phase);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};
try{
 if(mode==='sqlite'){
  const rollout=new SqliteRemoteRollout(path,connector,actor);
  if(phase!=='after-commit'){rollout.db.function('test_rollout_barrier',()=>{hold();return 0;});const when=phase==='before-evidence'?'BEFORE':'AFTER';rollout.db.exec(`CREATE TRIGGER test_rollout_recovery_crash ${when} INSERT ON remote_rollout_recovery_events BEGIN SELECT test_rollout_barrier(); END`);}
  await rollout.recover(()=>true,{principalId:'operator',reference:'case-1',observedAt:123});if(phase==='after-commit')hold();
 }else{
  const pool=new pg.Pool({connectionString:process.env.APP_MIXER_TEST_POSTGRES_URL,options:`-c search_path=${process.env.APP_MIXER_TEST_SCHEMA}`});
  const query=async(sql,args)=>{if(!sql.startsWith('WITH changed AS'))return pool.query(sql,args);if(phase==='after-commit'){const result=await pool.query(sql,args);hold();return result;}const client=await pool.connect();try{await client.query('BEGIN');const result=await client.query(sql,args);hold();await client.query('COMMIT');return result;}finally{client.release();}};
  const rollout=new PostgresRemoteRollout({enabled:true,connector,actor,query});await rollout.recover(()=>true,{principalId:'operator',reference:'case-1',observedAt:123});
 }
 throw Error('Expected termination');
}catch(error){process.send?.({error:String(error)});process.exitCode=1;}
