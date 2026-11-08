#!/usr/bin/env node
// Throughput and latency of the PostgreSQL-backed stores on the request path.
//
// Usage: APP_MIXER_TEST_POSTGRES_URL=postgresql://... node scripts/bench-postgres.mjs [seconds=5]
// BENCH_HISTORY=n sets how many finished runs one agent already has in the last row (default 50000, 0 skips it).
//
// Reports, at several levels of concurrency: the revocation lookup that runs on every JWT-protected Data Plane request,
// and the capability audit append, whose sequence numbers come from one counter row per tenant (so appends for one
// tenant serialize while appends for different tenants do not), and a whole durable run's life (create, claim with a lease, settle)
// by competing workers. It uses a throwaway schema. A database on the same
// machine over loopback is the best case: add the network round trip and the database's commit latency to the figures.
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {PostgresJwtRevocations,PostgresCapabilityAudit} from '../packages/core/dist/index.js';
import {PostgresAgentRuns} from '../packages/agent/dist/index.js';

const url=process.env.APP_MIXER_TEST_POSTGRES_URL,seconds=Number(process.argv[2]??5);
if(!url||!Number.isFinite(seconds)||seconds<1||seconds>300){console.error('Usage: APP_MIXER_TEST_POSTGRES_URL=postgresql://... node scripts/bench-postgres.mjs [seconds=5]');process.exit(2);}
const schema='bench_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:url,max:1});
await admin.query(`CREATE SCHEMA "${schema}"`);
const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:64});
const query=(sql,args)=>pool.query(sql,args);

async function run(label,concurrency,operation){
  const latencies=[],end=performance.now()+seconds*1000;let errors=0,counter=0;const reasons=new Map();
  await Promise.all(Array.from({length:concurrency},async(_,worker)=>{while(performance.now()<end){const began=performance.now();try{await operation(worker,counter++);latencies.push(performance.now()-began);}catch(error){errors++;const text=String(error?.code??error?.message??error).slice(0,80);reasons.set(text,(reasons.get(text)??0)+1);}}}));
  latencies.sort((a,b)=>a-b);const at=q=>latencies[Math.min(latencies.length-1,Math.floor(latencies.length*q))]??0;
  return {label,concurrency,ops:latencies.length/seconds,p50:at(0.5),p95:at(0.95),p99:at(0.99),max:latencies.at(-1)??0,errors,reasons:[...reasons].map(([text,count])=>`${count}x ${text}`).join('; ')};
}

const rows=[];
try{
  const issuer='https://issuer.example/',revocations=new PostgresJwtRevocations({issuer,query});await revocations.initialize();
  for(let i=0;i<1000;i++)await revocations.revoke('revoked-'+i,Date.now()+3600_000);
  for(const concurrency of [1,16,64])rows.push(await run('revocation lookup (token not revoked)',concurrency,(_,n)=>revocations.isTokenActive({iss:issuer,jti:'token-'+n})));
  rows.push(await run('revocation lookup (token revoked)',16,(_,n)=>revocations.isTokenActive({iss:issuer,jti:'revoked-'+(n%1000)})));

  const audit=new PostgresCapabilityAudit({query});await audit.initialize();
  const event=(tenantId,n)=>({invocationId:'i-'+n,operationId:'customer.read',tenantId,principalId:'alice',outcome:'succeeded'});
  for(const concurrency of [1,16,64])rows.push(await run('audit append, one tenant',concurrency,(_,n)=>audit.record(event('tenant-one',n))));
  for(const concurrency of [16,64])rows.push(await run('audit append, 16 tenants',concurrency,(worker,n)=>audit.record(event('tenant-'+(worker%16),n))));

  const transaction=async operation=>{const client=await pool.connect();try{await client.query('BEGIN');const result=await operation((sql,args)=>client.query(sql,args));await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}};
  const runs=new PostgresAgentRuns({enabled:true,query,transaction});await runs.initialize();
  const deadline=Date.now()+3600_000,config={definitionVersion:1,maxAttempts:2,deadline};
  let series=0;
  const lifecycle=(agents,prefix)=>async(worker,n)=>{const scope={tenantId:'tenant',agentId:prefix+(worker%agents)},id=`run-${series}-${worker}-${n}`;const created=await runs.create(scope,id,config);const claimed=await runs.claim(scope,id,created.revision,'worker-'+worker,60000,{maxConcurrentRuns:100});await runs.settle(scope,id,claimed.revision,claimed.leaseToken,'succeeded');};
  for(const concurrency of [1,8,32]){series++;rows.push(await run('run lifecycle (create, claim, settle), one agent',concurrency,lifecycle(1,'fresh-')));}
  for(const concurrency of [8,32]){series++;rows.push(await run('run lifecycle (create, claim, settle), 8 agents',concurrency,lifecycle(8,'many-')));}
  // The same lifecycle for an agent that already has a long history of finished runs.
  const history=Number(process.env.BENCH_HISTORY??50000);
  if(history>0){
    await pool.query("INSERT INTO app_mixer_agent_runs (tenant_id,agent_id,run_id,definition_version,revision,status,attempts,max_attempts,deadline) SELECT 'tenant','old-agent-0','old-'||g,1,3,'succeeded',1,2,9999999999999 FROM generate_series(1,$1) g",[history]);
    // Settle the database after the bulk insert (statistics, visibility map, checkpoint) so the row measures the lifecycle, not the load.
    await admin.query('CHECKPOINT').catch(()=>{});await pool.query('VACUUM ANALYZE app_mixer_agent_runs');
    series++;rows.push(await run(`run lifecycle, one agent with ${history} finished runs`,8,lifecycle(1,'old-agent-')));
  }

  const version=(await admin.query('show server_version')).rows[0].server_version,sync=(await admin.query('show synchronous_commit')).rows[0].synchronous_commit,fsync=(await admin.query('show fsync')).rows[0].fsync;
  console.log(`\nPostgreSQL ${version} (synchronous_commit ${sync}, fsync ${fsync}), ${seconds} s per row, Node ${process.version}, ${process.platform} ${process.arch}\n`);
  console.log('| Operation | Concurrency | ops/s | p50 ms | p95 ms | p99 ms | max ms | errors |');
  console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for(const r of rows.filter(r=>r.errors))console.log(`errors in "${r.label}" at ${r.concurrency}: ${r.reasons}`);
  for(const r of rows)console.log(`| ${r.label} | ${r.concurrency} | ${Math.round(r.ops)} | ${r.p50.toFixed(2)} | ${r.p95.toFixed(2)} | ${r.p99.toFixed(2)} | ${r.max.toFixed(0)} | ${r.errors} |`);
}finally{await pool.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(()=>{});await admin.end();}
