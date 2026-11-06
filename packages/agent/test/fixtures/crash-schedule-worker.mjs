import {SqliteAgentRuns,SqliteAgentTriggers,SqliteAgentSchedules} from '../../dist/index.js';
const [path,mode]=process.argv.slice(2),scope={tenantId:'tenant',agentId:'agent'},policy={definitionVersion:1,maxAttempts:2,runTimeoutMs:10000,maxPending:10};
process.on('message',()=>{});
const runs=new SqliteAgentRuns(path),triggers=new SqliteAgentTriggers(path),schedules=new SqliteAgentSchedules(path);
const schedule=schedules.get(scope,'daily')??schedules.save(scope,'daily',{enabled:true,principalId:'scheduler',rule:{kind:'interval',intervalMs:1000}},0,1000);
if(mode==='before'){process.send({type:'saved'});await new Promise(()=>{});}
const fired=schedules.fire(scope,'daily',schedule.revision,policy,2000);
process.send({type:'fired',runId:fired.runId});
await new Promise(()=>{});
