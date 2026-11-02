import test from 'node:test';
import assert from 'node:assert/strict';
import {AgentCombinedMetrics,AgentIngressMetrics,AgentActionRecoveryMetrics,createAgentMetricsServer} from '../dist/index.js';
const actor={tenantId:'tenant',principalId:'operator'};

test('combined metric sources retain independent authorization and serve one protected endpoint',async()=>{
 let allowed=true;const ingress=new AgentIngressMetrics({authorize:a=>allowed&&a.principalId==='operator'}),recovery=new AgentActionRecoveryMetrics({authorize:a=>allowed&&a.principalId==='operator'});ingress.observe({outcome:'accepted',durationMs:50});recovery.observe({outcome:'completed',reconciled:1,durationMs:20,unknown:2});const sources=[ingress,recovery],combined=new AgentCombinedMetrics({sources,authorize:a=>allowed&&a.principalId==='operator'});sources.reverse();sources.push({render:()=>{throw Error('unexpected');}});const text=await combined.render(actor);assert.match(text,/app_mixer_agent_ingress_requests_total\{outcome="accepted"\} 1/);assert.match(text,/app_mixer_agent_action_recovery_reconciled_total 1/);assert.match(text,/app_mixer_agent_action_recovery_unresolved_total\{reason="unknown"\} 2/);assert.doesNotMatch(text,/tenant|operator/);
 const server=createAgentMetricsServer({metrics:combined,timeoutMs:1000,maxPending:2,authenticate:req=>req.headers.authorization==='Bearer valid'?actor:undefined});try{await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}/metrics`;assert.equal((await fetch(url)).status,401);const response=await fetch(url,{headers:{authorization:'Bearer valid'}});assert.equal(response.status,200);assert.equal(await response.text(),text);allowed=false;assert.equal((await fetch(url,{headers:{authorization:'Bearer valid'}})).status,403);}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('combined metrics fail closed on changing authorization and invalid sources',async()=>{
 let allow=true,checks=0;const combined=new AgentCombinedMetrics({authorize:()=>++checks===1,sources:[{render:()=>{allow=false;return '# TYPE one counter\none 1\n';}}]});await assert.rejects(combined.render(actor),/access denied/);assert.equal(allow,false);const denied=new AgentCombinedMetrics({authorize:()=>true,sources:[{render:()=>{throw Error('Agent metrics access denied');}}]});await assert.rejects(denied.render(actor),/access denied/);
 for(const sources of [[],Array(11).fill({render:()=>''}),[{}]])assert.throws(()=>new AgentCombinedMetrics({authorize:()=>true,sources}),/Invalid combined metrics configuration/);
 const duplicate=new AgentCombinedMetrics({authorize:()=>true,sources:[{render:()=> '# TYPE same counter\nsame 1\n'},{render:()=> '# TYPE same gauge\nsame 2\n'}]});await assert.rejects(duplicate.render(actor),/Duplicate combined metric/);
 for(const value of [3,'bad\0data','x'.repeat(65537)]){const invalid=new AgentCombinedMetrics({authorize:()=>true,sources:[{render:()=>value}]});await assert.rejects(invalid.render(actor),/Invalid combined metrics data/);}
 await assert.rejects(duplicate.render({...actor,tenantId:''}),/Invalid agent metrics actor/);
});
