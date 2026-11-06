import {SqliteAgentDelegations} from '../../dist/index.js';
const [path,mode]=process.argv.slice(2),scope={tenantId:'tenant',agentId:'agent'},admin={tenantId:'tenant',principalId:'admin'};
process.on('message',()=>{});
const store=new SqliteAgentDelegations(path,{scope,runId:'run',clock:()=>10,authorize:(actor,action)=>actor.principalId==='admin'||(actor.principalId==='worker'&&action==='verify')});
await store.issue(admin,{...scope,runId:'run',grantId:'grant',principalId:'user',permissionVersion:'v1',expiresAt:50});
if(mode==='renewed')await store.renew(admin,'grant',1,'v2',100);
process.send({type:mode});
await new Promise(()=>{});
