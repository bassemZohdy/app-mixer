import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {PostgresAgentMemory} from '../dist/index.js';
const actor={tenantId:'tenant',principalId:'worker'},scope={tenantId:'tenant',agentId:'agent',owner:{kind:'organization',id:'org'},kind:'semantic'};
const transaction=pool=>async operation=>{const client=await pool.connect();try{await client.query('BEGIN');const result=await operation((sql,args)=>client.query(sql,args));await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}};
function killAtBarrier(schema,phase,operation='write'){return new Promise((resolve,reject)=>{const worker=fork(fileURLToPath(new URL('./fixtures/crash-postgres-memory.mjs',import.meta.url)),[],{env:{...process.env,APP_MIXER_TEST_SCHEMA:schema,APP_MIXER_TEST_PHASE:phase,APP_MIXER_TEST_OPERATION:operation},stdio:['ignore','ignore','pipe','ipc']}),errors=[];let reached=false;const timer=setTimeout(()=>{worker.kill('SIGKILL');reject(Error('Timed out waiting for worker barrier'));},15000);worker.stderr.on('data',chunk=>errors.push(String(chunk)));worker.on('message',message=>{if(message===phase){reached=true;worker.kill('SIGKILL');}else if(message?.error){clearTimeout(timer);worker.kill('SIGKILL');reject(Error(message.error));}});worker.on('error',error=>{clearTimeout(timer);reject(error);});worker.on('exit',()=>{clearTimeout(timer);if(!reached)reject(Error('Worker exited before barrier: '+errors.join('')));else resolve();});});}

test('PostgreSQL memory survives worker termination before and after commit',{skip:!process.env.APP_MIXER_TEST_POSTGRES_URL,timeout:60000},async()=>{
 const schema='app_mixer_crash_'+randomUUID().replaceAll('-',''),url=process.env.APP_MIXER_TEST_POSTGRES_URL,admin=new pg.Pool({connectionString:url}),pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
 try{await admin.query(`CREATE SCHEMA "${schema}"`);const memory=new PostgresAgentMemory({enabled:true,audit:true,maxEntries:10,maxTtlMs:10000,clock:()=>100,authorize:()=>true,query:(sql,args)=>pool.query(sql,args),transaction:transaction(pool)});await memory.initialize();await killAtBarrier(schema,'before-commit');assert.equal(await memory.get(actor,scope,'before-commit'),undefined);assert.deepEqual((await memory.auditHistory(actor,scope)).items,[]);await killAtBarrier(schema,'after-commit');assert.deepEqual((await memory.get(actor,scope,'after-commit')).value,{phase:'after-commit'});const history=(await memory.auditHistory(actor,scope)).items;assert.deepEqual(history.map(x=>[x.actorId,x.action,x.memoryId,x.revision]),[['worker','write','after-commit',1]]);assert.equal(await memory.get({...actor,tenantId:'other'},{...scope,tenantId:'other'},'after-commit'),undefined);await assert.rejects(memory.put(actor,scope,'after-commit',{again:true},{expectedRevision:null,expiresAt:500,provenance:{kind:'run',id:'run'}}),/revision conflict/);assert.equal((await memory.auditHistory(actor,scope)).items.length,1);
 }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});


test('PostgreSQL scope erasure and audit recover atomically after worker termination',{skip:!process.env.APP_MIXER_TEST_POSTGRES_URL,timeout:60000},async()=>{
 const schema='app_mixer_erase_crash_'+randomUUID().replaceAll('-',''),url=process.env.APP_MIXER_TEST_POSTGRES_URL,admin=new pg.Pool({connectionString:url}),pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
 try{await admin.query(`CREATE SCHEMA "${schema}"`);const memory=new PostgresAgentMemory({enabled:true,audit:true,maxEntries:10,maxTtlMs:10000,clock:()=>100,authorize:()=>true,query:(sql,args)=>pool.query(sql,args),transaction:transaction(pool)});await memory.initialize();
  const otherActor={...actor,tenantId:'other'},otherScope={...scope,tenantId:'other'},opts={expectedRevision:null,expiresAt:500,provenance:{kind:'run',id:'run'}};
  await memory.put(actor,scope,'a',{secret:'a'},opts);await memory.put(actor,scope,'b',{secret:'b'},opts);await memory.put(otherActor,otherScope,'a','other tenant',opts);
  for(const phase of ['after-mutation','before-commit']){await killAtBarrier(schema,phase,'erase');assert.deepEqual((await memory.list(actor,scope)).items.map(x=>x.id),['a','b']);assert.deepEqual((await memory.auditHistory(actor,scope)).items.map(x=>x.action),['write','write']);}
  await killAtBarrier(schema,'after-commit','erase');assert.deepEqual((await memory.list(actor,scope)).items,[]);assert.equal((await memory.get(otherActor,otherScope,'a')).value,'other tenant');
  const rows=(await pool.query("SELECT value,provenance,deleted,revision FROM app_mixer_agent_memories WHERE tenant_id='tenant' ORDER BY memory_id")).rows;for(const row of rows){assert.equal(row.value,null);assert.equal(row.provenance,null);assert.equal(row.deleted,true);assert.equal(Number(row.revision),2);}
  const history=(await memory.auditHistory(actor,scope)).items;assert.deepEqual(history.map(x=>x.action),['write','write','erase']);assert.equal(history[2].count,2);assert.equal(history[2].memoryId,null);assert.equal(await memory.eraseScope(actor,scope),0);assert.equal((await memory.auditHistory(actor,scope)).items.length,3);assert.equal((await memory.put(actor,scope,'a','new',opts)).revision,3);
 }finally{await pool.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end();}
});
