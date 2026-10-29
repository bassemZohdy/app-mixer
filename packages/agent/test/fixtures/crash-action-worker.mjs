import {SqliteAgentRuns,SqliteAgentActionJournal} from '../../dist/index.js';
const [path,base,mode]=process.argv.slice(2),scope={tenantId:'tenant',agentId:'agent'};
process.on('message',()=>{});
const runs=new SqliteAgentRuns(path),queued=runs.get(scope,'run'),run=runs.claim(scope,'run',queued.revision,'crash-worker',100,10),journal=new SqliteAgentActionJournal(path,{scope,runId:'run',leaseToken:run.leaseToken,clock:()=>10});
await journal.invoke('call','operation',{value:'one'},2,async(input,key)=>{
 process.send({type:'dispatching',key});
 if(mode==='before')await new Promise(()=>{});
 const response=await fetch(base+'/apply',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key,input})});
 return response.json();
});
process.send({type:'recorded'});
await new Promise(()=>{});
