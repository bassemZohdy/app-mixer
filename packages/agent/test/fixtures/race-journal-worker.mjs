import {SqliteAgentActionJournal} from '../../dist/index.js';
const [path,leaseToken]=process.argv.slice(2),scope={tenantId:'tenant',agentId:'agent'};
const journal=new SqliteAgentActionJournal(path,{scope,runId:'run',leaseToken,clock:()=>10});
process.send({type:'ready'});
process.on('message',async()=>{try{await journal.invoke('call','operation',{value:'one'},2,async()=>{process.send({type:'dispatching'});await new Promise(()=>{});});}catch(error){process.send({type:'rejected',message:String(error.message)});}});
