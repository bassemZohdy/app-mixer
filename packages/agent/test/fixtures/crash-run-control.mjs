import {writeFileSync} from 'node:fs';
import {SqliteAgentRuns} from '../../dist/index.js';
const [path,barrier,phase,action='pause']=process.argv.slice(2),scope={tenantId:'tenant',agentId:'agent'};
const hold=()=>{writeFileSync(barrier,phase);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};
try{const runs=new SqliteAgentRuns(path);if(phase==='during'){runs.db.function('test_control_crash',()=>{hold();return 0;});runs.db.exec(`CREATE TRIGGER test_crash_control AFTER UPDATE ON agent_runs WHEN NEW.tenant_id='tenant' AND ${action==='archive'?'NEW.archived=1':"NEW.status='paused'"} BEGIN SELECT test_control_crash(); END`);}if(action==='archive')runs.archive(scope,'run',2,100,{principalId:'operator'});else runs.request(scope,'run',1,'pause',100,{principalId:'operator'});if(phase==='after')hold();throw Error('Expected process termination');}catch(error){process.send?.({error:String(error)});process.exitCode=1;}
