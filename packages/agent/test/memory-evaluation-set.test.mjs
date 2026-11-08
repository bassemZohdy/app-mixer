// Runs the draft labelled memory evaluation set (fixtures/memory-evaluation-set.json) through every retrieval mode
// on PostgreSQL with pgvector, among 900 synthetic distractor memories, and compares the approximate (HNSW) index
// with exact search. The embedder is a deterministic local reference (hashed words and character trigrams), so the
// numbers are a regression baseline for the harness, not the quality of a production embedding model.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {PostgresAgentMemory,AgentSemanticMemory,evaluateAgentMemoryRetrieval} from '../dist/index.js';

const url=process.env.APP_MIXER_TEST_POSTGRES_URL,set=JSON.parse(readFileSync(new URL('./fixtures/memory-evaluation-set.json',import.meta.url),'utf8'));
const DIMENSIONS=256,STOP=new Set('a an and are as at be by do does for from has have how i in is it its of on or our should the their them then to us was we what when which who why will with would after all can get must per some that this there these those up use'.split(' '));
const hash=text=>{let h=2166136261;for(const c of text){h^=c.codePointAt(0);h=Math.imul(h,16777619)>>>0;}return h;};
const stem=word=>word.replace(/(ings?|ed|es|s)$/,'')||word;
/** Reference embedder: L2-normalised counts of hashed words and character trigrams. Deterministic and local. */
function embed(text){
 const vector=new Array(DIMENSIONS).fill(0),words=text.toLowerCase().match(/[a-z0-9]+/g)?.filter(word=>!STOP.has(word)).map(stem)??[];
 for(const word of words){vector[hash('w:'+word)%DIMENSIONS]+=2;const padded=`#${word}#`;for(let i=0;i+3<=padded.length;i++)vector[hash('t:'+padded.slice(i,i+3))%DIMENSIONS]+=1;}
 const norm=Math.hypot(...vector)||1;return vector.map(value=>value/norm);
}
// Distractors reuse the corpus vocabulary so they compete for the same features.
const vocabulary=[...new Set(Object.values(set.entries).join(' ').toLowerCase().match(/[a-z]+/g))];
const distractor=n=>{let seed=n*2654435761>>>0;const pick=()=>{seed=(seed*1664525+1013904223)>>>0;return vocabulary[seed%vocabulary.length];};return `Ticket ${n}: ${Array.from({length:9},pick).join(' ')}.`;};

// Proposed floors for this reference embedder (a regression gate). Production thresholds must be set by the owner
// for the chosen embedding model, from the report this test prints.
// Lexical search requires every query token, so it is scored on the keyword cases' exact-term queries; the natural
// questions are also reported for lexical search, without a floor, to show that limitation.
const floors={semantic:{meanRecall:0.75,meanReciprocalRank:0.7},hybrid:{meanRecall:0.7,meanReciprocalRank:0.7},indexed:{meanRecall:0.75,meanReciprocalRank:0.7,meanExactRecall:0.95},'lexical keywords':{meanRecall:0.8,meanReciprocalRank:0.7},'lexical questions':{}};

test('the draft memory evaluation set runs in every mode and the HNSW index matches exact search',{skip:!url&&'set APP_MIXER_TEST_POSTGRES_URL to run against PostgreSQL',timeout:600000},async t=>{
 const schema='memory_eval_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:url}),pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema},public`,max:4});
 const transaction=async operation=>{const client=await pool.connect();try{await client.query('BEGIN');const result=await operation((sql,args)=>client.query(sql,args));await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}};
 try{
  await admin.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');await admin.query(`CREATE SCHEMA "${schema}"`);
  const scope={tenantId:'tenant',agentId:'support',owner:{kind:'organization',id:'org'},kind:'semantic'},actor={tenantId:'tenant',principalId:'agent'};
  const store=new PostgresAgentMemory({enabled:true,textIndex:true,vectorIndex:{modelId:'reference-v1',dimensions:DIMENSIONS},maxEntries:1000,maxTtlMs:10**9,clock:()=>100,authorize:()=>true,query:(sql,args)=>pool.query(sql,args),transaction});
  await store.initialize();
  const memory=new AgentSemanticMemory(store,{modelId:'reference-v1',dimensions:DIMENSIONS,embed:async text=>embed(text)}),options={expectedRevision:null,expiresAt:10**8,provenance:{kind:'run',id:'evaluation'}};
  for(const [id,text] of Object.entries(set.entries))await memory.put(actor,scope,id,text,options);
  for(let n=1;n<=900;n++)await memory.put(actor,scope,'distractor-'+n,distractor(n),options);
  const cases=set.cases.map(({id,query,relevantIds})=>({id,query,relevantIds})),keywords=set.cases.filter(item=>item.lexicalQuery).map(({id,lexicalQuery,relevantIds})=>({id,query:lexicalQuery,relevantIds}));
  const reports={},runs=[['semantic','semantic',cases,{}],['hybrid','hybrid',cases,{}],['indexed','indexed',cases,{maxCandidates:40,compareExact:true}],['lexical keywords','lexical',keywords,{maxCandidates:40}],['lexical questions','lexical',cases,{maxCandidates:40}]];
  for(const [name,mode,selected,extra] of runs){
   reports[name]=await evaluateAgentMemoryRetrieval({memory,actor,scope,mode,limit:5,cases:selected,...extra});
   const r=reports[name],byCategory={};
   for(const result of r.cases){const category=set.cases.find(item=>item.id===result.id).category;(byCategory[category]??=[]).push(result.recall);}
   t.diagnostic(`${name}: recall ${r.meanRecall.toFixed(3)}, precision@5 ${r.meanPrecision.toFixed(3)}, MRR ${r.meanReciprocalRank.toFixed(3)}, nDCG ${r.meanNdcg.toFixed(3)}${r.meanExactRecall===undefined?'':`, recall against exact search ${r.meanExactRecall.toFixed(3)}`}; recall by category ${Object.entries(byCategory).map(([k,v])=>`${k} ${(v.reduce((a,b)=>a+b,0)/v.length).toFixed(2)}`).join(', ')}`);
   const missed=r.cases.filter(result=>result.recall<1).map(result=>result.id);if(missed.length)t.diagnostic(`${name} incomplete: ${missed.join(', ')}`);
   for(const [metric,floor] of Object.entries(floors[name]))assert.ok(r[metric]>=floor,`${name} ${metric} ${r[metric]} is below the proposed floor ${floor}`);
  }
  assert.equal(reports.indexed.cases.length,set.cases.length);assert.equal(reports['lexical keywords'].cases.length,8);
 }finally{await pool.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(()=>{});await admin.end();}
});
