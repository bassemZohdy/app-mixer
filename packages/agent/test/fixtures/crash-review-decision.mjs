import {writeFileSync} from 'node:fs';
import {SqliteAgentApprovals,SqliteAgentNotices} from '../../dist/index.js';
const [path,barrier,kind,phase,noticeId]=process.argv.slice(2),scope={tenantId:'tenant',agentId:'agent'},reviewer={tenantId:'tenant',principalId:'reviewer'};
const hold=()=>{writeFileSync(barrier,phase);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};
try{
 const store=kind==='decision'||kind==='request'?new SqliteAgentApprovals(path,{scope,runId:'run',clock:()=>20,authorize:()=>true}):new SqliteAgentNotices(path,{scope,clock:()=>20,authorize:()=>true});
 if(phase!=='after'){store.db.function('test_review_barrier',()=>{hold();return 0;});const table=kind==='request'?(phase==='event'?'agent_approval_events':'agent_notices'):kind==='decision'?'agent_approval_events':'agent_notice_receipts',condition=kind==='decision'?" WHEN NEW.event='approved'":kind==='request'&&phase==='event'?" WHEN NEW.event='requested'":'';store.db.exec(`CREATE TRIGGER test_review_crash AFTER INSERT ON ${table}${condition} BEGIN SELECT test_review_barrier(); END`);}
 if(kind==='decision')await store.decide(reviewer,'action','approved');else if(kind==='request')await store.request({tenantId:'tenant',principalId:'service'},noticeId,'action','pay',{amount:12},90,'service,user');else await store.acknowledge(reviewer,Number(noticeId));
 if(phase==='after')hold();throw Error('Expected process termination');
}catch(error){process.send?.({error:String(error)});process.exitCode=1;}
