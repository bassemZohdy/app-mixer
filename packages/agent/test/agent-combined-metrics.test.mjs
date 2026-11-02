import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentCombinedMetrics,AgentIngressMetrics,AgentActionRecoveryMetrics,SqliteAgentRuns,SqliteAgentRunMetrics,createAgentMetricsServer} from '../dist/index.js';
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

 test('combined metrics bound and cancel late policy and source callbacks',async()=>{
  for(const phase of ['authorize','source','reauthorize'])for(const interruption of ['timeout','abort']){
   let enabled=true,entered,release,checks=0,seen,next=0;const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),pause=async signal=>{seen=signal;entered();await gate;};const combined=new AgentCombinedMetrics({callbackTimeoutMs:100,maxPendingCallbacks:1,authorize:async(_actor,signal)=>{checks++;if(enabled&&(phase==='authorize'&&checks===1||phase==='reauthorize'&&checks===2))await pause(signal);return true;},sources:[{render:()=>{throw Error('wrong entrypoint');},renderWithSignal:async(_actor,signal)=>{if(enabled&&phase==='source')await pause(signal);return '# TYPE one counter\none 1\n';}},{render:()=>{next++;return '# TYPE two counter\ntwo 2\n';}}]});const controller=new AbortController(),pending=combined.renderWithSignal(actor,controller.signal);await ready;if(interruption==='abort')controller.abort();await assert.rejects(pending,/unavailable/);assert.equal(seen.aborted,true);const before=next;await assert.rejects(combined.render(actor),/unavailable/);assert.equal(next,before);enabled=false;release();await new Promise(resolve=>setImmediate(resolve));const result=await combined.render(actor);assert.match(result,/one 1/);assert.match(result,/two 2/);
  }
 });

 test('metrics server signals a bounded combined source on scrape timeout',async()=>{
  let entered,release,active=true,seen;const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),combined=new AgentCombinedMetrics({callbackTimeoutMs:5000,maxPendingCallbacks:1,authorize:()=>true,sources:[{render:()=>'',renderWithSignal:async(_actor,signal)=>{if(active){seen=signal;entered();await gate;}return '# TYPE one counter\none 1\n';}}]}),server=createAgentMetricsServer({metrics:combined,timeoutMs:100,maxPending:1,authenticate:()=>actor});try{await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}/metrics`,request=fetch(url);await ready;assert.equal((await request).status,503);assert.equal(seen.aborted,true);assert.equal((await fetch(url)).status,503);active=false;release();await new Promise(resolve=>setImmediate(resolve));assert.equal((await fetch(url)).status,200);}finally{release();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 });

 test('combined metric callback bounds require a valid pair',()=>{
  const config={sources:[{render:()=>''}],authorize:()=>true};for(const invalid of [{callbackTimeoutMs:100},{maxPendingCallbacks:1},{callbackTimeoutMs:99,maxPendingCallbacks:1},{callbackTimeoutMs:100,maxPendingCallbacks:0}])assert.throws(()=>new AgentCombinedMetrics({...config,...invalid}),/Invalid combined metrics configuration/);
 });

test('legacy metric sources keep their one-argument render interface',async()=>{
 let seen=0;const combined=new AgentCombinedMetrics({authorize:()=>true,sources:[{render(...args){seen=args.length;return '# TYPE legacy counter\nlegacy 1\n';}}]});assert.match(await combined.renderWithSignal(actor,new AbortController().signal),/legacy 1/);assert.equal(seen,1);
});


test('built-in metric sources propagate cancellation to optional signal-aware policies',async()=>{
 for(const kind of ['ingress','recovery','runs'])for(const phase of [1,2]){
  const dir=mkdtempSync(join(tmpdir(),'metrics-cancel-')),path=join(dir,'db.sqlite');let runs,source,checks=0,seen,entered;const ready=new Promise(resolve=>entered=resolve),authorizeWithSignal=async(...args)=>{const signal=args.at(-1);if(++checks===phase){seen=signal;entered();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));}return true;};
  try{const options={authorize:()=>{throw Error('legacy callback must not run');},authorizeWithSignal};if(kind==='runs'){runs=new SqliteAgentRuns(path);source=new SqliteAgentRunMetrics(path,{...options,scope:{tenantId:'tenant',agentId:'agent'}});}else source=kind==='ingress'?new AgentIngressMetrics(options):new AgentActionRecoveryMetrics(options);options.authorizeWithSignal=()=>false;const combined=new AgentCombinedMetrics({sources:[source],authorize:()=>true,callbackTimeoutMs:100,maxPendingCallbacks:1}),pending=combined.render(actor);await ready;await assert.rejects(pending,/unavailable/);assert.equal(seen.aborted,true);assert.equal(checks,phase);await assert.rejects(source.renderWithSignal(actor,AbortSignal.abort()),/unavailable/);
  }finally{source?.close?.();runs?.close();rmSync(dir,{recursive:true,force:true});}
 }
});

test('legacy built-in metric policy callbacks keep their argument count',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'metrics-legacy-')),path=join(dir,'db.sqlite');let runs,source;const lengths=[];try{const authorize=(...args)=>{lengths.push(args.length);return true;};runs=new SqliteAgentRuns(path);source=new SqliteAgentRunMetrics(path,{scope:{tenantId:'tenant',agentId:'agent'},authorize});const combined=new AgentCombinedMetrics({sources:[new AgentIngressMetrics({authorize}),new AgentActionRecoveryMetrics({authorize}),source],authorize:()=>true});await combined.render(actor);assert.deepEqual(lengths,[1,1,1,1,2,2]);}finally{source?.close();runs?.close();rmSync(dir,{recursive:true,force:true});}
});
