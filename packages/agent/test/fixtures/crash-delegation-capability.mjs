import {writeFileSync} from 'node:fs';
import {CapabilityRegistry} from '../../../core/dist/index.js';
import {SqliteAgentDelegations,registerAgentDelegationCapability} from '../../dist/index.js';
const [path,barrier,phase,mode]=process.argv.slice(2),hold=()=>{writeFileSync(barrier,phase);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);},scope={tenantId:'tenant',agentId:'agent'},actor={tenantId:'tenant',principalId:'operator'};
try{
 const store=new SqliteAgentDelegations(path,{scope,runId:'run',authorize:()=>true,clock:()=>10}),registry=new CapabilityRegistry(event=>{if(phase==='after'&&event.outcome==='succeeded')hold();});
 if(phase==='event'){store.db.function('test_delegation_barrier',()=>{hold();return 0;});store.db.exec('CREATE TRIGGER test_delegation_crash BEFORE INSERT ON agent_delegation_events BEGIN SELECT test_delegation_barrier(); END');}
 registerAgentDelegationCapability(registry,{store,scope,runId:'run',grantId:'grant',mode,operationId:'manage',path:'/manage',authorize:()=>true,authorizeAction:()=>true});const query=mode==='issue'?{principalId:'user',permissionVersion:'v1',expiresAt:100}:mode==='renew'?{revision:1,permissionVersion:'v2',expiresAt:200}:{revision:1};
 process.send?.({ready:true});await registry.invoke('manage',{query},{...actor,origin:'ui'});throw Error('Expected termination');
}catch(error){process.send?.({error:String(error)});process.exitCode=1;}
