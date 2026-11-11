// Kubernetes test for scheduling durable-run workers: a replicated Deployment of PostgresRunSupervisor workers
// shares one PostgreSQL run registry. A worker is crashed mid-run and the Deployment is rolled; every run must
// finish with each external effect applied exactly once.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {PostgresAgentRuns,PostgresRunSupervisor} from '../../../../packages/agent/dist/index.js';

const command=process.argv[2],scope={tenantId:'tenant',agentId:'agent'},effects=process.env.TEST_EFFECTS??'http://agent-run-effects:3000';
const connect=()=>{const pool=new pg.Pool({connectionString:process.env.TEST_POSTGRES??'postgresql://appmixer:test-only-password@agent-memory-postgres:5432/appmixer_test',max:8});pool.on('error',()=>{});return pool;};
const registry=pool=>new PostgresAgentRuns({enabled:true,query:(sql,args)=>pool.query(sql,args),transaction:async operation=>{const client=await pool.connect();try{await client.query('BEGIN');const result=await operation((sql,args)=>client.query(sql,args));await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}}});

if(command==='effects'){
 // The external system: applies every request it receives (no deduplication) and replies 300 ms later, so a
 // crashed worker usually dies after the effect was applied but before it learned the result.
 const applied=new Map(),applications=[];
 createServer(async(request,response)=>{
  const path=new URL(request.url,'http://localhost').pathname,json=(status,body)=>response.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify(body));
  if(request.method==='GET'&&path==='/stats')return json(200,{applications});
  const key=decodeURIComponent(path.slice('/effects/'.length));
  if(request.method==='GET')return applied.has(key)?json(200,applied.get(key)):json(404,{});
  let body='';for await(const chunk of request)body+=chunk;const input=JSON.parse(body),effect={applied:true,...input};
  applications.push({key,...input,by:request.headers['x-node']});applied.set(key,effect);
  setTimeout(()=>{if(!response.destroyed)json(200,effect);},300);
 }).listen(3000,'0.0.0.0');
}else if(command==='pod'){
 // PID 1 of a worker container: forwards SIGTERM to the worker and exits with it, so killing the worker process
 // is a crash that the container restart policy recovers, while deleting the pod is a graceful drain.
 const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'worker'],{stdio:'inherit'});writeFileSync('/tmp/worker.pid',String(child.pid));
 process.on('SIGTERM',()=>child.kill('SIGTERM'));child.on('exit',(code,signal)=>{console.log(`worker exited code=${code} signal=${signal}`);process.exit(code??137);});
}else if(command==='worker'){
 const pool=connect(),runs=registry(pool),workerId=process.env.HOSTNAME??'worker';
 const supervisor=new PostgresRunSupervisor({
  runs,scope,workerId,leaseMs:3000,pollMs:200,recoveryGraceMs:2000,maxConcurrent:2,limits:{maxConcurrentRuns:100},
  async execute({run,journal,signal}){
   for(const actionId of ['a1','a2','a3']){signal.throwIfAborted();await journal.invoke(actionId,'effect.apply',{runId:run.runId,actionId},3,async(input,key)=>{const response=await fetch(`${effects}/effects/${key}`,{method:'POST',headers:{'content-type':'application/json','x-node':workerId},body:JSON.stringify(input)});if(!response.ok)throw Error('effect '+response.status);return response.json();});}
   return 'succeeded';
  },
  async verify(request){const response=await fetch(`${effects}/effects/${encodeURIComponent(request.action.idempotencyKey)}`);if(response.status===404)return {outcome:'not_applied'};if(!response.ok)return {outcome:'unknown'};return {outcome:'applied',result:await response.json()};},
  onEvent:event=>console.log(JSON.stringify(event)),onError:error=>console.error('supervisor error',error),
 });
 process.on('SIGTERM',async()=>{console.log('draining');await supervisor.stop();await pool.end();console.log('drained');process.exit(0);});
 supervisor.start();console.log('worker started '+workerId);
}else{
 const pool=connect(),runs=registry(pool);
 try{
  const all=async()=>(await pool.query('SELECT run_id,status,attempts,lease_owner FROM app_mixer_agent_runs WHERE tenant_id=$1 AND agent_id=$2 ORDER BY run_id',[scope.tenantId,scope.agentId])).rows;
  if(command==='setup'){await runs.initialize();// Idempotent: a retry after a partial first attempt skips the runs that already exist instead of failing on them.
   for(let i=1;i<=Number(process.argv[3]);i++)try{await runs.create(scope,'run-'+String(i).padStart(3,'0'),{definitionVersion:1,maxAttempts:3,deadline:Date.now()+3600000});}catch(error){if(!(await runs.get(scope,'run-'+String(i).padStart(3,'0')).catch(()=>undefined)))throw error;}
   const starting=await all();if(starting.length!==Number(process.argv[3])||starting.some(row=>row.status!=='queued'))throw Error('Setup found runs that are not freshly queued');}
  else if(command==='holding'){const owner=process.argv[3];if(!(await all()).some(run=>run.status==='running'&&run.lease_owner===owner))process.exit(1);}
  else if(command==='done'){const rows=await all(),counts={};for(const row of rows)counts[row.status]=(counts[row.status]??0)+1;console.log(JSON.stringify(counts));if(rows.some(row=>row.status!=='succeeded'))process.exit(1);}
  else if(command==='verify'){
   const total=Number(process.argv[3]),rows=await all(),{applications}=await (await fetch(effects+'/stats')).json();
   assert.equal(rows.length,total);assert.ok(rows.every(row=>row.status==='succeeded'),'every run succeeded');
   assert.equal(applications.length,total*3,'no duplicated external effect');
   assert.equal(new Set(applications.map(effect=>effect.runId+'/'+effect.actionId)).size,total*3);assert.equal(new Set(applications.map(effect=>effect.key)).size,total*3);
   const recovered=rows.filter(row=>row.attempts>1).map(row=>row.run_id);assert.ok(recovered.length>=1,'the crashed worker left a run that was recovered');
   const workers=[...new Set(applications.map(effect=>effect.by))];const minimum=Number(process.argv[4]??3);assert.ok(workers.length>=minimum,`effects came from at least ${minimum} worker pods: `+workers.join(','));
   console.log(`Scheduled workers finished ${total} runs with ${applications.length} external effects, each once, across ${workers.length} worker pods; recovered after the crash: ${recovered.join(', ')}.`);
  }else throw Error('Unknown run supervisor command');
 }finally{await pool.end();}
}
