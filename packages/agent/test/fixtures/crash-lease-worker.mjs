import {SqliteAgentRuns} from '../../dist/index.js';
const [path]=process.argv.slice(2),scope={tenantId:'tenant',agentId:'agent'};
process.on('message',()=>{});
const runs=new SqliteAgentRuns(path),queued=runs.get(scope,'run'),run=runs.claim(scope,'run',queued.revision,'crash-worker',100,10);
process.send({type:'claimed',leaseToken:run.leaseToken,revision:run.revision});
await new Promise(()=>{});
