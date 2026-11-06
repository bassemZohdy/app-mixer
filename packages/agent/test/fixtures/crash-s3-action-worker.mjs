// Claims the run and dispatches one journaled action to the S3 provider through the test's proxy. The parent decides
// when the write may start ('go') and kills this process at the point under test.
import {SqliteAgentRuns,SqliteAgentActionJournal} from '../../dist/index.js';
import {putOnce,encodeKey} from '../../../core/test/fixtures/s3-provider.mjs';
const [path,proxyPort,host,bucket]=process.argv.slice(2),scope={tenantId:'tenant',agentId:'agent'};
let go;const started=new Promise(resolve=>go=resolve);process.on('message',message=>{if(message==='go')go();});
const runs=new SqliteAgentRuns(path),queued=runs.get(scope,'run'),run=runs.claim(scope,'run',queued.revision,'crash-worker',100,10),journal=new SqliteAgentActionJournal(path,{scope,runId:'run',leaseToken:run.leaseToken,clock:()=>10});
await journal.invoke('call','orders.place',{sku:'A-1',quantity:2},2,async(input,key)=>{
 process.send({type:'dispatching',key});await started;
 const result=await putOnce(Number(proxyPort),host,`/${bucket}/${encodeKey('orders/'+key)}`,JSON.stringify(input),60000);
 return {receipt:'orders/'+key,created:result.created};
});
process.send({type:'recorded'});
await new Promise(()=>{});
