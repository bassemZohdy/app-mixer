import {ROOT_CONTEXT,SpanKind,SpanStatusCode,type Tracer,type Span} from '@opentelemetry/api';
import {parseAgentTraceParent} from './agent-trace-context.js';
import {SqliteAgentSchedules,type AgentSchedule,type AgentScheduleCursor} from './agent-schedules.js';
import {type AgentRunScope} from './durable-runs.js';
import {type AgentDefinitionVersion} from './persistent-definitions.js';

type Options={schedules:SqliteAgentSchedules;scope:AgentRunScope;definitions:{get:(tenantId:string,agentId:string)=>AgentDefinitionVersion|undefined|Promise<AgentDefinitionVersion|undefined>;getWithSignal?:(tenantId:string,agentId:string,signal:AbortSignal)=>AgentDefinitionVersion|undefined|Promise<AgentDefinitionVersion|undefined>};authorize:(schedule:AgentSchedule,definition:AgentDefinitionVersion,signal:AbortSignal)=>boolean|Promise<boolean>;maxPending:number;maxPerPass:number;pollMs:number;onError:(error:unknown)=>void;clock?:()=>number;auditActorId?:string;tracing?:{tracer:Tracer;propagateToRun?:boolean}};
/** Host-driven polling for one agent; starts only when explicitly enabled. */
export class AgentScheduleWorker {
 private readonly options:Options;private readonly scope:AgentRunScope;private readonly clock:()=>number;private readonly auditActorId:string|undefined;private readonly tracer:Tracer|undefined;private readonly propagateToRun:boolean;private active=false;private generation=0;private pending?:Promise<number>;private timer?:ReturnType<typeof setTimeout>;private cursor?:AgentScheduleCursor;private controller?:AbortController;
 constructor(options:Options){
  if(!options)throw Error('Invalid schedule worker');options={...options};
  if(!(options.schedules instanceof SqliteAgentSchedules)||!options.scope||typeof options.scope.tenantId!=='string'||typeof options.scope.agentId!=='string'||!options.definitions||typeof options.definitions.get!=='function'||(options.definitions.getWithSignal!==undefined&&typeof options.definitions.getWithSignal!=='function')||typeof options.authorize!=='function'||!Number.isSafeInteger(options.maxPending)||options.maxPending<1||options.maxPending>10000||!Number.isSafeInteger(options.maxPerPass)||options.maxPerPass<1||options.maxPerPass>100||!Number.isSafeInteger(options.pollMs)||options.pollMs<100||options.pollMs>3600000||typeof options.onError!=='function'||(options.clock!==undefined&&typeof options.clock!=='function')||(options.auditActorId!==undefined&&(typeof options.auditActorId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(options.auditActorId)))||(options.tracing!==undefined&&(!options.tracing||!options.tracing.tracer||typeof options.tracing.tracer.startSpan!=='function'||(options.tracing.propagateToRun!==undefined&&typeof options.tracing.propagateToRun!=='boolean'))))throw Error('Invalid schedule worker');
  this.options={...options};this.scope={tenantId:options.scope.tenantId,agentId:options.scope.agentId};this.clock=options.clock??Date.now;this.auditActorId=options.auditActorId;this.tracer=options.tracing?.tracer;this.propagateToRun=options.tracing?.propagateToRun===true;
 }
 private async pass(keepGoing:()=>boolean,signal:AbortSignal):Promise<number>{
  const {schedules,definitions,authorize,maxPending,maxPerPass}=this.options,now=this.clock();let fired=0;
  const page=schedules.duePage(this.scope,now,maxPerPass,this.cursor),get=()=>definitions.getWithSignal?definitions.getWithSignal(this.scope.tenantId,this.scope.agentId,signal):definitions.get(this.scope.tenantId,this.scope.agentId);
  for(const schedule of page.items){
   if(!keepGoing())return fired;
   try{
    const selected=await get();
    if(!keepGoing()||!selected||!selected.manifest.lifecycle.enabled||selected.manifest.tenantId!==this.scope.tenantId||selected.manifest.agentId!==this.scope.agentId)continue;
    const definition=structuredClone(selected);
    if(await authorize(structuredClone(schedule),structuredClone(definition),signal)!==true||!keepGoing())continue;
    const latest=await get();if(!keepGoing()||!latest||latest.version!==definition.version||!latest.manifest.lifecycle.enabled||latest.manifest.tenantId!==this.scope.tenantId||latest.manifest.agentId!==this.scope.agentId)continue;
    if(await authorize(structuredClone(schedule),structuredClone(latest),signal)!==true||!keepGoing())continue;
    let span:Span|undefined,parent:string|undefined;try{if(this.tracer){span=this.tracer.startSpan('agent.schedule.enqueue',{kind:SpanKind.PRODUCER},ROOT_CONTEXT);if(this.propagateToRun){const sc=span.spanContext(),candidate=`00-${sc.traceId}-${sc.spanId}-${sc.traceFlags.toString(16).padStart(2,'0')}`;if(parseAgentTraceParent(candidate))parent=candidate;}}}catch{}
    try{schedules.fire(this.scope,schedule.scheduleId,schedule.revision,{definitionVersion:definition.version,maxAttempts:definition.manifest.lifecycle.maxAttempts,runTimeoutMs:definition.manifest.lifecycle.runTimeoutMs,maxPending,...(parent?{traceParent:parent}:{})},this.clock(),this.auditActorId);fired++;}catch(error){try{span?.setStatus({code:SpanStatusCode.ERROR});span?.setAttribute('error.type','agent_schedule_enqueue_failed');}catch{}throw error;}finally{try{span?.end();}catch{}}
   }catch(error){if(keepGoing()&&!(error instanceof Error&&error.message==='Schedule revision conflict'))this.options.onError(error);}
   finally{if(keepGoing())this.cursor={nextAt:schedule.nextAt,scheduleId:schedule.scheduleId};}
  }
  if(keepGoing()&&!page.next)this.cursor=undefined;return fired;
 }
 private begin(keepGoing:()=>boolean):Promise<number>{const controller=new AbortController();this.controller=controller;const pending=this.pass(()=>!controller.signal.aborted&&keepGoing(),controller.signal);this.pending=pending;void pending.finally(()=>{if(this.pending===pending)this.pending=undefined;if(this.controller===controller)this.controller=undefined;}).catch(()=>{});return pending;}
 runOnce():Promise<number>{if(this.active||this.pending)throw Error('Schedule pass already running');const generation=this.generation;return this.begin(()=>this.generation===generation);}
 start():void{
  if(this.active||this.pending)throw Error('Schedule worker already running');this.active=true;const generation=++this.generation;
  const loop=()=>{if(!this.active||this.generation!==generation)return;const pending=this.begin(()=>this.active&&this.generation===generation);
   void pending.catch(error=>{try{this.options.onError(error);}catch{}}).finally(()=>{if(this.active&&this.generation===generation)this.timer=setTimeout(loop,this.options.pollMs);});};
  loop();
 }
 async stop():Promise<void>{this.active=false;this.generation++;if(this.timer)clearTimeout(this.timer);this.timer=undefined;this.controller?.abort();const pending=this.pending;if(pending)try{await pending;}catch{};}
}
export type {Options as AgentScheduleWorkerOptions};
