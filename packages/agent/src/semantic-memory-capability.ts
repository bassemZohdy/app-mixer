import {AgentSemanticMemory,validSimilarity} from './semantic-memory.js';
import {type AgentMemoryScope} from './agent-memory.js';

const id=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(x);
type Context={tenantId:string;principalId:string};
type Registry={register:(candidate:{operationId:string;method:string;path:string;summary?:string},binding:{authorize:(context:Context)=>boolean|Promise<boolean>;validate:(input:unknown)=>boolean|Promise<boolean>;execute:(input:unknown,context:Context)=>unknown|Promise<unknown>})=>void};
type Options={memory:AgentSemanticMemory;scope:AgentMemoryScope;operationId:string;path:string;limit:number;mode?:'semantic'|'hybrid'|'indexed'|'lexical';minSimilarity?:number;maxCandidates?:number;authorize:(context:Context)=>boolean|Promise<boolean>};
/** Register a read-only search capability; the model cannot choose a different memory scope. */
export function registerSemanticMemorySearch(registry:Registry,options:Options):void {
 if(!registry||typeof registry.register!=='function'||!options||!(options.memory instanceof AgentSemanticMemory)||!options.scope||options.scope.kind!=='semantic'||!id(options.scope.tenantId)||!id(options.scope.agentId)||!options.scope.owner||!['organization','team','application','user'].includes(options.scope.owner.kind)||!id(options.scope.owner.id)||typeof options.operationId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(options.operationId)||typeof options.path!=='string'||!options.path.startsWith('/')||options.path.length>1024||/[\u0000-\u001f]/.test(options.path)||!Number.isSafeInteger(options.limit)||options.limit<1||options.limit>20||(options.mode!==undefined&&!['semantic','hybrid','indexed','lexical'].includes(options.mode))||(options.minSimilarity!==undefined&&(!validSimilarity(options.minSimilarity)||options.mode==='lexical'))||(options.maxCandidates!==undefined&&(!['indexed','lexical'].includes(options.mode??'semantic')||!Number.isSafeInteger(options.maxCandidates)||options.maxCandidates<options.limit||options.maxCandidates>1000))||typeof options.authorize!=='function')throw Error('Invalid memory capability');
 const scope=structuredClone(options.scope),{memory,operationId,path,limit,authorize}=options,mode=options.mode??'semantic',minSimilarity=options.minSimilarity,maxCandidates=options.maxCandidates??100;
 registry.register({operationId,method:'GET',path,summary:'Search authorized agent memory'}, {
  authorize:async context=>context.tenantId===scope.tenantId&&await authorize({...context})===true,
  validate:input=>{if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==1||!Object.hasOwn(input,'query'))return false;const query=(input as Record<string,unknown>).query;return !!query&&typeof query==='object'&&!Array.isArray(query)&&Object.keys(query).length===1&&typeof (query as Record<string,unknown>).text==='string'&&String((query as Record<string,unknown>).text).trim().length>0&&String((query as Record<string,unknown>).text).length<=2000;},
  execute:(input,context)=>{const actor={tenantId:context.tenantId,principalId:context.principalId},text=(input as {query:{text:string}}).query.text;if(mode==='indexed')return memory.searchIndexed(actor,scope,text,limit,maxCandidates,{minSimilarity});if(mode==='lexical')return memory.searchLexical(actor,scope,text,limit,maxCandidates);return memory[mode==='hybrid'?'searchHybrid':'search'](actor,scope,text,limit,{minSimilarity});}
 });
}
export type {Options as SemanticMemorySearchOptions};
