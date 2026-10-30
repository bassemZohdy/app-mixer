import assert from 'node:assert/strict';
import pg from 'pg';
import {PostgresAgentMemory,AgentSemanticMemory} from '../../../../packages/agent/dist/index.js';
const command=process.argv[2],pool=new pg.Pool({connectionString:'postgresql://appmixer:test-only-password@agent-memory-postgres:5432/appmixer_test'}),actor={tenantId:'tenant',principalId:'worker'},scope={tenantId:'tenant',agentId:'agent',owner:{kind:'organization',id:'org'},kind:'semantic'},provenance={kind:'run',id:'run'};
const transaction=async operation=>{const client=await pool.connect();try{await client.query('BEGIN');const result=await operation((sql,args)=>client.query(sql,args));if(command==='before'){console.log('MEMORY_BEFORE_COMMIT');await new Promise(()=>{});}await client.query('COMMIT');if(command==='after'){console.log('MEMORY_AFTER_COMMIT');await new Promise(()=>{});}return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}};
const store=new PostgresAgentMemory({enabled:true,audit:true,vectorIndex:{modelId:'test-model',dimensions:2,scope},maxEntries:10,maxTtlMs:1000,clock:()=>100,authorize:()=>true,query:(sql,args)=>pool.query(sql,args),transaction});
const semantic=new AgentSemanticMemory(store,{modelId:'test-model',dimensions:2,embed:async()=>[1,0]});
try{
 if(command==='setup'){await pool.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');await store.initialize();}
 else if(command==='before'||command==='after')await semantic.put(actor,scope,command,`memory ${command}`,{expectedRevision:null,expiresAt:500,provenance});
 else if(command==='verify-before'){assert.equal(await store.get(actor,scope,'before'),undefined);assert.deepEqual((await store.auditHistory(actor,scope)).items,[]);assert.deepEqual(await semantic.searchIndexed(actor,scope,'memory'),[]);}
 else if(command==='verify-after'){assert.equal((await semantic.get(actor,scope,'after')).text,'memory after');assert.deepEqual((await semantic.searchIndexed(actor,scope,'memory')).map(hit=>hit.id),['after']);assert.deepEqual((await store.auditHistory(actor,scope)).items.map(x=>[x.actorId,x.action,x.memoryId,x.revision]),[['worker','write','after',1]]);assert.equal(await store.get({...actor,tenantId:'other'},{...scope,tenantId:'other'},'after'),undefined);await assert.rejects(store.put(actor,scope,'after',{again:true},{expectedRevision:null,expiresAt:500,provenance}),/revision conflict/);}
 else throw Error('Unknown memory recovery command');
}finally{await pool.end();}
