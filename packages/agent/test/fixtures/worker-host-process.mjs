import {SqliteAgentRuns,SqliteAgentTriggers,SqliteAgentSchedules,AgentScheduleWorker,AgentWorkerHost} from '../../dist/index.js';
const [path]=process.argv.slice(2),scope={tenantId:'tenant',agentId:'agent'};
const definition={version:1,manifest:{tenantId:'tenant',agentId:'agent',lifecycle:{enabled:true,maxAttempts:2,runTimeoutMs:10000}}};
const runs=new SqliteAgentRuns(path),triggers=new SqliteAgentTriggers(path),schedules=new SqliteAgentSchedules(path);
let release;const gate=new Promise(resolve=>release=resolve);let passes=0;
// The authorization callback blocks the first pass, so shutdown arrives while a pass is in flight.
const worker=new AgentScheduleWorker({schedules,scope,definitions:{get:()=>definition},authorize:async()=>{if(++passes===1){process.send({type:'in-pass'});await gate;}return true;},maxPending:10,maxPerPass:10,pollMs:100,onError:()=>{},clock:()=>2000});
const host=new AgentWorkerHost({workers:{schedules:worker},stopTimeoutMs:5000});
host.handleSignals(process,result=>{schedules.close();triggers.close();runs.close();process.send({type:'stopped',result,state:host.state()},()=>process.exit(0));});
process.on('message',message=>{if(message==='emit-sigterm')process.emit('SIGTERM');if(message==='release')release();});
await host.start();process.send({type:'ready',ready:host.ready()});
