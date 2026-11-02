import {writeFileSync} from 'node:fs';
import {SqliteAgentSchedules} from '../../dist/index.js';
const [path,barrier,phase]=process.argv.slice(2),scope={tenantId:'tenant',agentId:'agent'};
const hold=()=>{writeFileSync(barrier,phase);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};
try{
 const schedules=new SqliteAgentSchedules(path);
 if(phase!=='after'){
  schedules.db.function('test_schedule_barrier',()=>{hold();return 0;});
  const table=phase==='receipt'?'agent_trigger_receipts':'agent_schedule_events';
  schedules.db.exec(`CREATE TRIGGER test_schedule_crash BEFORE INSERT ON ${table} BEGIN SELECT test_schedule_barrier(); END`);
 }
 schedules.fire(scope,'timer',1,{definitionVersion:1,maxAttempts:2,runTimeoutMs:10000,maxPending:10},1000,'worker');
 if(phase==='after')hold();
 throw Error('Expected process termination');
}catch(error){process.send?.({error:String(error)});process.exitCode=1;}
