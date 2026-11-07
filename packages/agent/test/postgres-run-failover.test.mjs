// Two run workers keep working through a PostgreSQL primary failover. The primary is killed while they hold runs, a synchronous
// standby is promoted behind the same address, and every run must still finish with each external effect applied exactly once.
// Opt-in: APP_MIXER_TEST_POSTGRES_FAILOVER=docker (a primary and a standby container).
import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {PostgresAgentRuns} from '../dist/index.js';
import {startCluster} from './fixtures/postgres-cluster.mjs';

const enabled=process.env.APP_MIXER_TEST_POSTGRES_FAILOVER==='docker',nodePath=fileURLToPath(new URL('./fixtures/run-node.mjs',import.meta.url));
const scope={tenantId:'tenant',agentId:'agent'};
const transaction=pool=>async operation=>{const client=await pool.connect();try{await client.query('BEGIN');const result=await operation((sql,args)=>client.query(sql,args));await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}};

test('run workers finish every run with each effect applied once across a PostgreSQL primary failover',{skip:!enabled&&'set APP_MIXER_TEST_POSTGRES_FAILOVER=docker to run',timeout:420000},async t=>{
 const cluster=await startCluster(),schema='run_failover_'+randomUUID().replaceAll('-',''),nodes=new Map(),events=[],applications=[],effects=new Map();let pools=[];
 // The external system applies every POST it receives (no deduplication), so a replayed action would show twice.
 const server=createServer(async(request,response)=>{
  const key=decodeURIComponent(request.url.slice('/effects/'.length));
  if(request.method==='GET'){const effect=effects.get(key);response.writeHead(effect?200:404,{'content-type':'application/json'}).end(JSON.stringify(effect??{}));return;}
  let body='';for await(const chunk of request)body+=chunk;const input=JSON.parse(body),effect={applied:true,runId:input.runId,actionId:input.actionId};
  applications.push({key,node:request.headers['x-node'],...input});effects.set(key,effect);
  setTimeout(()=>{if(!response.destroyed)response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(effect));},150);
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');const effectsUrl=`http://127.0.0.1:${server.address().port}`;
 const connect=()=>{const pool=new pg.Pool({connectionString:cluster.url,options:`-c search_path=${schema}`,max:4,connectionTimeoutMillis:3000});pool.on('error',()=>{});pools.push(pool);return pool;};
 const start=(nodeId)=>{const child=fork(nodePath,[cluster.url,schema,nodeId,effectsUrl,'2'],{stdio:['ignore','inherit','inherit','ipc']});nodes.set(nodeId,child);child.on('message',message=>events.push({nodeId,...message}));return new Promise((resolve,reject)=>{child.on('message',message=>{if(message.type==='ready')resolve();});child.once('exit',code=>reject(Error(nodeId+' exited '+code)));});};
 try{
  const admin=new pg.Pool({connectionString:cluster.url});pools.push(admin);admin.on('error',()=>{});await admin.query(`CREATE SCHEMA "${schema}"`);
  let pool=connect();const runs=new PostgresAgentRuns({enabled:true,query:(sql,args)=>pool.query(sql,args),transaction:transaction(pool)});await runs.initialize();
  const ids=Array.from({length:16},(_,i)=>'run-'+String(i+1).padStart(2,'0'));for(const runId of ids)await runs.create(scope,runId,{definitionVersion:1,maxAttempts:10,deadline:Date.now()+900000});
  await Promise.all([start('node-a'),start('node-b')]);
  for(const deadline=Date.now()+60000;applications.length<8;await delay(50))assert.ok(Date.now()<deadline,'workers started applying effects');
  const beforeKill=applications.length;await cluster.killPrimary();const killed=Date.now();
  await delay(4000);await cluster.promote();t.diagnostic(`killed the primary after ${beforeKill} effects; standby promoted ${((Date.now()-killed)/1000).toFixed(1)} s later`);
  pool=connect();const reader=new PostgresAgentRuns({enabled:true,query:(sql,args)=>pool.query(sql,args),transaction:transaction(pool)});
  let rows;for(const deadline=Date.now()+180000;;await delay(500)){
   try{rows=await Promise.all(ids.map(runId=>reader.get(scope,runId)));if(rows.every(run=>run.status==='succeeded'))break;}catch{}
   assert.ok(Date.now()<deadline,'every run finished after the failover: '+(rows?rows.map(run=>run.runId+'='+run.status).join(' '):'database unreachable'));
  }
  t.diagnostic(`all ${ids.length} runs succeeded; attempts per run: ${rows.map(run=>run.attempts).join(',')}; ${events.filter(event=>event.type==='error').length} worker errors reported during the outage`);
  assert.equal(applications.length,ids.length*3,'no duplicated and no missing external effect');
  assert.equal(new Set(applications.map(effect=>effect.runId+'/'+effect.actionId)).size,ids.length*3);
  assert.equal(new Set(applications.map(effect=>effect.key)).size,ids.length*3);
  for(const nodeId of ['node-a','node-b']){const child=nodes.get(nodeId);assert.equal(child.exitCode,null,nodeId+' survived the failover');}
  for(const nodeId of ['node-a','node-b']){const child=nodes.get(nodeId),gone=once(child,'exit');child.send('stop');const [code]=await gone;assert.equal(code,0,nodeId+' stopped cleanly');}
 }finally{
  for(const child of nodes.values())if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
  server.closeAllConnections();server.close();
  for(const pool of pools)await pool.end().catch(()=>{});
  await cluster.cleanup();
 }
});
