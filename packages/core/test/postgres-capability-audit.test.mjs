import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {CapabilityRegistry,PostgresCapabilityAudit} from '../dist/index.js';

test('shared audit rejects invalid events and blocks capability execution on database failure',async()=>{
 let calls=0;const sink=new PostgresCapabilityAudit({clock:()=>1,query:async()=>{throw Error('database unavailable')}}),registry=new CapabilityRegistry(sink.record);registry.register({operationId:'write',method:'POST',path:'/write'},{authorize:()=>true,validate:()=>true,execute:()=>++calls});await assert.rejects(registry.invoke('write',{}, {tenantId:'tenant',principalId:'user',origin:'ui'}),/database unavailable/);assert.equal(calls,0);await assert.rejects(sink.record({invocationId:'id',operationId:'op',tenantId:'tenant',principalId:'user',outcome:'unknown'}),/Invalid capability audit event/);await assert.rejects(sink.list('tenant',{limit:1001}),/Invalid capability audit query/);
});

test('shared PostgreSQL audit maintains tenant order and does not skip concurrent commits',{skip:!process.env.APP_MIXER_TEST_POSTGRES_URL,timeout:30000},async()=>{
 const url=process.env.APP_MIXER_TEST_POSTGRES_URL,schema='app_mixer_audit_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:url}),a=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`}),b=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});let locked;
 try{
  await admin.query(`CREATE SCHEMA "${schema}"`);const first=new PostgresCapabilityAudit({clock:()=>123,query:(sql,args)=>a.query(sql,args)}),second=new PostgresCapabilityAudit({clock:()=>123,query:(sql,args)=>b.query(sql,args)});await first.initialize();
  const event={invocationId:'held',operationId:'write',tenantId:'tenant',principalId:'user',outcome:'attempt'};locked=await a.connect();await locked.query('BEGIN');const held=new PostgresCapabilityAudit({clock:()=>123,query:(sql,args)=>locked.query(sql,args)});await held.record(event);let finished=false;const pending=second.record({...event,invocationId:'next'}).then(()=>finished=true);await new Promise(resolve=>setTimeout(resolve,50));assert.equal(finished,false);assert.deepEqual(await first.list('tenant'),[]);await locked.query('COMMIT');locked.release();locked=undefined;await pending;assert.deepEqual((await first.list('tenant')).map(row=>row.invocationId),['held','next']);
  const context={tenantId:'tenant',principalId:'user',origin:'ui'},r1=new CapabilityRegistry(first.record),r2=new CapabilityRegistry(second.record);for(const registry of [r1,r2])registry.register({operationId:'read',method:'GET',path:'/read'},{authorize:()=>true,validate:()=>true,execute:input=>input});await Promise.all(Array.from({length:12},(_,i)=>(i%2?r1:r2).invoke('read',{secret:'private'},context)));const rows=[];let after=0;for(;;){const page=await second.list('tenant',{after,limit:3});if(!page.length)break;rows.push(...page);after=page.at(-1).sequence;}assert.equal(rows.length,26);assert.deepEqual(rows.map(row=>row.sequence),Array.from({length:26},(_,i)=>i+1));assert.equal(JSON.stringify(rows).includes('private'),false);for(const attempt of rows.filter(row=>row.operationId==='read'&&row.outcome==='attempt'))assert.equal(rows.filter(row=>row.invocationId===attempt.invocationId&&row.outcome==='succeeded').length,1);
  await second.record({...event,tenantId:'other',invocationId:'other'});assert.deepEqual((await first.list('other')).map(row=>row.sequence),[1]);assert.equal((await first.list('tenant')).length,26);
 }finally{if(locked){await locked.query('ROLLBACK');locked.release();}await Promise.allSettled([a.end(),b.end()]);await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});
