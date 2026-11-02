import {SqliteAgentRuns,type AgentRunScope} from './durable-runs.js';
import {DurableAgentWorker} from './durable-worker.js';

type Options={runs:SqliteAgentRuns;worker:DurableAgentWorker;scope:AgentRunScope;maxPerPass:number;pollMs:number;onError:(error:unknown,runId?:string)=>void};
const id=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(x);
/** Explicitly started local dispatcher; run policy and side effects remain with the worker. */
export class DurableAgentDispatcher {
 private readonly options:Options;private readonly scope:AgentRunScope;private active=false;private generation=0;private pending?:Promise<number>;private timer?:ReturnType<typeof setTimeout>;private cursor?:string;
 constructor(options:Options){
  if(!options)throw Error('Invalid agent dispatcher');options={...options};
  if(!(options.runs instanceof SqliteAgentRuns)||!(options.worker instanceof DurableAgentWorker)||!options.worker.usesRegistry(options.runs)||!options.scope||!id(options.scope.tenantId)||!id(options.scope.agentId)||!Number.isSafeInteger(options.maxPerPass)||options.maxPerPass<1||options.maxPerPass>100||!Number.isSafeInteger(options.pollMs)||options.pollMs<100||options.pollMs>3600000||typeof options.onError!=='function')throw Error('Invalid agent dispatcher');
  this.options={...options};this.scope={tenantId:options.scope.tenantId,agentId:options.scope.agentId};
 }
 private report(error:unknown,runId?:string):void{try{this.options.onError(error,runId);}catch{}}
 private async pass(keepGoing:()=>boolean):Promise<number>{
  const page=this.options.runs.queuedPage(this.scope,{after:this.cursor,limit:this.options.maxPerPass});let processed=0;
  for(const runId of page.runIds){if(!keepGoing())return processed;try{await this.options.worker.runOnce(this.scope,runId);processed++;}catch(error){this.report(error,runId);}finally{if(keepGoing())this.cursor=runId;}}
  if(keepGoing()&&!page.next)this.cursor=undefined;return processed;
 }
 runOnce():Promise<number>{if(this.active||this.pending)throw Error('Agent dispatcher already running');const generation=this.generation,pending=this.pass(()=>this.generation===generation);this.pending=pending;void pending.finally(()=>{if(this.pending===pending)this.pending=undefined;}).catch(()=>{});return pending;}
 start():void{if(this.active||this.pending)throw Error('Agent dispatcher already running');this.active=true;const loop=()=>{if(!this.active)return;const pending=this.pass(()=>this.active);this.pending=pending;void pending.catch(error=>this.report(error)).finally(()=>{if(this.pending===pending)this.pending=undefined;if(this.active)this.timer=setTimeout(loop,this.options.pollMs);});};loop();}
 async stop():Promise<void>{this.active=false;this.generation++;if(this.timer)clearTimeout(this.timer);this.timer=undefined;const pending=this.pending;if(pending)try{await pending;}catch{}}
}
export type {Options as DurableAgentDispatcherOptions};
