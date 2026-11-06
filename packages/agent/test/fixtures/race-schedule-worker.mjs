import {SqliteAgentRuns,SqliteAgentTriggers,SqliteAgentSchedules,AgentScheduleWorker} from '../../dist/index.js';
const [path]=process.argv.slice(2),scope={tenantId:'tenant',agentId:'agent'};
const definition={version:1,manifest:{tenantId:'tenant',agentId:'agent',lifecycle:{enabled:true,maxAttempts:2,runTimeoutMs:10000}}};
const runs=new SqliteAgentRuns(path),triggers=new SqliteAgentTriggers(path),schedules=new SqliteAgentSchedules(path),errors=[];
const worker=new AgentScheduleWorker({schedules,scope,definitions:{get:()=>definition},authorize:()=>true,maxPending:10,maxPerPass:10,pollMs:100,onError:error=>errors.push(String(error?.message??error)),clock:()=>2000,auditActorId:'node'});
process.send({type:'ready'});
process.on('message',async()=>{try{const fired=await worker.runOnce();process.send({type:'done',fired,errors});}catch(error){process.send({type:'done',fired:-1,errors:[String(error.message)]});}finally{schedules.close();triggers.close();runs.close();}});
