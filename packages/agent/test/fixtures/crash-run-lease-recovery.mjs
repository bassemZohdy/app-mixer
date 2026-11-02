import {writeFileSync} from 'node:fs';
import {SqliteAgentRuns,AgentRunLeaseRecoveryWorker} from '../../dist/index.js';
const [path,barrier,phase]=process.argv.slice(2),scope={tenantId:'tenant',agentId:'agent'};
const hold=()=>{writeFileSync(barrier,phase);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};
try{
 const runs=new SqliteAgentRuns(path);
 if(phase==='during'){runs.db.function('test_lease_recovery_crash',()=>{hold();return 0;});runs.db.exec("CREATE TRIGGER test_crash_lease_recovery AFTER UPDATE ON agent_runs WHEN NEW.tenant_id='tenant' AND NEW.status='uncertain' BEGIN SELECT test_lease_recovery_crash(); END");}
 const worker=new AgentRunLeaseRecoveryWorker({runs,scope,maxPerPass:1,pollMs:100,clock:()=>100,authorizationTimeoutMs:1000,maxPendingAuthorizations:1,authorize:()=>true,onError:error=>{throw error;},evidence:{principalId:'operator',reference:'ticket-1'}});
 if(await worker.runOnce()!==1)throw Error('Expected one recovered lease');if(phase==='after')hold();throw Error('Expected process termination');
}catch(error){process.send?.({error:String(error)});process.exitCode=1;}
