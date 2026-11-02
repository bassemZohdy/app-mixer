import type {AgentRunMetricsActor} from './agent-run-metrics.js';

type Source={render:(actor:AgentRunMetricsActor)=>string|Promise<string>;renderWithSignal?:(actor:AgentRunMetricsActor,signal:AbortSignal)=>string|Promise<string>};
export type AgentCombinedMetricsOptions={sources:Source[];authorize:(actor:AgentRunMetricsActor,signal:AbortSignal)=>boolean|Promise<boolean>;callbackTimeoutMs?:number;maxPendingCallbacks?:number};
const valid=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(value);

/** Combine explicitly selected, independently authorized metric sources on one listener. */
export class AgentCombinedMetrics{
 private readonly authorize:AgentCombinedMetricsOptions['authorize'];
 private readonly sources:((actor:AgentRunMetricsActor,signal:AbortSignal)=>string|Promise<string>)[];
 private readonly callbackTimeoutMs:number|undefined;private readonly maxPendingCallbacks:number|undefined;private callbacksInFlight=0;
 constructor(options:AgentCombinedMetricsOptions){
  if(!options||!Array.isArray(options.sources)||options.sources.length<1||options.sources.length>10||typeof options.authorize!=='function')throw Error('Invalid combined metrics configuration');
  if((options.callbackTimeoutMs===undefined)!==(options.maxPendingCallbacks===undefined)||(options.callbackTimeoutMs!==undefined&&(!Number.isInteger(options.callbackTimeoutMs)||options.callbackTimeoutMs<100||options.callbackTimeoutMs>30000))||(options.maxPendingCallbacks!==undefined&&(!Number.isInteger(options.maxPendingCallbacks)||options.maxPendingCallbacks<1||options.maxPendingCallbacks>100)))throw Error('Invalid combined metrics configuration');this.callbackTimeoutMs=options.callbackTimeoutMs;this.maxPendingCallbacks=options.maxPendingCallbacks;
  this.sources=options.sources.map(source=>{if(!source||typeof source.render!=='function'||(source.renderWithSignal!==undefined&&typeof source.renderWithSignal!=='function'))throw Error('Invalid combined metrics configuration');const plain=source.render.bind(source),cancellable=source.renderWithSignal?.bind(source);return (actor,signal)=>cancellable?cancellable(actor,signal):plain(actor);});this.authorize=options.authorize;
 }
 private async callback<T>(fn:(signal:AbortSignal)=>T|Promise<T>,parent:AbortSignal):Promise<T>{
  if(parent.aborted)throw Error('Combined metrics unavailable');if(this.callbackTimeoutMs===undefined){const value=await fn(parent);if(parent.aborted)throw Error('Combined metrics unavailable');return value;}if(this.callbacksInFlight>=this.maxPendingCallbacks!)throw Error('Combined metrics unavailable');const controller=new AbortController(),signal=AbortSignal.any([parent,controller.signal]);this.callbacksInFlight++;const task=Promise.resolve().then(()=>{if(signal.aborted)throw Error('Combined metrics unavailable');return fn(signal);});void task.then(()=>{this.callbacksInFlight--;},()=>{this.callbacksInFlight--;});let abort=()=>{};const cancelled=new Promise<never>((_resolve,reject)=>{abort=()=>reject(Error('Combined metrics unavailable'));if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});});const timer=setTimeout(()=>controller.abort(),this.callbackTimeoutMs);try{const result=await Promise.race([task,cancelled]);if(signal.aborted)throw Error('Combined metrics unavailable');return result;}finally{clearTimeout(timer);signal.removeEventListener('abort',abort);}
 }
 private async permit(actor:AgentRunMetricsActor,signal:AbortSignal):Promise<void>{const allowed=await this.callback(async callbackSignal=>{try{return await this.authorize({...actor},callbackSignal)===true;}catch{return false;}},signal);if(!allowed)throw Error('Agent metrics access denied');}
 async render(actor:AgentRunMetricsActor):Promise<string>{return this.renderWithSignal(actor,new AbortController().signal);}
 async renderWithSignal(actor:AgentRunMetricsActor,signal:AbortSignal):Promise<string>{
  if(!(signal instanceof AbortSignal))throw Error('Invalid agent metrics signal');
  if(!actor||!valid(actor.tenantId)||!valid(actor.principalId))throw Error('Invalid agent metrics actor');const who={tenantId:actor.tenantId,principalId:actor.principalId};await this.permit(who,signal);const parts:string[]=[],names=new Set<string>();let bytes=0;
  for(const source of this.sources){const value=await this.callback(callbackSignal=>source({...who},callbackSignal),signal);if(typeof value!=='string'||value.includes('\0'))throw Error('Invalid combined metrics data');const part=value.replace(/\n+$/,'')+'\n';bytes+=Buffer.byteLength(part);if(bytes>65536)throw Error('Invalid combined metrics data');for(const match of part.matchAll(/^# TYPE ([a-zA-Z_:][a-zA-Z0-9_:]*) /gm)){if(names.has(match[1]))throw Error('Duplicate combined metric');names.add(match[1]);}parts.push(part);}
  await this.permit(who,signal);return parts.join('');
 }
}
