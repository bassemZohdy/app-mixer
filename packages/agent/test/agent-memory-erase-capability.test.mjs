import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import pg from 'pg';
import {CapabilityRegistry,createCapabilityServer} from '../../core/dist/index.js';
import {SqliteAgentMemory,PostgresAgentMemory,registerAgentMemoryScopeErase} from '../dist/index.js';

const actor={tenantId:'tenant',principalId:'operator'},scope={tenantId:'tenant',agentId:'agent',owner:{kind:'user',id:'alice'},kind:'episodic'},other={...scope,owner:{kind:'user',id:'bob'}},write={expectedRevision:null,expiresAt:500,provenance:{kind:'human',id:'operator'}};
const transaction=pool=>async operation=>{const client=await pool.connect();try{await client.query('BEGIN');const result=await operation((sql,args)=>client.query(sql,args));await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}};
async function exercise(memory){
 let allowed=true;const registry=new CapabilityRegistry(()=>{}),chosen=structuredClone(scope),config={memory,scope:chosen,operationId:'erase',path:'/erase',authorize:a=>a.principalId==='operator',authorizeErase:()=>allowed};registerAgentMemoryScopeErase(registry,config);chosen.owner.id='bob';config.authorizeErase=()=>false;
 await memory.put(actor,scope,'one','secret',write);await memory.put(actor,other,'one','keep',write);
 const server=createCapabilityServer(registry,req=>req.headers.authorization==='operator'?actor:req.headers.authorization==='other'?{...actor,tenantId:'other'}:undefined,()=>{});server.listen(0,'127.0.0.1');await once(server,'listening');
 const call=(input,auth='operator')=>fetch(`http://127.0.0.1:${server.address().port}/capabilities/erase/invoke`,{method:'POST',headers:{authorization:auth,'content-type':'application/json'},body:JSON.stringify({origin:'ui',input})});
 try{
  assert.equal((await call({query:{confirm:true}},'other')).status,403);assert.equal((await call({query:{confirm:true,owner:'bob'}})).status,400);assert.equal((await call({query:{confirm:false}})).status,400);assert.equal((await call({query:{confirm:true}},'missing')).status,401);
  allowed=false;assert.equal((await call({query:{confirm:true}})).status,403);allowed=true;
  const response=await call({query:{confirm:true}});assert.equal(response.status,200);assert.deepEqual((await response.json()).result,{erased:1});assert.equal(await memory.get(actor,scope,'one'),undefined);assert.equal((await memory.get(actor,other,'one')).value,'keep');const audit=(await memory.auditHistory(actor,scope)).items;assert.deepEqual(audit.map(e=>e.action),['write','erase']);assert.equal(audit[1].actorId,'operator');assert.equal((await call({query:{confirm:true}})).status,200);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
test('fixed-scope memory erasure is authenticated, authorized and audited over HTTP',async()=>{
 const memory=new SqliteAgentMemory(':memory:',{enabled:true,audit:true,maxEntries:10,maxTtlMs:1000,clock:()=>100,authorize:()=>true});try{await exercise(memory);}finally{memory.close();}
});
test('fixed-scope memory erasure uses PostgreSQL authorization and audit over HTTP',{skip:!process.env.APP_MIXER_TEST_POSTGRES_URL,timeout:30000},async()=>{
 const schema='memory_erase_cap_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:process.env.APP_MIXER_TEST_POSTGRES_URL}),pool=new pg.Pool({connectionString:process.env.APP_MIXER_TEST_POSTGRES_URL,options:`-c search_path=${schema}`});
 try{await admin.query(`CREATE SCHEMA "${schema}"`);const memory=new PostgresAgentMemory({enabled:true,audit:true,maxEntries:10,maxTtlMs:1000,clock:()=>100,authorize:()=>true,query:(sql,args)=>pool.query(sql,args),transaction:transaction(pool)});await memory.initialize();await exercise(memory);}finally{await pool.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end();}
});
test('scope erasure rechecks host and store authorization before mutation',async()=>{
 let storeAllowed=true,actionAllowed=true,calls=0;const memory=new SqliteAgentMemory(':memory:',{enabled:true,audit:true,maxEntries:10,maxTtlMs:1000,clock:()=>100,authorize:(_actor,_scope,action)=>action!=='erase'||storeAllowed}),registry=new CapabilityRegistry(()=>{});
 try{await memory.put(actor,scope,'one','secret',write);registerAgentMemoryScopeErase(registry,{memory,scope,operationId:'erase',path:'/erase',authorize:()=>true,authorizeErase:()=>++calls===1?true:actionAllowed});actionAllowed=false;await assert.rejects(registry.invoke('erase',{query:{confirm:true}},{...actor,origin:'ui'}),/forbidden/i);assert.ok(await memory.get(actor,scope,'one'));actionAllowed=true;storeAllowed=false;await assert.rejects(registry.invoke('erase',{query:{confirm:true}},{...actor,origin:'ui'}),/access denied/i);assert.ok(await memory.get(actor,scope,'one'));assert.deepEqual((await memory.auditHistory(actor,scope)).items.map(e=>e.action),['write']);}finally{memory.close();}
});

test('a failed completion audit reports an uncertain outcome without repeating erasure',async()=>{
 const memory=new SqliteAgentMemory(':memory:',{enabled:true,audit:true,maxEntries:10,maxTtlMs:1000,clock:()=>100,authorize:()=>true}),registry=new CapabilityRegistry(event=>{if(event.outcome==='succeeded')throw Error('audit unavailable');});
 try{await memory.put(actor,scope,'one','secret',write);registerAgentMemoryScopeErase(registry,{memory,scope,operationId:'erase',path:'/erase',authorize:()=>true,authorizeErase:()=>true});await assert.rejects(registry.invoke('erase',{query:{confirm:true}},{...actor,origin:'ui'}),/uncertain/i);assert.equal(await memory.get(actor,scope,'one'),undefined);assert.deepEqual((await memory.auditHistory(actor,scope)).items.map(e=>e.action),['write','erase']);await memory.put(actor,scope,'new','keep',write);assert.equal((await memory.get(actor,scope,'new')).value,'keep');}finally{memory.close();}
});
