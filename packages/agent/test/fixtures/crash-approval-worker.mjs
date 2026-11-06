import {SqliteAgentApprovals} from '../../dist/index.js';
const [path,leaseToken,mode]=process.argv.slice(2),scope={tenantId:'tenant',agentId:'agent'},service={tenantId:'tenant',principalId:'service'},human={tenantId:'tenant',principalId:'human'};
process.on('message',()=>{});
const approvals=new SqliteAgentApprovals(path,{scope,runId:'run',clock:()=>10,authorize:(actor,action)=>actor.principalId==='service'?action==='request':actor.principalId==='human'});
await approvals.request(service,leaseToken,'action','pay',{amount:10},90);
if(mode==='decided')await approvals.decide(human,'action','approved');
process.send({type:mode});
await new Promise(()=>{});
