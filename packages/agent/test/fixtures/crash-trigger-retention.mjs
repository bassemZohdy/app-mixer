import {writeFileSync} from 'node:fs';
import {SqliteAgentTriggerRetention,AgentTriggerRetentionWorker} from '../../dist/index.js';
const [path,barrier,phase]=process.argv.slice(2),scope={tenantId:'tenant',agentId:'agent'},actor={tenantId:'tenant',principalId:'cleaner'};
const hold=()=>{writeFileSync(barrier,phase);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};
try{
 const retention=new SqliteAgentTriggerRetention(path,{scope,authorize:()=>true,authorizeDiscovery:()=>true});
 if(phase==='during'){retention.db.function('test_crash_barrier',()=>{hold();return 0;});retention.db.exec('CREATE TRIGGER test_crash_retention BEFORE INSERT ON agent_trigger_redactions BEGIN SELECT test_crash_barrier(); END');}
 const worker=new AgentTriggerRetentionWorker({retention,actor,minAgeMs:20,maxPerPass:5,pollMs:100,clock:()=>100,authorize:()=>true,onError:error=>{throw error;}});
 const count=await worker.runOnce();if(count!==1)throw Error('Expected one redaction');if(phase==='after')hold();throw Error('Expected process termination');
}catch(error){process.send?.({error:String(error)});process.exitCode=1;}
