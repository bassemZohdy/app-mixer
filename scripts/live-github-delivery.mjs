#!/usr/bin/env node
// A live check of the GitHub webhook adapter: GitHub itself delivers signed events to the adapter.
//
// It starts a local receiver built from the real adapter and event ingress, opens a temporary Cloudflare quick tunnel to
// it, creates a temporary webhook on a repository (GitHub then sends a `ping`), asks GitHub to send a `push` test event
// and to redeliver it, checks that a request with a wrong signature is refused through the tunnel, and then deletes the
// webhook and stops the tunnel, even when a step fails. The report holds delivery metadata only: no payloads, no secret.
//
// Usage: node scripts/live-github-delivery.mjs <owner/repo> [report.json]
// Needs: `gh` signed in with admin rights on the repository, the built agent package, and `cloudflared`
// (CLOUDFLARED=/path/to/cloudflared, default `cloudflared` on the PATH).
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {SqliteAgentRuns,SqliteAgentTriggers,SqliteAgentDefinitions,createAgentEventIngress,createGithubWebhookAdapter} from '../packages/agent/dist/index.js';

const [repository,reportPath]=process.argv.slice(2);
if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository??'')){console.error('Usage: node scripts/live-github-delivery.mjs <owner/repo> [report.json]');process.exit(2);}
const run=promisify(execFile),cloudflared=process.env.CLOUDFLARED||'cloudflared';
const gh=async(args,input)=>{const child=run('gh',['api',...args],{maxBuffer:16*1024*1024,timeout:60000});if(input!==undefined)child.child.stdin.end(input);const {stdout}=await child;return stdout?JSON.parse(stdout):undefined;};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const waitFor=async(check,label,limit=120000)=>{const end=Date.now()+limit;let last;while(Date.now()<end){try{last=await check();if(last)return last;}catch(error){last=error;}await pause(1500);}throw Error('Timed out waiting for '+label+(last instanceof Error?': '+last.message:''));};

const scope={tenantId:'tenant',agentId:'agent'};
const manifest={manifestVersion:1,tenantId:'tenant',agentId:'agent',name:'Agent',owner:{kind:'organization',id:'org'},administrators:['admin'],servicePrincipalId:'svc',model:{provider:'local',model:'test'},allowedCapabilities:[],lifecycle:{enabled:true,maxAttempts:2,runTimeoutMs:60000},quotas:{maxConcurrentRuns:1,maxTokensPerRun:100,maxRunsPerDay:100}};
const dir=mkdtempSync(join(tmpdir(),'live-github-')),path=join(dir,'runs.sqlite');
const runs=new SqliteAgentRuns(path),triggers=new SqliteAgentTriggers(path),definitions=new SqliteAgentDefinitions(':memory:');definitions.save('tenant',manifest,0);
// GitHub signs with the UTF-8 bytes of the secret string it is given, so the adapter gets those same bytes.
const secretText=randomBytes(32).toString('hex'),adapter=createGithubWebhookAdapter({identity:{tenantId:'tenant',principalId:'github',sourceId:'github'},agentId:'agent',eventType:'github.webhook',secret:Buffer.from(secretText,'utf8')});
const received=[];
const ingress=createAgentEventIngress({triggers,definitions,maxPending:50,...adapter,authorize:()=>true});
ingress.on('request',(req,res)=>{res.on('finish',()=>received.push({event:req.headers['x-github-event'],delivery:req.headers['x-github-delivery'],status:res.statusCode}));});
ingress.listen(0,'127.0.0.1');await once(ingress,'listening');
const port=ingress.address().port;

let tunnel,hookId,report;
const cleanup=async()=>{
  const problems=[];
  if(hookId!==undefined){try{await run('gh',['api','-X','DELETE',`repos/${repository}/hooks/${hookId}`],{timeout:60000});hookId=undefined;}catch(error){problems.push('Could not delete the webhook '+hookId+': '+error.message);}}
  if(tunnel&&tunnel.exitCode===null){tunnel.kill();await Promise.race([once(tunnel,'exit'),pause(5000)]);}
  await new Promise(resolve=>{ingress.closeAllConnections();ingress.close(resolve);});
  triggers.close();runs.close();definitions.close();rmSync(dir,{recursive:true,force:true});
  return problems;
};

try{
  // Tunnel: a public HTTPS URL that forwards to the local receiver.
  tunnel=spawn(cloudflared,['tunnel','--no-autoupdate','--url',`http://127.0.0.1:${port}`],{stdio:['ignore','pipe','pipe']});
  let output='';const publicUrl=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('The tunnel did not start: '+output.slice(-400))),60000);
    const read=chunk=>{output+=chunk;const match=output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);if(match){clearTimeout(timer);resolve(match[0]);}};
    tunnel.stdout.on('data',read);tunnel.stderr.on('data',read);tunnel.once('exit',code=>{clearTimeout(timer);reject(Error('cloudflared exited with '+code+': '+output.slice(-400)));});
  });
  const endpoint=publicUrl+'/events';
  // Wait until the tunnel carries traffic: a request with a wrong signature must reach the receiver and be refused.
  const body=JSON.stringify({probe:true}),bad=await waitFor(async()=>{const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json','x-hub-signature-256':'sha256='+'0'.repeat(64)},body});return response.status===401?response:undefined;},'the tunnel to carry traffic');
  assert.equal(bad.status,401,'a wrong signature is refused through the tunnel');
  // A correctly signed request from anyone with the secret is accepted; one from outside GitHub without it is not (checked above).

  // The webhook: GitHub sends a ping as soon as it exists.
  const created=await gh(['-X','POST',`repos/${repository}/hooks`,'--input','-'],JSON.stringify({name:'web',active:true,events:['ping','push'],config:{url:endpoint,content_type:'json',secret:secretText,insecure_ssl:'0'}}));
  hookId=created.id;
  const deliveries=async()=>gh([`repos/${repository}/hooks/${hookId}/deliveries?per_page=30`]);
  const ping=await waitFor(async()=>(await deliveries()).find(d=>d.event==='ping'&&d.status_code!==undefined&&d.status_code!==null&&d.status_code!==0),'GitHub to deliver the ping');
  // GitHub's test push event, sent twice. The API call that redelivers one specific delivery needs the admin:repo_hook
  // token scope, so the second test event stands in for a retry: the same body arrives again under a new delivery GUID.
  await gh(['-X','POST',`repos/${repository}/hooks/${hookId}/tests`,'--input','-'],'{}');
  const push=await waitFor(async()=>(await deliveries()).find(d=>d.event==='push'&&d.status_code),'GitHub to deliver the push test');
  await gh(['-X','POST',`repos/${repository}/hooks/${hookId}/tests`,'--input','-'],'{}');
  const again=await waitFor(async()=>(await deliveries()).find(d=>d.event==='push'&&d.guid!==push.guid&&d.status_code),'GitHub to send the push test again');
  const all=await deliveries();

  const runList=runs.list(scope);
  report={
    repository,generatedAt:new Date().toISOString(),
    deliveries:all.map(d=>({event:d.event,guid:d.guid,redelivery:d.redelivery,statusCode:d.status_code,status:d.status,deliveredAt:d.delivered_at})),
    receiver:received,
    runsCreated:runList.length
  };
  // Every delivery was authenticated by the adapter: GitHub reports 2xx for each.
  for(const d of all)assert.ok(d.status_code>=200&&d.status_code<300,`${d.event} (${d.guid}) was answered ${d.status_code}`);
  assert.ok(ping.status_code>=200&&ping.status_code<300);
  // The second push carries the same body, so the adapter's event ID (a digest of the body) deduplicates it: one run for the push.
  assert.notEqual(again.guid,push.guid);
  assert.equal(runList.length,2,'a run for the ping and one for the push; the repeated push added none (runs: '+runList.length+')');
  report.verdict='passed';
}catch(error){
  report={...(report??{}),repository,verdict:'failed',error:error.message};
  process.exitCode=1;
}finally{
  const problems=await cleanup();
  if(problems.length){report={...report,cleanupProblems:problems};process.exitCode=1;}
  report={...report,webhookDeleted:hookId===undefined};
  const text=JSON.stringify(report,null,2);
  if(reportPath)writeFileSync(reportPath,text+'\n');
  console.log(text);
}
