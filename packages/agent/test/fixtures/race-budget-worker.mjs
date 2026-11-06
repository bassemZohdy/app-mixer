import {SqliteAgentTokenBudget} from '../../dist/index.js';
const [path,leaseToken,callId]=process.argv.slice(2),scope={tenantId:'tenant',agentId:'agent'};
const budget=new SqliteAgentTokenBudget(path,{scope,runId:'run',leaseToken,maxTokens:100,clock:()=>10});
process.send({type:'ready'});
process.on('message',()=>{try{budget.reserve(callId,60);process.send({type:'reserved'});}catch(error){process.send({type:'rejected',message:String(error.message)});}});
