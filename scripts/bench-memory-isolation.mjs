#!/usr/bin/env node
// Compares the two vector-index isolation strategies of PostgresAgentMemory on pgvector (see docs/agent-memory.md):
//   shared  one HNSW index over every tenant, with the tenant filter applied to its candidates
//   scoped  one HNSW index per tenant (`vectorIndex.scope`), each holding only that tenant's memories
// For each strategy it loads the same corpus, then for every tenant runs indexed searches with `compareExact`, which reports how
// much of exact search's result the approximate index found, and prints the search latency. The embedder is the deterministic
// reference embedder of the evaluation-set test, so the numbers show index behaviour, not embedding quality.
// Needs `npm run build` and a pgvector database:
//   APP_MIXER_TEST_POSTGRES_URL=postgresql://... node scripts/bench-memory-isolation.mjs [tenants=8] [memoriesPerTenant=400] [queriesPerTenant=20]
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {PostgresAgentMemory,AgentSemanticMemory,evaluateAgentMemoryRetrieval} from '../packages/agent/dist/index.js';

const url=process.env.APP_MIXER_TEST_POSTGRES_URL;if(!url){console.error('Set APP_MIXER_TEST_POSTGRES_URL to a PostgreSQL database with the pgvector extension available.');process.exit(2);}
const tenants=Number(process.argv[2]??8),perTenant=Number(process.argv[3]??400),queries=Number(process.argv[4]??20),DIMENSIONS=256;
if(![tenants,perTenant,queries].every(value=>Number.isSafeInteger(value)&&value>=1&&value<=1000)||queries>perTenant){console.error('Tenants, memories and queries must be integers from 1 to 1000, with no more queries than memories.');process.exit(2);}
const hash=text=>{let h=2166136261;for(const c of text){h^=c.codePointAt(0);h=Math.imul(h,16777619)>>>0;}return h;};
function embed(text){
 const vector=new Array(DIMENSIONS).fill(0),words=text.toLowerCase().match(/[a-z0-9]+/g)??[];
 for(const word of words){vector[hash('w:'+word)%DIMENSIONS]+=2;const padded=`#${word}#`;for(let i=0;i+3<=padded.length;i++)vector[hash('t:'+padded.slice(i,i+3))%DIMENSIONS]+=1;}
 const norm=Math.hypot(...vector)||1;return vector.map(value=>value/norm);
}
// Every tenant draws from the same vocabulary so that neighbours in vector space belong to many tenants.
const vocabulary=Array.from({length:400},(_,i)=>'w'+(hash('v'+i)%100000).toString(36));
const document=(tenant,n)=>{let seed=((tenant+1)*7919+n*2654435761)>>>0;const pick=()=>{seed=(seed*1664525+1013904223)>>>0;return vocabulary[seed%vocabulary.length];};return Array.from({length:10},pick).join(' ');};
const percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*p))];

async function run(strategy){
 const schema='bench_memory_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:url}),pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema},public`,max:4});
 const transaction=async operation=>{const client=await pool.connect();try{await client.query('BEGIN');const result=await operation((sql,args)=>client.query(sql,args));await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}};
 try{
  await admin.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');await admin.query(`CREATE SCHEMA "${schema}"`);
  const scopeOf=tenant=>({tenantId:'tenant'+tenant,agentId:'support',owner:{kind:'organization',id:'org'},kind:'semantic'}),actorOf=tenant=>({tenantId:'tenant'+tenant,principalId:'agent'});
  const storeFor=tenant=>new PostgresAgentMemory({enabled:true,vectorIndex:strategy==='scoped'?{modelId:'reference-v1',dimensions:DIMENSIONS,scope:scopeOf(tenant)}:{modelId:'reference-v1',dimensions:DIMENSIONS},maxEntries:1000,maxTtlMs:10**9,clock:()=>100,authorize:()=>true,query:(sql,args)=>pool.query(sql,args),transaction});
  const stores=Array.from({length:tenants},(_,tenant)=>storeFor(tenant));
  // A scoped store creates its own index; the shared strategy needs only the one.
  for(const store of strategy==='scoped'?stores:stores.slice(0,1))await store.initialize();
  const options={expectedRevision:null,expiresAt:10**8,provenance:{kind:'run',id:'bench'}};
  const semantic=stores.map(store=>new AgentSemanticMemory(store,{modelId:'reference-v1',dimensions:DIMENSIONS,embed:async text=>embed(text)}));
  const loading=performance.now();
  for(let tenant=0;tenant<tenants;tenant++)for(let n=0;n<perTenant;n++)await semantic[tenant].put(actorOf(tenant),scopeOf(tenant),'m'+n,document(tenant,n),options);
  const loaded=(performance.now()-loading)/1000;
  await pool.query('ANALYZE');
  const recalls=[],latencies=[];
  for(let tenant=0;tenant<tenants;tenant++){
   // Each query is a stored memory with its last two words dropped; its own ID is the expected answer.
   const cases=Array.from({length:queries},(_,i)=>{const n=Math.floor(i*perTenant/queries);return {id:'q'+n,query:document(tenant,n).split(' ').slice(0,8).join(' '),relevantIds:['m'+n]};});
   for(const item of cases){
    const started=performance.now();
    const report=await evaluateAgentMemoryRetrieval({memory:semantic[tenant],actor:actorOf(tenant),scope:scopeOf(tenant),mode:'indexed',limit:5,cases:[item],maxCandidates:40,compareExact:true});
    latencies.push(performance.now()-started);recalls.push(report.meanExactRecall);
   }
  }
  const mean=recalls.reduce((a,b)=>a+b,0)/recalls.length;
  return {strategy,tenants,memories:tenants*perTenant,queries:recalls.length,recallAgainstExact:Number(mean.toFixed(3)),queriesBelowFullRecall:recalls.filter(value=>value<1).length,p50Ms:Number(percentile(latencies,0.5).toFixed(1)),p99Ms:Number(percentile(latencies,0.99).toFixed(1)),loadSeconds:Number(loaded.toFixed(1))};
 }finally{await pool.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(()=>{});await admin.end();}
}
for(const strategy of ['shared','scoped'])console.log(JSON.stringify(await run(strategy)));
