import {SqliteAgentRuns,SqliteAgentTokenBudget} from '../../dist/index.js';
const [path,base,mode,budgetMode]=process.argv.slice(2),scope={tenantId:'tenant',agentId:'agent'},cost=budgetMode==='cost'?{currency:'USD',maxMicros:1000}:undefined;
process.on('message',()=>{});
const runs=new SqliteAgentRuns(path),queued=runs.get(scope,'run'),run=runs.claim(scope,'run',queued.revision,'crash-worker',100,10),budget=new SqliteAgentTokenBudget(path,{scope,runId:'run',leaseToken:run.leaseToken,maxTokens:100,cost,clock:()=>10});
budget.reserve('call',60,cost?600:undefined);process.send({type:'reserved'});
if(mode==='before')await new Promise(()=>{});
const response=await fetch(base+'/invoke',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({callId:'call'})}),usage=await response.json();
budget.settle('call',usage.usedTokens,cost?usage.usedCostMicros:undefined);process.send({type:'recorded'});
await new Promise(()=>{});
