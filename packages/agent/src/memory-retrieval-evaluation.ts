import {AgentSemanticMemory} from './semantic-memory.js';
import type {AgentMemoryActor,AgentMemoryScope} from './agent-memory.js';

export type MemoryEvaluationCase={id:string;query:string;relevantIds:string[]};
export type MemoryEvaluationResult={id:string;retrievedIds:string[];recall:number;precision:number;reciprocalRank:number};
export type MemoryEvaluationReport={mode:'semantic'|'hybrid';limit:number;cases:MemoryEvaluationResult[];meanRecall:number;meanPrecision:number;meanReciprocalRank:number};
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(value);

/** Evaluate a host-labeled set sequentially using the same scoped and authorized search as production. */
export async function evaluateAgentMemoryRetrieval(options:{memory:AgentSemanticMemory;actor:AgentMemoryActor;scope:AgentMemoryScope;mode:'semantic'|'hybrid';limit:number;cases:MemoryEvaluationCase[]}):Promise<MemoryEvaluationReport>{
 if(!options||!(options.memory instanceof AgentSemanticMemory)||!['semantic','hybrid'].includes(options.mode)||!Number.isSafeInteger(options.limit)||options.limit<1||options.limit>20||!Array.isArray(options.cases)||options.cases.length<1||options.cases.length>100)throw Error('Invalid memory evaluation');
 const {memory,mode,limit}=options,actor=structuredClone(options.actor),scope=structuredClone(options.scope),cases=structuredClone(options.cases),seen=new Set<string>();
 for(const item of cases){if(!item||!id(item.id)||seen.has(item.id)||typeof item.query!=='string'||!item.query.trim()||item.query.length>2000||!Array.isArray(item.relevantIds)||item.relevantIds.length<1||item.relevantIds.length>100||item.relevantIds.some(value=>!id(value))||new Set(item.relevantIds).size!==item.relevantIds.length)throw Error('Invalid memory evaluation');seen.add(item.id);}
 const results:MemoryEvaluationResult[]=[];
 for(const item of cases){
  const hits=mode==='hybrid'?await memory.searchHybrid(actor,scope,item.query,limit):await memory.search(actor,scope,item.query,limit),relevant=new Set(item.relevantIds),retrievedIds=hits.map(hit=>hit.id),matches=retrievedIds.filter(value=>relevant.has(value)),first=retrievedIds.findIndex(value=>relevant.has(value));
  results.push({id:item.id,retrievedIds,recall:matches.length/relevant.size,precision:matches.length/limit,reciprocalRank:first<0?0:1/(first+1)});
 }
 const mean=(key:'recall'|'precision'|'reciprocalRank')=>results.reduce((sum,result)=>sum+result[key],0)/results.length;
 return {mode,limit,cases:results,meanRecall:mean('recall'),meanPrecision:mean('precision'),meanReciprocalRank:mean('reciprocalRank')};
}
