import {PostgresAgentMemory} from './postgres-agent-memory.js';
import {SqliteAgentMemory,type AgentMemoryScope,type AgentMemoryActor,type AgentMemoryProvenance} from './agent-memory.js';

type Embedder={modelId:string;dimensions:number;embed:(text:string)=>Promise<number[]>};
export type SemanticMemorySearchOptions={minSimilarity?:number};
export const validSimilarity=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=-1&&value<=1;
export type SemanticMemoryRecord={id:string;revision:number;text:string;provenance:AgentMemoryProvenance;expiresAt:number};
export type SemanticMemoryHit=SemanticMemoryRecord&{score:number};
const validId=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(x);
const validText=(x:unknown):x is string=>typeof x==='string'&&x.trim().length>0&&x.length<=2000;
const terms=(text:string):Set<string>=>new Set((text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu)??[]).slice(0,256));
function normalize(vector:unknown,dimensions:number):number[]{
 if(!Array.isArray(vector)||vector.length!==dimensions||vector.some(x=>typeof x!=='number'||!Number.isFinite(x)||Math.abs(x)>1000000))throw Error('Invalid embedding');
 const norm=Math.hypot(...vector);if(!Number.isFinite(norm)||norm===0)throw Error('Invalid embedding');return vector.map(x=>x/norm);
}
function semanticScope(scope:AgentMemoryScope):AgentMemoryScope{if(!scope||scope.kind!=='semantic')throw Error('Invalid semantic scope');return structuredClone(scope);}
/** Exact cosine search over authorized records using a host-selected embedding model. */
export class AgentSemanticMemory {
 private readonly modelId:string;private readonly dimensions:number;private readonly embed:Embedder['embed'];
 constructor(private readonly memory:SqliteAgentMemory|PostgresAgentMemory,embedding:Embedder){
  if(!(memory instanceof SqliteAgentMemory||memory instanceof PostgresAgentMemory)||!embedding||!validId(embedding.modelId)||!Number.isSafeInteger(embedding.dimensions)||embedding.dimensions<1||embedding.dimensions>2048||typeof embedding.embed!=='function')throw Error('Invalid embedding configuration');
  this.modelId=embedding.modelId;this.dimensions=embedding.dimensions;this.embed=embedding.embed;
 }
 async put(actor:AgentMemoryActor,scope:AgentMemoryScope,memoryId:string,text:string,options:{expectedRevision:number|null;expiresAt:number;provenance:AgentMemoryProvenance}):Promise<{id:string;revision:number;expiresAt:number}>{
  const safeActor=structuredClone(actor),safeScope=semanticScope(scope),safeOptions=structuredClone(options);if(!validId(memoryId)||!validText(text)||!safeOptions||(safeOptions.expectedRevision!==null&&(!Number.isSafeInteger(safeOptions.expectedRevision)||safeOptions.expectedRevision<1))||!Number.isSafeInteger(safeOptions.expiresAt)||!safeOptions.provenance||!['run','human','system'].includes(safeOptions.provenance.kind)||!validId(safeOptions.provenance.id))throw Error('Invalid semantic memory');
  await this.memory.assertAccess(safeActor,safeScope,'write',memoryId);
  const vector=normalize(await this.embed(text),this.dimensions);
  const stored=await this.memory.put(safeActor,safeScope,memoryId,{format:'semantic-v1',modelId:this.modelId,text,vector},safeOptions);return {id:stored.id,revision:stored.revision,expiresAt:stored.expiresAt};
 }
 /** Read a known authorized memory without invoking the embedding provider. */
 async get(actor:AgentMemoryActor,scope:AgentMemoryScope,memoryId:string):Promise<SemanticMemoryRecord|undefined>{
  const safeActor=structuredClone(actor),safeScope=semanticScope(scope);if(!validId(memoryId))throw Error('Invalid semantic memory ID');
  const row=await this.memory.get(safeActor,safeScope,memoryId);if(!row||!row.value||typeof row.value!=='object'||Array.isArray(row.value))return undefined;
  const entry=row.value as Record<string,unknown>;if(entry.format!=='semantic-v1'||entry.modelId!==this.modelId||!validText(entry.text))return undefined;
  try{normalize(entry.vector,this.dimensions);}catch{return undefined;}
  return {id:row.id,revision:row.revision,text:entry.text,provenance:row.provenance,expiresAt:row.expiresAt};
 }
 /** Remove one versioned semantic memory through the store's delete policy. */
 async delete(actor:AgentMemoryActor,scope:AgentMemoryScope,memoryId:string,expectedRevision:number):Promise<void>{
  const safeActor=structuredClone(actor),safeScope=semanticScope(scope);if(!validId(memoryId)||!Number.isSafeInteger(expectedRevision)||expectedRevision<1)throw Error('Invalid semantic memory delete');await this.memory.delete(safeActor,safeScope,memoryId,expectedRevision);
 }
 /** PostgreSQL indexed keyword search; scores are PostgreSQL text ranks, not cosine similarity. */
 async searchLexical(actor:AgentMemoryActor,scope:AgentMemoryScope,query:string,limit=5,maxCandidates=100):Promise<SemanticMemoryHit[]>{
  const safeActor=structuredClone(actor),safeScope=semanticScope(scope);if(!(this.memory instanceof PostgresAgentMemory)||!validText(query))throw Error('Invalid indexed memory search');const candidates=await this.memory.searchSemanticText(safeActor,safeScope,query,this.modelId,limit,maxCandidates),items:SemanticMemoryHit[]=[];
  for(const {record,score} of candidates){const value=record.value as Record<string,unknown>;if(!validText(value.text))continue;try{normalize(value.vector,this.dimensions);}catch{continue;}items.push({id:record.id,revision:record.revision,text:value.text,score,provenance:record.provenance,expiresAt:record.expiresAt});}return items;
 }
 private async prepareIndexed(actor:AgentMemoryActor,scope:AgentMemoryScope,query:string,limit:number,maxCandidates:number):Promise<{actor:AgentMemoryActor;scope:AgentMemoryScope;vector:number[]}>{
  const safeActor=structuredClone(actor),safeScope=semanticScope(scope);if(!(this.memory instanceof PostgresAgentMemory)||!this.memory.supportsVectorIndex(this.modelId,this.dimensions,safeScope)||!validText(query)||!Number.isSafeInteger(limit)||limit<1||limit>20||!Number.isSafeInteger(maxCandidates)||maxCandidates<limit||maxCandidates>1000)throw Error('Invalid indexed memory search');await this.memory.assertAccess(safeActor,safeScope,'list');return {actor:safeActor,scope:safeScope,vector:normalize(await this.embed(query),this.dimensions)};
 }
 private indexedThreshold(options:SemanticMemorySearchOptions):number|undefined{if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>key!=='minSimilarity'))throw Error('Invalid indexed memory search');const value=options.minSimilarity;if(value!==undefined&&!validSimilarity(value))throw Error('Invalid indexed memory search');return value;}
 private async indexedWithVector(actor:AgentMemoryActor,scope:AgentMemoryScope,vector:number[],limit:number,maxCandidates:number,minSimilarity?:number):Promise<SemanticMemoryHit[]>{
  if(!(this.memory instanceof PostgresAgentMemory))throw Error('Invalid indexed memory search');const candidates=await this.memory.searchSemanticVector(actor,scope,vector,this.modelId,limit,maxCandidates),items:SemanticMemoryHit[]=[];
  for(const {record,score} of candidates){const value=record.value as Record<string,unknown>;if(!validText(value.text)||(minSimilarity!==undefined&&score<minSimilarity))continue;try{normalize(value.vector,this.dimensions);}catch{continue;}items.push({id:record.id,revision:record.revision,text:value.text,score,provenance:record.provenance,expiresAt:record.expiresAt});}return items;
 }
 /** Approximate PostgreSQL vector search with bounded candidates and record authorization. */
 async searchIndexed(actor:AgentMemoryActor,scope:AgentMemoryScope,query:string,limit=5,maxCandidates=100,options:SemanticMemorySearchOptions={}):Promise<SemanticMemoryHit[]>{
  const minSimilarity=this.indexedThreshold(options),prepared=await this.prepareIndexed(actor,scope,query,limit,maxCandidates);return this.indexedWithVector(prepared.actor,prepared.scope,prepared.vector,limit,maxCandidates,minSimilarity);
 }
 /** Evaluate approximate and exact retrieval with one shared query embedding. */
 async compareIndexed(actor:AgentMemoryActor,scope:AgentMemoryScope,query:string,limit=5,maxCandidates=100,options:SemanticMemorySearchOptions={}):Promise<{indexed:SemanticMemoryHit[];exact:SemanticMemoryHit[]}>{
  const minSimilarity=this.indexedThreshold(options),prepared=await this.prepareIndexed(actor,scope,query,limit,maxCandidates),indexed=await this.indexedWithVector(prepared.actor,prepared.scope,prepared.vector,limit,maxCandidates,minSimilarity),exact=await this.searchInternal(prepared.actor,prepared.scope,query,limit,false,{minSimilarity},prepared.vector);return {indexed,exact};
 }
 async search(actor:AgentMemoryActor,scope:AgentMemoryScope,query:string,limit=5,options:SemanticMemorySearchOptions={}):Promise<SemanticMemoryHit[]>{
  return this.searchInternal(actor,scope,query,limit,false,options);
 }
 /** Fuse semantic rank with exact normalized word matches; never expands the authorized scope. */
 async searchHybrid(actor:AgentMemoryActor,scope:AgentMemoryScope,query:string,limit=5,options:SemanticMemorySearchOptions={}):Promise<SemanticMemoryHit[]>{
  return this.searchInternal(actor,scope,query,limit,true,options);
 }
 private async searchInternal(actor:AgentMemoryActor,scope:AgentMemoryScope,query:string,limit:number,hybrid:boolean,options:SemanticMemorySearchOptions,preparedVector?:number[]):Promise<SemanticMemoryHit[]>{
  const safeActor=structuredClone(actor),safeScope=semanticScope(scope);if(!validText(query)||!Number.isSafeInteger(limit)||limit<1||limit>20||!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>key!=='minSimilarity')||(options.minSimilarity!==undefined&&!validSimilarity(options.minSimilarity)))throw Error('Invalid semantic query');const minSimilarity=options.minSimilarity;
  await this.memory.assertAccess(safeActor,safeScope,'list');const queryVector=preparedVector??normalize(await this.embed(query),this.dimensions);
  const matches:SemanticMemoryHit[]=[];let after:string|undefined,pages=0;
  do{
   if(++pages>11)throw Error('Semantic memory scan limit exceeded');const page=await this.memory.list(safeActor,safeScope,{after,limit:100});
   for(const row of page.items){const v=row.value;if(!v||typeof v!=='object'||Array.isArray(v))continue;const entry=v as Record<string,unknown>;
    if(entry.format!=='semantic-v1'||entry.modelId!==this.modelId||!validText(entry.text))continue;
    let vector:number[];try{vector=normalize(entry.vector,this.dimensions);}catch{continue;}
    const score=Math.max(-1,Math.min(1,vector.reduce((sum,value,index)=>sum+value*queryVector[index],0)));
    if(minSimilarity===undefined||score>=minSimilarity)matches.push({id:row.id,revision:row.revision,text:entry.text,score,provenance:row.provenance,expiresAt:row.expiresAt});
   }
   after=page.nextAfter;
  }while(after);
  const order=(a:SemanticMemoryHit,b:SemanticMemoryHit)=>b.score-a.score||(a.id<b.id?-1:a.id>b.id?1:0);
  matches.sort(order);
  if(hybrid){
   const words=terms(query),lexical=matches.map(hit=>{const found=terms(hit.text);let count=0;for(const word of words)if(found.has(word))count++;return {id:hit.id,score:words.size?count/words.size:0};}).filter(hit=>hit.score>0).sort((a,b)=>b.score-a.score||(a.id<b.id?-1:a.id>b.id?1:0));
   const ranks=new Map(lexical.map((hit,index)=>[hit.id,index+1]));matches.forEach((hit,index)=>{const rank=ranks.get(hit.id);hit.score=(61/(61+index)+(rank===undefined?0:61/(60+rank)))/2;});matches.sort(order);
  }
  const result:SemanticMemoryHit[]=[];
  for(const hit of matches){if(result.length===limit)break;const current=await this.memory.get(safeActor,safeScope,hit.id);if(current&&current.revision===hit.revision)result.push(hit);}
  return result;
 }
}
export type {Embedder as AgentMemoryEmbedder};
