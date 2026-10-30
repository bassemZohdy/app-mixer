import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {PostgresAgentDefinitions} from '../dist/index.js';

const transaction=pool=>async operation=>{const client=await pool.connect();try{await client.query('BEGIN');const result=await operation((sql,args)=>client.query(sql,args));await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}};
const manifest=tenantId=>({manifestVersion:1,tenantId,agentId:'agent',name:'Initial',owner:{kind:'organization',id:'org'},administrators:['admin'],servicePrincipalId:'svc',model:{provider:'local',model:'test'},allowedCapabilities:['lookup'],lifecycle:{enabled:true,maxAttempts:2,runTimeoutMs:60000},quotas:{maxConcurrentRuns:2,maxTokensPerRun:100,maxRunsPerDay:10}});
function killAtBarrier(schema,phase){return new Promise((resolve,reject)=>{const worker=fork(fileURLToPath(new URL('./fixtures/crash-postgres-definitions.mjs',import.meta.url)),[],{env:{...process.env,APP_MIXER_TEST_SCHEMA:schema,APP_MIXER_TEST_PHASE:phase},stdio:['ignore','ignore','pipe','ipc']}),errors=[];let reached=false;const timer=setTimeout(()=>{worker.kill('SIGKILL');reject(Error('Timed out waiting for worker barrier'));},15000);worker.stderr.on('data',chunk=>errors.push(String(chunk)));worker.on('message',message=>{if(message===phase){reached=true;worker.kill('SIGKILL');}else if(message?.error){clearTimeout(timer);worker.kill('SIGKILL');reject(Error(message.error));}});worker.on('error',error=>{clearTimeout(timer);reject(error);});worker.on('exit',(code,signal)=>{clearTimeout(timer);if(!reached||signal!=='SIGKILL')reject(Error(`Worker did not die at ${phase}: code=${code}, signal=${signal}; ${errors.join('')}`));else resolve();});});}

test('PostgreSQL definition versions and audit recover atomically after worker death',{skip:!process.env.APP_MIXER_TEST_POSTGRES_URL,timeout:60000},async()=>{
 const schema='agent_definition_crash_'+randomUUID().replaceAll('-',''),url=process.env.APP_MIXER_TEST_POSTGRES_URL,admin=new pg.Pool({connectionString:url}),pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`}),actor={tenantId:'tenant',principalId:'admin'},other={tenantId:'other',principalId:'admin'};
 try{
  await admin.query(`CREATE SCHEMA "${schema}"`);const store=new PostgresAgentDefinitions({enabled:true,clock:()=>100,authorize:()=>true,query:(sql,args)=>pool.query(sql,args),transaction:transaction(pool)});await store.initialize();await store.save(actor,manifest('tenant'),0);await store.save(other,manifest('other'),0);
  for(const phase of ['before-audit','before-commit']){await killAtBarrier(schema,phase);assert.equal((await store.get(actor,'agent')).manifest.name,'Initial');assert.deepEqual((await store.history(actor,'agent')).items.map(x=>[x.version,x.principalId]),[[1,'admin']]);}
  await killAtBarrier(schema,'after-commit');assert.equal((await store.get(actor,'agent')).manifest.name,'after-commit');assert.deepEqual((await store.history(actor,'agent')).items.map(x=>[x.version,x.principalId]),[[1,'admin'],[2,'worker']]);assert.equal((await store.get(other,'agent')).manifest.name,'Initial');assert.deepEqual((await store.history(other,'agent')).items.map(x=>[x.version,x.principalId]),[[1,'admin']]);
  await assert.rejects(store.save(actor,manifest('tenant'),1),/version conflict/);assert.equal((await store.save(actor,{...manifest('tenant'),name:'Recovered'},2)).version,3);assert.equal((await store.get(actor,'agent',2)).manifest.name,'after-commit');assert.deepEqual((await store.history(actor,'agent')).items.map(x=>x.version),[1,2,3]);
 }finally{await pool.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end();}
});
