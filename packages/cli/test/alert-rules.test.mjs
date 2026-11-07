// Keeps deploy/observability/prometheus-alerts.yml honest: every alert must use metrics and label values the product
// emits and must have a runbook. With APP_MIXER_TEST_PROMETHEUS=docker, a real Prometheus also loads the rules,
// scrapes the real metrics servers and must fire and resolve alerts in a failure drill.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {DataPlaneRequestMetrics,createMetricsServer} from '../../core/dist/index.js';
import {SqliteAgentRuns,SqliteAgentTriggers,SqliteAgentSchedules,SqliteAgentActionJournal,SqliteAgentRunMetrics,createAgentMetricsServer} from '../../agent/dist/index.js';

const run=promisify(execFile);
const ALERTMANAGER_IMAGE='prom/alertmanager:v0.34.1@sha256:e9733bafb1bdef9b00e25a21f8f99dc26a22224bf16641ad754d1649f4c3357a';
const routingPath=new URL('../../../deploy/observability/alertmanager-example.yml',import.meta.url);
const PROMETHEUS_IMAGE='prom/prometheus:v3.15.1@sha256:fa3302279710be2f21a8301ec17a8b4f2301fd829bd113839b3b6b02b6f191a2';
const rulesPath=new URL('../../../deploy/observability/prometheus-alerts.yml',import.meta.url),runbooksPath=new URL('../../../docs/runbooks.md',import.meta.url);
const scope={tenantId:'tenant',agentId:'agent'},actor={tenantId:'tenant',principalId:'scraper'};

// The rules file is plain YAML in a fixed shape; read the fields the checks need without a YAML dependency.
function parseRules(text){const alerts=[];let current;for(const line of text.split('\n')){let match;
 if((match=/^ {6}- alert: (\S+)\s*$/.exec(line)))alerts.push(current={name:match[1]});
 else if(current&&(match=/^ {8}(expr|for): (.+?)\s*$/.exec(line)))current[match[1]]=match[2];
 else if(current&&(match=/^ {10}(severity|summary|runbook): (.+?)\s*$/.exec(line)))current[match[1]]=match[2];}
 return alerts;}
// Every series the product can emit, with the label values each one takes.
function exposition(...texts){const series=new Map();for(const text of texts)for(const line of text.split('\n')){if(!line||line.startsWith('#'))continue;const match=/^([a-z_]+)(?:\{([^}]*)\})? /.exec(line);assert.ok(match,line);const labels=series.get(match[1])??new Map();series.set(match[1],labels);for(const pair of (match[2]??'').split(',').filter(Boolean)){const [key,value]=pair.split('=');if(!labels.has(key))labels.set(key,new Set());labels.get(key).add(JSON.parse(value));}}return series;}
function seed(path){
 const runs=new SqliteAgentRuns(path),triggers=new SqliteAgentTriggers(path),schedules=new SqliteAgentSchedules(path);
 runs.create(scope,'run',{definitionVersion:1,maxAttempts:2,deadline:100000},0);const claimed=runs.claim(scope,'run',runs.get(scope,'run').revision,'worker',60000,0);
 new SqliteAgentActionJournal(path,{scope,runId:'run',leaseToken:claimed.leaseToken,clock:()=>0}).close();
 schedules.save(scope,'nightly',{enabled:true,principalId:'scheduler',rule:{kind:'interval',intervalMs:60000},misfire:'coalesce'},0,0);
 return {runs,schedules,close(){schedules.close();triggers.close();runs.close();}};
}
const insertAction=(path,actionId,status)=>{const db=new DatabaseSync(path);try{db.prepare('INSERT INTO agent_action_journal (tenant_id,agent_id,run_id,action_id,operation_id,input_json,input_hash,idempotency_key,status,attempts,max_attempts,result_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)').run(scope.tenantId,scope.agentId,'run',actionId,'operation','{}','hash','key:'+actionId,status,1,2);}finally{db.close();}};
const routes=['application','version','live','ready','other'],statuses=['2xx','3xx','4xx','5xx','other'];

test('alert rules use only emitted metrics and label values and each has a runbook',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'alert-rules-')),path=join(dir,'runs.sqlite');let metrics,store;
 try{
  const plane=new DataPlaneRequestMetrics(()=>0);plane.setPublicationVersion(1);for(const route of routes){for(const statusClass of statuses)plane.observe({route,outcome:'completed',statusClass,durationMs:1});plane.observe({route,outcome:'aborted',statusClass:'none',durationMs:1});}
  store=seed(path);metrics=new SqliteAgentRunMetrics(path,{scope,authorize:()=>true,includeOperational:true,includeSchedules:true,includeActions:true,clock:()=>0});
  const series=exposition(plane.render(),await metrics.render(actor)),alerts=parseRules(await readFile(rulesPath,'utf8'));
  assert.ok(alerts.length>=10);assert.equal(new Set(alerts.map(a=>a.name)).size,alerts.length);
  const headings=[...(await readFile(runbooksPath,'utf8')).matchAll(/^## (\S+)\s*$/gm)].map(m=>m[1]);assert.deepEqual([...headings].sort(),alerts.map(a=>a.name).sort(),'one runbook section per alert');
  for(const alert of alerts){
   assert.ok(alert.expr&&alert.for&&alert.summary,alert.name);assert.match(alert.severity,/^(page|ticket)$/,alert.name);assert.equal(alert.runbook,'docs/runbooks.md#'+alert.name.toLowerCase(),alert.name);
   for(const [,name,matchers] of alert.expr.matchAll(/\b(app_mixer_[a-z_]+)(?:\{([^}]*)\})?/g)){
    assert.ok(series.has(name),alert.name+' uses '+name+' which is never emitted');
    for(const [,key,op,value] of (matchers??'').matchAll(/([a-z_]+)(=~|!=|=)"([^"]*)"/g)){assert.equal(op,'=',alert.name+': only exact matchers are checked');assert.ok(series.get(name).get(key)?.has(value),`${alert.name}: ${name}{${key}="${value}"} is never emitted`);}
   }
  }
 }finally{metrics?.close();store?.close();try{rmSync(dir,{recursive:true,force:true});}catch{}}
});

const enabled=process.env.APP_MIXER_TEST_PROMETHEUS==='docker';
const freePort=async()=>{const {createServer}=await import('node:net'),probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const {port}=probe.address();await new Promise(resolve=>probe.close(resolve));return port;};
const wait=async(predicate,label,limit=60000)=>{const end=Date.now()+limit;let last;while(Date.now()<end){try{if((last=await predicate())===true)return;}catch(error){last=error;}await new Promise(resolve=>setTimeout(resolve,500));}throw Error('Timed out waiting for '+label+(last&&last!==false?': '+(last.message??last):''));};

test('a failure drill fires, routes and resolves alerts through real Prometheus and Alertmanager',{skip:enabled?false:'set APP_MIXER_TEST_PROMETHEUS=docker to run against a Prometheus container',timeout:240000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'alert-drill-')),config=join(dir,'config'),path=join(dir,'runs.sqlite'),name='app-mixer-prom-'+process.pid+'-'+Date.now(),amName=name.replace('-prom-','-am-'),token='scrape-token-local-test-only';
 await mkdir(config);const linux=process.platform==='linux';const containers=[],servers=[],delivered=[];let metrics,store;
 try{
  // The drill shortens every for: so it runs in seconds; thresholds and expressions are the shipped ones.
  const rules=(await readFile(rulesPath,'utf8')).replace(/^( {8}for: ).+$/gm,'$10s');await writeFile(join(config,'alerts.yml'),rules);
  await run('docker',['run','--rm','-v',config+':/rules:ro','--entrypoint','promtool',PROMETHEUS_IMAGE,'check','rules','/rules/alerts.yml']);

  // Stand-ins for the paging and ticketing integrations: they record every Alertmanager webhook delivery.
  const receiver=createServer((req,res)=>{let body='';req.on('data',part=>body+=part);req.on('end',()=>{try{delivered.push({path:req.url,...JSON.parse(body)});}catch{}res.end();});});
  receiver.listen(0,'127.0.0.1');await once(receiver,'listening');servers.push(receiver);
  const host=linux?'127.0.0.1':'host.docker.internal',hook=route=>`http://${host}:${receiver.address().port}/${route}`;
  // The shipped routing tree with its receivers pointed here and its timings shortened for the drill.
  const routing=(await readFile(routingPath,'utf8')).replace('https://paging.example.invalid/app-mixer',hook('page')).replace('https://tickets.example.invalid/app-mixer',hook('ticket')).replace(/^( +group_wait: ).+$/m,'$11s').replace(/^( +group_interval: ).+$/m,'$11s');
  assert.ok(routing.includes(hook('page'))&&routing.includes(hook('ticket')));await writeFile(join(config,'alertmanager.yml'),routing);
  await run('docker',['run','--rm','-v',config+':/rules:ro','--entrypoint','amtool',ALERTMANAGER_IMAGE,'check-config','/rules/alertmanager.yml']);
  const user=typeof process.getuid==='function'?['--user',process.getuid()+':'+process.getgid()]:[],amPort=linux?await freePort():9093;
  await run('docker',['run','-d','--rm','--name',amName,...user,...(linux?['--network','host']:['-p','127.0.0.1::9093']),'-v',config+':/rules:ro',ALERTMANAGER_IMAGE,'--config.file=/rules/alertmanager.yml','--storage.path=/tmp/alertmanager','--cluster.listen-address=','--web.listen-address=:'+amPort]);containers.push(amName);
  const amHostPort=linux?amPort:(await run('docker',['port',amName,'9093/tcp'])).stdout.trim().split('\n')[0].split(':').pop();
  const deliveries=(route,alertname,status)=>delivered.filter(d=>d.path==='/'+route&&d.alerts.some(a=>a.labels.alertname===alertname&&a.status===status));

  let now=30000;const plane=new DataPlaneRequestMetrics(()=>0);plane.setPublicationVersion(4);plane.observe({route:'application',outcome:'completed',statusClass:'2xx',durationMs:3});
  store=seed(path);metrics=new SqliteAgentRunMetrics(path,{scope,authorize:()=>true,includeOperational:true,includeSchedules:true,includeActions:true,clock:()=>now});
  const bearer=req=>req.headers.authorization===`Bearer ${token}`;
  const planeServer=createMetricsServer({metrics:plane,authorize:bearer,timeoutMs:2000,maxPending:10}),agentServer=createAgentMetricsServer({metrics,authenticate:req=>bearer(req)?actor:undefined,timeoutMs:2000,maxPending:10});
  for(const server of [planeServer,agentServer]){server.listen(0,'127.0.0.1');await once(server,'listening');servers.push(server);}
  // Linux shares the host network so Prometheus reaches loopback; Docker Desktop forwards host.docker.internal to it.
  const target=server=>`'${host}:${server.address().port}'`;
  const job=(jobName,server)=>`  - job_name: ${jobName}\n    scrape_interval: 1s\n    authorization:\n      credentials: ${token}\n    static_configs:\n      - targets: [${target(server)}]\n`;
  await writeFile(join(config,'prometheus.yml'),`global:\n  scrape_interval: 1s\n  evaluation_interval: 1s\nalerting:\n  alertmanagers:\n    - static_configs:\n        - targets: ['${host}:${amHostPort}']\nrule_files:\n  - /rules/alerts.yml\nscrape_configs:\n${job('app-mixer-data-plane',planeServer)}${job('app-mixer-agent',agentServer)}`);
  const promPort=linux?await freePort():9090;
  await run('docker',['run','-d','--rm','--name',name,...user,...(linux?['--network','host']:['-p','127.0.0.1::9090']),'-v',config+':/rules:ro',PROMETHEUS_IMAGE,'--config.file=/rules/prometheus.yml','--storage.tsdb.path=/tmp/prometheus','--web.listen-address=:'+promPort]);containers.push(name);
  const api=linux?'http://127.0.0.1:'+promPort:'http://127.0.0.1:'+(await run('docker',['port',name,'9090/tcp'])).stdout.trim().split('\n')[0].split(':').pop();
  const get=async route=>{const response=await fetch(api+route);assert.equal(response.status,200);return (await response.json()).data;};
  const firing=async()=>new Set((await get('/api/v1/alerts')).alerts.filter(a=>a.state==='firing').map(a=>a.labels.alertname));
  const up=async jobName=>(await get('/api/v1/query?query='+encodeURIComponent(`up{job="${jobName}"}`))).result[0]?.value[1];

  // Healthy: both targets scrape and nothing fires.
  await wait(async()=>(await up('app-mixer-data-plane'))==='1'&&(await up('app-mixer-agent'))==='1','both targets to be scraped');
  await new Promise(resolve=>setTimeout(resolve,4000));assert.deepEqual([...await firing()],[],'nothing fires while healthy');

  // Failure: no schedule worker for ten minutes, an action with an unknown outcome, a pod stuck draining.
  now+=10*60000;insertAction(path,'charge','uncertain');plane.setDraining(true);
  const expected=['AppMixerAgentScheduleBacklog','AppMixerAgentActionsUncertain','AppMixerDataPlaneStuckDraining'];
  await wait(async()=>{const set=await firing();return expected.every(a=>set.has(a))||[...set].join(',');},'the drill alerts to fire');
  // Then the Data Plane metrics endpoint goes away entirely.
  planeServer.closeAllConnections();await new Promise(resolve=>planeServer.close(resolve));servers.splice(servers.indexOf(planeServer),1);
  await wait(async()=>(await firing()).has('AppMixerMetricsScrapeFailing'),'the scrape alert to fire');
  if(process.env.APP_MIXER_TEST_ALERT_EXPORT)await writeFile(process.env.APP_MIXER_TEST_ALERT_EXPORT,JSON.stringify(await get('/api/v1/alerts'),null,2));
  const shown=(await get('/api/v1/alerts')).alerts.find(a=>a.labels.alertname==='AppMixerAgentScheduleBacklog');assert.equal(shown.labels.severity,'page');assert.equal(shown.annotations.runbook,'docs/runbooks.md#appmixeragentschedulebacklog');
  // Alertmanager routes pages to on-call and the rest to tickets, carrying the runbook.
  await wait(()=>deliveries('page','AppMixerAgentScheduleBacklog','firing').length>0&&deliveries('ticket','AppMixerAgentActionsUncertain','firing').length>0&&deliveries('page','AppMixerMetricsScrapeFailing','firing').length>0||JSON.stringify(delivered.map(d=>[d.path,d.status,d.alerts.map(a=>a.labels.alertname)])),'Alertmanager to deliver the drill alerts');
  assert.equal(deliveries('page','AppMixerAgentScheduleBacklog','firing')[0].alerts.find(a=>a.labels.alertname==='AppMixerAgentScheduleBacklog').annotations.runbook,'docs/runbooks.md#appmixeragentschedulebacklog');
  assert.equal(deliveries('ticket','AppMixerAgentScheduleBacklog','firing').length,0,'a page is not also ticketed');assert.equal(deliveries('page','AppMixerAgentActionsUncertain','firing').length,0,'a ticket does not page');

  // Recovery: the worker catches up and the action is reconciled, so those alerts resolve.
  const schedule=store.schedules.get(scope,'nightly');store.schedules.fire(scope,'nightly',schedule.revision,{definitionVersion:1,maxAttempts:1,runTimeoutMs:10000,maxPending:100},now);
  const db=new DatabaseSync(path);try{db.prepare("UPDATE agent_action_journal SET status='failed' WHERE action_id='charge'").run();}finally{db.close();}
  await wait(async()=>{const set=await firing();return (!set.has('AppMixerAgentScheduleBacklog')&&!set.has('AppMixerAgentActionsUncertain'))||[...set].join(',');},'the recovered alerts to resolve');
  await wait(()=>deliveries('page','AppMixerAgentScheduleBacklog','resolved').length>0&&deliveries('ticket','AppMixerAgentActionsUncertain','resolved').length>0,'Alertmanager to send the resolved notices');
  if(process.env.APP_MIXER_TEST_ALERT_EXPORT)await writeFile(process.env.APP_MIXER_TEST_ALERT_EXPORT.replace(/(\.json)?$/,'-deliveries.json'),JSON.stringify(delivered,null,2));
 }finally{
  for(const container of containers)await run('docker',['rm','-fv',container]).catch(()=>{});
  for(const server of servers){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  metrics?.close();store?.close();await rm(dir,{recursive:true,force:true}).catch(()=>{});
 }
});
