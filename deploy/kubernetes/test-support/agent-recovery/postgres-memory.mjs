import assert from 'node:assert/strict';
import pg from 'pg';
import {PostgresAgentMemory} from '../../../../packages/agent/dist/index.js';
const command=process.argv[2],pool=new pg.Pool({connectionString:'postgresql://appmixer:test-only-password@agent-memory-postgres:5432/appmixer_test'}),actor={tenantId:'tenant',principalId:'worker'},scope={tenantId:'tenant',agentId:'agent',owner:{kind:'organization',id:'org'},kind:'semantic'},provenance={kind:'run',id:'run'};
const transaction=async operation=>{const client=await pool.connect();try{await client.query('BEGIN');const result=await operation((sql,args)=>client.query(sql,args));if(command==='before'){console.log('MEMORY_BEFORE_COMMIT');await new Promise(()=>{});}await client.query('COMMIT');if(command==='after'){console.log('MEMORY_AFTER_COMMIT');await new Promise(()=>{});}return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}};
const store=new PostgresAgentMemory({enabled:true,audit:true,maxEntries:10,maxTtlMs:1000,clock:()=>100,authorize:()=>true,query:(sql,args)=>pool.query(sql,args),transaction});
try{
 if(command==='setup')await store.initialize();
 else if(command==='before'||command==='after')await store.put(actor,scope,command,{phase:command},{expectedRevision:null,expiresAt:500,provenance});
 else if(command==='verify-before'){assert.equal(await store.get(actor,scope,'before'),undefined);assert.deepEqual((await store.auditHistory(actor,scope)).items,[]);}
 else if(command==='verify-after'){assert.deepEqual((await store.get(actor,scope,'after')).value,{phase:'after'});assert.deepEqual((await store.auditHistory(actor,scope)).items.map(x=>[x.actorId,x.action,x.memoryId,x.revision]),[['worker','write','after',1]]);assert.equal(await store.get({...actor,tenantId:'other'},{...scope,tenantId:'other'},'after'),undefined);await assert.rejects(store.put(actor,scope,'after',{again:true},{expectedRevision:null,expiresAt:500,provenance}),/revision conflict/);}
 else throw Error('Unknown memory recovery command');
}finally{await pool.end();}
