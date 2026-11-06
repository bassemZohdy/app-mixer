import {SqliteAgentDefinitions} from '../../dist/index.js';
const [path,mode]=process.argv.slice(2);
const manifest=name=>({manifestVersion:1,tenantId:'tenant',agentId:'agent',name,owner:{kind:'organization',id:'org'},administrators:['admin'],servicePrincipalId:'svc',model:{provider:'local',model:'test'},allowedCapabilities:[],lifecycle:{enabled:true,maxAttempts:2,runTimeoutMs:60000},quotas:{maxConcurrentRuns:1,maxTokensPerRun:100,maxRunsPerDay:10}});
process.on('message',()=>{});
const definitions=new SqliteAgentDefinitions(path);
definitions.save('tenant',manifest('First'),0);
if(mode==='second')definitions.save('tenant',manifest('Second'),1);
process.send({type:mode});
await new Promise(()=>{});
