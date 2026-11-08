#!/usr/bin/env node
// Throughput and latency of the PostgreSQL-backed stores on the request path.
//
// Usage: APP_MIXER_TEST_POSTGRES_URL=postgresql://... node scripts/bench-postgres.mjs [seconds=5]
//
// Reports, at several levels of concurrency: the revocation lookup that runs on every JWT-protected Data Plane request,
// and the capability audit append, whose sequence numbers come from one counter row per tenant (so appends for one
// tenant serialize while appends for different tenants do not). It uses a throwaway schema. A database on the same
// machine over loopback is the best case: add the network round trip and the database's commit latency to the figures.
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {PostgresJwtRevocations,PostgresCapabilityAudit} from '../packages/core/dist/index.js';

const url=process.env.APP_MIXER_TEST_POSTGRES_URL,seconds=Number(process.argv[2]??5);
if(!url||!Number.isFinite(seconds)||seconds<1||seconds>300){console.error('Usage: APP_MIXER_TEST_POSTGRES_URL=postgresql://... node scripts/bench-postgres.mjs [seconds=5]');process.exit(2);}
const schema='bench_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:url,max:1});
await admin.query(`CREATE SCHEMA "${schema}"`);
const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:64});
const query=(sql,args)=>pool.query(sql,args);

async function run(label,concurrency,operation){
  const latencies=[],end=performance.now()+seconds*1000;let errors=0,counter=0;
  await Promise.all(Array.from({length:concurrency},async(_,worker)=>{while(performance.now()<end){const began=performance.now();try{await operation(worker,counter++);latencies.push(performance.now()-began);}catch{errors++;}}}));
  latencies.sort((a,b)=>a-b);const at=q=>latencies[Math.min(latencies.length-1,Math.floor(latencies.length*q))]??0;
  return {label,concurrency,ops:latencies.length/seconds,p50:at(0.5),p95:at(0.95),p99:at(0.99),max:latencies.at(-1)??0,errors};
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

  const version=(await admin.query('show server_version')).rows[0].server_version,sync=(await admin.query('show synchronous_commit')).rows[0].synchronous_commit,fsync=(await admin.query('show fsync')).rows[0].fsync;
  console.log(`\nPostgreSQL ${version} (synchronous_commit ${sync}, fsync ${fsync}), ${seconds} s per row, Node ${process.version}, ${process.platform} ${process.arch}\n`);
  console.log('| Operation | Concurrency | ops/s | p50 ms | p95 ms | p99 ms | max ms | errors |');
  console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for(const r of rows)console.log(`| ${r.label} | ${r.concurrency} | ${Math.round(r.ops)} | ${r.p50.toFixed(2)} | ${r.p95.toFixed(2)} | ${r.p99.toFixed(2)} | ${r.max.toFixed(0)} | ${r.errors} |`);
}finally{await pool.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(()=>{});await admin.end();}
