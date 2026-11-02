import type {AgentRunMetricsActor} from './agent-run-metrics.js';

type Source={render:(actor:AgentRunMetricsActor)=>string|Promise<string>};
export type AgentCombinedMetricsOptions={sources:Source[];authorize:(actor:AgentRunMetricsActor)=>boolean|Promise<boolean>};
const valid=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(value);

/** Combine explicitly selected, independently authorized metric sources on one listener. */
export class AgentCombinedMetrics{
 private readonly authorize:AgentCombinedMetricsOptions['authorize'];
 private readonly sources:Source['render'][];
 constructor(options:AgentCombinedMetricsOptions){
  if(!options||!Array.isArray(options.sources)||options.sources.length<1||options.sources.length>10||typeof options.authorize!=='function')throw Error('Invalid combined metrics configuration');
  this.sources=options.sources.map(source=>{if(!source||typeof source.render!=='function')throw Error('Invalid combined metrics configuration');return source.render.bind(source);});this.authorize=options.authorize;
 }
 private async permit(actor:AgentRunMetricsActor):Promise<void>{try{if(await this.authorize({...actor})===true)return;}catch{}throw Error('Agent metrics access denied');}
 async render(actor:AgentRunMetricsActor):Promise<string>{
  if(!actor||!valid(actor.tenantId)||!valid(actor.principalId))throw Error('Invalid agent metrics actor');const who={tenantId:actor.tenantId,principalId:actor.principalId};await this.permit(who);const parts:string[]=[],names=new Set<string>();let bytes=0;
  for(const source of this.sources){const value=await source({...who});if(typeof value!=='string'||value.includes('\0'))throw Error('Invalid combined metrics data');const part=value.replace(/\n+$/,'')+'\n';bytes+=Buffer.byteLength(part);if(bytes>65536)throw Error('Invalid combined metrics data');for(const match of part.matchAll(/^# TYPE ([a-zA-Z_:][a-zA-Z0-9_:]*) /gm)){if(names.has(match[1]))throw Error('Duplicate combined metric');names.add(match[1]);}parts.push(part);}
  await this.permit(who);return parts.join('');
 }
}
