import {SqliteAgentMemory,type AgentMemoryScope,type AgentMemoryActor,type AgentMemoryProvenance} from './agent-memory.js';

type Embedder={modelId:string;dimensions:number;embed:(text:string)=>Promise<number[]>};
export type SemanticMemoryHit={id:string;revision:number;text:string;score:number;provenance:AgentMemoryProvenance;expiresAt:number};
const validId=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(x);
const validText=(x:unknown):x is string=>typeof x==='string'&&x.trim().length>0&&x.length<=2000;
function normalize(vector:unknown,dimensions:number):number[]{
 if(!Array.isArray(vector)||vector.length!==dimensions||vector.some(x=>typeof x!=='number'||!Number.isFinite(x)||Math.abs(x)>1000000))throw Error('Invalid embedding');
 const norm=Math.hypot(...vector);if(!Number.isFinite(norm)||norm===0)throw Error('Invalid embedding');return vector.map(x=>x/norm);
}
function semanticScope(scope:AgentMemoryScope):AgentMemoryScope{if(!scope||scope.kind!=='semantic')throw Error('Invalid semantic scope');return structuredClone(scope);}
/** Exact cosine search over authorized records using a host-selected embedding model. */
export class AgentSemanticMemory {
 private readonly modelId:string;private readonly dimensions:number;private readonly embed:Embedder['embed'];
 constructor(private readonly memory:SqliteAgentMemory,embedding:Embedder){
  if(!(memory instanceof SqliteAgentMemory)||!embedding||!validId(embedding.modelId)||!Number.isSafeInteger(embedding.dimensions)||embedding.dimensions<1||embedding.dimensions>2048||typeof embedding.embed!=='function')throw Error('Invalid embedding configuration');
  this.modelId=embedding.modelId;this.dimensions=embedding.dimensions;this.embed=embedding.embed;
 }
 async put(actor:AgentMemoryActor,scope:AgentMemoryScope,memoryId:string,text:string,options:{expectedRevision:number|null;expiresAt:number;provenance:AgentMemoryProvenance}):Promise<void>{
  const safeActor=structuredClone(actor),safeScope=semanticScope(scope),safeOptions=structuredClone(options);if(!validId(memoryId)||!validText(text)||!safeOptions||(safeOptions.expectedRevision!==null&&(!Number.isSafeInteger(safeOptions.expectedRevision)||safeOptions.expectedRevision<1))||!Number.isSafeInteger(safeOptions.expiresAt)||!safeOptions.provenance||!['run','human','system'].includes(safeOptions.provenance.kind)||!validId(safeOptions.provenance.id))throw Error('Invalid semantic memory');
  await this.memory.assertAccess(safeActor,safeScope,'write',memoryId);
  const vector=normalize(await this.embed(text),this.dimensions);
  await this.memory.put(safeActor,safeScope,memoryId,{format:'semantic-v1',modelId:this.modelId,text,vector},safeOptions);
 }
 async search(actor:AgentMemoryActor,scope:AgentMemoryScope,query:string,limit=5):Promise<SemanticMemoryHit[]>{
  const safeActor=structuredClone(actor),safeScope=semanticScope(scope);if(!validText(query)||!Number.isSafeInteger(limit)||limit<1||limit>20)throw Error('Invalid semantic query');
  await this.memory.assertAccess(safeActor,safeScope,'list');const queryVector=normalize(await this.embed(query),this.dimensions);
  const matches:SemanticMemoryHit[]=[];let after:string|undefined,pages=0;
  do{
   if(++pages>11)throw Error('Semantic memory scan limit exceeded');const page=await this.memory.list(safeActor,safeScope,{after,limit:100});
   for(const row of page.items){const v=row.value;if(!v||typeof v!=='object'||Array.isArray(v))continue;const entry=v as Record<string,unknown>;
    if(entry.format!=='semantic-v1'||entry.modelId!==this.modelId||!validText(entry.text))continue;
    let vector:number[];try{vector=normalize(entry.vector,this.dimensions);}catch{continue;}
    const score=Math.max(-1,Math.min(1,vector.reduce((sum,value,index)=>sum+value*queryVector[index],0)));
    matches.push({id:row.id,revision:row.revision,text:entry.text,score,provenance:row.provenance,expiresAt:row.expiresAt});
   }
   after=page.nextAfter;
  }while(after);
  matches.sort((a,b)=>b.score-a.score||(a.id<b.id?-1:a.id>b.id?1:0));const result:SemanticMemoryHit[]=[];
  for(const hit of matches){if(result.length===limit)break;const current=await this.memory.get(safeActor,safeScope,hit.id);if(current&&current.revision===hit.revision)result.push(hit);}
  return result;
 }
}
export type {Embedder as AgentMemoryEmbedder};
