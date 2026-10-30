import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {PostgresAgentMemory,AgentSemanticMemory} from '../dist/index.js';
const actor={tenantId:'tenant',principalId:'service'},scope={tenantId:'tenant',agentId:'agent',owner:{kind:'organization',id:'org'},kind:'semantic'},provenance={kind:'run',id:'run'};
const transaction=pool=>async operation=>{const client=await pool.connect();try{await client.query('BEGIN');const result=await operation((sql,args)=>client.query(sql,args));await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}};

test('PostgreSQL memory rejects invalid configuration and fails closed',async()=>{
 assert.throws(()=>new PostgresAgentMemory({}),/configuration/);const m=new PostgresAgentMemory({enabled:true,maxEntries:2,maxTtlMs:1000,authorize:()=>false,query:async()=>{throw Error('unexpected query')},transaction:async()=>{throw Error('unexpected transaction')}});await assert.rejects(m.get(actor,scope,'x'),/access denied/);await assert.rejects(m.put(actor,scope,'x',{}, {expectedRevision:null,expiresAt:500,provenance}),/access denied/);await assert.rejects(m.get({...actor,tenantId:'other'},scope,'x'),/scope/);
});

test('PostgreSQL memory coordinates isolated scopes, revisions, quota, expiry and semantic search across workers',{skip:!process.env.APP_MIXER_TEST_POSTGRES_URL,timeout:30000},async()=>{
 const schema='app_mixer_memory_'+randomUUID().replaceAll('-',''),url=process.env.APP_MIXER_TEST_POSTGRES_URL,admin=new pg.Pool({connectionString:url}),a=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`}),b=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});let now=100,allowed=true;
 try{await admin.query(`CREATE SCHEMA "${schema}"`);const config=pool=>({enabled:true,maxEntries:2,maxTtlMs:1000,clock:()=>now,authorize:(who,_scope,action,id)=>allowed&&who.principalId==='service'&&!(action==='read'&&id==='private'),query:(sql,args)=>pool.query(sql,args),transaction:transaction(pool)}),first=new PostgresAgentMemory(config(a)),second=new PostgresAgentMemory(config(b));await first.initialize();const opts={expectedRevision:null,expiresAt:500,provenance};
  const create=await Promise.allSettled([first.put(actor,scope,'same','a',opts),second.put(actor,scope,'same','b',opts)]);assert.equal(create.filter(x=>x.status==='fulfilled').length,1);assert.match(create.find(x=>x.status==='rejected').reason.message,/revision conflict/);
  const quota=await Promise.allSettled([first.put(actor,scope,'second','x',opts),second.put(actor,scope,'third','y',opts)]);assert.equal(quota.filter(x=>x.status==='fulfilled').length,1);assert.match(quota.find(x=>x.status==='rejected').reason.message,/quota/);const winner=quota.find(x=>x.status==='fulfilled').value.id;
  await first.delete(actor,scope,winner,1);assert.equal((await second.put(actor,scope,winner,'new',opts)).revision,3);await assert.rejects(first.delete(actor,scope,winner,1),/revision conflict/);assert.equal((await second.list(actor,scope,{limit:1})).nextAfter,'same');assert.equal((await first.list(actor,{...scope,agentId:'other'})).items.length,0);
  const otherScope={...scope,owner:{kind:'user',id:'user'}},semantic=new AgentSemanticMemory(first,{modelId:'model',dimensions:2,embed:async text=>text.includes('apple')?[1,0]:[0,1]});await semantic.put(actor,otherScope,'note','apple',opts);assert.equal((await semantic.get(actor,otherScope,'note')).revision,1);assert.equal((await semantic.search(actor,otherScope,'apple'))[0].id,'note');await second.put(actor,otherScope,'private','private',opts);assert.deepEqual((await second.list(actor,otherScope)).items.map(x=>x.id),['note']);
  allowed=false;await assert.rejects(semantic.get(actor,otherScope,'note'),/access denied/);allowed=true;now=500;assert.equal(await second.get(actor,otherScope,'note'),undefined);assert.equal(await first.purgeExpired(actor,otherScope),2);now=501;assert.equal((await second.put(actor,otherScope,'note','again',{...opts,expiresAt:900})).revision,3);
 }finally{await Promise.allSettled([a.end(),b.end()]);await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});
