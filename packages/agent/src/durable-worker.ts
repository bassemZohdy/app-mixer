import {type AgentDefinitionVersion} from './persistent-definitions.js';
import {SqliteAgentRuns,type AgentRunScope,type DurableAgentRun} from './durable-runs.js';
import {context,trace,ROOT_CONTEXT,SpanKind,SpanStatusCode,type Tracer} from '@opentelemetry/api';
import {parseAgentTraceParent} from './agent-trace-context.js';
import {PostgresAgentRunSlots} from './postgres-run-slots.js';

type Outcome='succeeded'|'failed'|'stopped'|'uncertain'|{status:'delegation_expired';grantId:string;revision:number}|{status:'approval_required';actionId:string};
type WorkerOptions={
 runs:SqliteAgentRuns;
 definitions:{get:(tenantId:string,agentId:string)=>AgentDefinitionVersion|undefined|Promise<AgentDefinitionVersion|undefined>};
 asyncDefinitions?:boolean;
 workerId:string;leaseMs:number;pollMs:number;
 authorizeStart:(run:DurableAgentRun,definition:AgentDefinitionVersion)=>boolean|Promise<boolean>;
 execute:(run:DurableAgentRun,context:{signal:AbortSignal;assertLease:()=>void;assertLeaseAsync:()=>Promise<void>})=>Promise<Outcome>;
 clock?:()=>number;
 tracing?:{tracer:Tracer;usePersistedParent?:boolean};
 /** Optional shared slots enforcing the manifest's concurrency and daily-run quotas across workers on separate nodes. */
 sharedSlots?:PostgresAgentRunSlots;
};
/** Execute one explicitly selected run. The host supplies policy, execution and outcome classification. */
export class DurableAgentWorker {
 private readonly clock:()=>number;private readonly tracer:Tracer|undefined;private readonly usePersistedParent:boolean;
 constructor(private readonly options:WorkerOptions){
  if(!options||!(options.runs instanceof SqliteAgentRuns)||!options.definitions||typeof options.definitions.get!=='function'||(options.asyncDefinitions!==undefined&&typeof options.asyncDefinitions!=='boolean')||typeof options.workerId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(options.workerId)||!Number.isSafeInteger(options.leaseMs)||options.leaseMs<100||options.leaseMs>3600000||!Number.isSafeInteger(options.pollMs)||options.pollMs<10||options.pollMs*3>options.leaseMs||typeof options.authorizeStart!=='function'||typeof options.execute!=='function'||(options.clock!==undefined&&typeof options.clock!=='function')||(options.sharedSlots!==undefined&&!(options.sharedSlots instanceof PostgresAgentRunSlots))||(options.tracing!==undefined&&(!options.tracing||!options.tracing.tracer||typeof options.tracing.tracer.startSpan!=='function'||(options.tracing.usePersistedParent!==undefined&&typeof options.tracing.usePersistedParent!=='boolean'))))throw Error('Invalid agent worker');
  this.clock=options.clock??Date.now;this.tracer=options.tracing?.tracer;this.usePersistedParent=options.tracing?.usePersistedParent===true;
 }
 usesRegistry(runs:SqliteAgentRuns):boolean{return this.options.runs===runs;}
 async runOnce(scope:AgentRunScope,runId:string):Promise<DurableAgentRun>{
  if(!this.tracer)return this.executeOnce(scope,runId);let parent=context.active();if(this.usePersistedParent)try{const stored=this.options.runs.getTraceParent(scope,runId),parsed=parseAgentTraceParent(stored);if(parsed)parent=trace.setSpanContext(ROOT_CONTEXT,parsed);}catch{}let span;try{span=this.tracer.startSpan('agent.run',{kind:SpanKind.INTERNAL},parent);}catch{return this.executeOnce(scope,runId);}
  let pending:Promise<DurableAgentRun>|undefined;try{
   try{context.with(trace.setSpan(parent,span),()=>{pending=this.executeOnce(scope,runId);});}catch{if(!pending)pending=this.executeOnce(scope,runId);}
   const result=await pending!;try{const status=['queued','running','pause_requested','cancel_requested','paused','uncertain','succeeded','failed','cancelled'].includes(result.status)?result.status:'other';span.setAttribute('app_mixer.agent.run.status',status);if(status==='failed'||status==='uncertain'||status==='other')span.setStatus({code:SpanStatusCode.ERROR});}catch{}return result;
  }catch(error){try{span.setAttribute('error.type','agent_run_failed');span.setStatus({code:SpanStatusCode.ERROR});}catch{}throw error;}finally{try{span.end();}catch{}}
 }
 private async executeOnce(scope:AgentRunScope,runId:string):Promise<DurableAgentRun>{
  scope={tenantId:scope.tenantId,agentId:scope.agentId};const {runs,definitions,workerId,leaseMs,pollMs,authorizeStart,execute}=this.options;
  let run=runs.get(scope,runId);if(!run||run.archived||run.status!=='queued')throw Error('Run unavailable');
  const isAsync=this.options.asyncDefinitions===true;
  const lookup=()=>definitions.get(scope.tenantId,scope.agentId);
  const readSync=()=>{const value=lookup();if(value&&typeof (value as Promise<unknown>).then==='function'){void Promise.resolve(value).catch(()=>{});throw Error('Asynchronous definitions require asyncDefinitions');}return value as AgentDefinitionVersion|undefined;};
  const selected=isAsync?await lookup():readSync();
  if(!selected||selected.version!==run.definitionVersion||!selected.manifest.lifecycle.enabled||selected.manifest.tenantId!==scope.tenantId||selected.manifest.agentId!==scope.agentId)throw Error('Agent definition unavailable');
  const definition=structuredClone(selected);
  const matches=(latest:AgentDefinitionVersion|undefined)=>!!latest&&latest.version===run!.definitionVersion&&latest.manifest.lifecycle.enabled&&latest.manifest.tenantId===scope.tenantId&&latest.manifest.agentId===scope.agentId;
  const validDefinition=()=>matches(readSync());
  if(await authorizeStart(structuredClone(run),structuredClone(definition))!==true)throw Error('Agent run forbidden');
  if(!(isAsync?matches(await lookup()):validDefinition()))throw Error('Agent definition changed');
  const shared=this.options.sharedSlots,quotas=definition.manifest.quotas;let slot:string|undefined;
  if(shared)slot=await shared.acquire(scope,runId,workerId,leaseMs,{maxConcurrentRuns:quotas.maxConcurrentRuns,maxRunsPerDay:quotas.maxRunsPerDay});
  const releaseSlot=async()=>{if(shared&&slot)try{await shared.release(scope,runId,slot);}catch{}};
  try{run=runs.claim(scope,runId,run.revision,workerId,leaseMs,this.clock(),quotas.maxConcurrentRuns,quotas.maxRunsPerDay);}catch(error){await releaseSlot();throw error;}
  const token=run.leaseToken!;
  const controller=new AbortController();let lost=false;
  const assertLocalLease=()=>{
   const current=runs.get(scope,runId),now=this.clock();
   if(controller.signal.aborted||!current||current.leaseToken!==token||current.leaseOwner!==workerId||current.status!=='running'||current.leaseUntil===null||!Number.isSafeInteger(now)||now>=current.leaseUntil)throw Error('Agent run lease unavailable');
  };
  const assertLease=()=>{assertLocalLease();if(isAsync||!validDefinition())throw Error('Agent run lease unavailable');};
  const assertLeaseAsync=async()=>{assertLocalLease();if(!(isAsync?matches(await lookup()):validDefinition()))throw Error('Agent run lease unavailable');assertLocalLease();};
  let pulsing:Promise<void>|undefined;
  const pulse=async()=>{
   try{await assertLeaseAsync();const current=runs.get(scope,runId)!;run=runs.renew(scope,runId,current.revision,token,leaseMs,this.clock());if(shared&&slot&&!(await shared.renew(scope,runId,slot,leaseMs)))throw Error('Agent run slot lost');}
   catch{lost=true;controller.abort();}
  };
  const timer=setInterval(()=>{if(!pulsing)pulsing=pulse().finally(()=>{pulsing=undefined;});},pollMs);let outcome:Outcome='uncertain',started=false;
  try{
   if(await authorizeStart(structuredClone(run),structuredClone(definition))!==true)throw Error('Agent run forbidden');
   await assertLeaseAsync();started=true;
   const result=await execute(structuredClone(run),{signal:controller.signal,assertLease,assertLeaseAsync});
   if(isAsync&&result!=='stopped'&&result!=='uncertain')await assertLeaseAsync();
   if(typeof result==='string'&&['succeeded','failed','stopped','uncertain'].includes(result))outcome=result;else if(result&&typeof result==='object'&&result.status==='delegation_expired')outcome={status:'delegation_expired',grantId:result.grantId,revision:result.revision};else if(result&&typeof result==='object'&&result.status==='approval_required')outcome={status:'approval_required',actionId:result.actionId};
  }catch{if(!started)outcome='failed';}
  finally{clearInterval(timer);if(pulsing)await pulsing;}
  try{
  const current=runs.get(scope,runId);
  if(!current||current.leaseToken!==token||current.leaseOwner!==workerId||current.leaseUntil===null||this.clock()>=current.leaseUntil)throw Error('Agent run lease lost');
  if(typeof outcome==='object'){if(!lost&&current.status==='running'){try{return outcome.status==='approval_required'?runs.pauseForApproval(scope,runId,current.revision,token,outcome.actionId,this.clock()):runs.pauseForDelegation(scope,runId,current.revision,token,outcome.grantId,outcome.revision,this.clock());}catch{outcome='uncertain';}}else outcome=current.status==='pause_requested'||current.status==='cancel_requested'?'stopped':'uncertain';}
  if(lost&&(isAsync||outcome!=='succeeded'&&outcome!=='failed'))outcome=current.status==='pause_requested'||current.status==='cancel_requested'?(outcome==='stopped'?'stopped':'uncertain'):'uncertain';
  if(outcome==='stopped'&&!['pause_requested','cancel_requested'].includes(current.status))outcome='uncertain';
  return runs.settle(scope,runId,current.revision,token,outcome,this.clock());
  }finally{await releaseSlot();}
 }
}
export type {WorkerOptions as DurableAgentWorkerOptions,Outcome as DurableAgentWorkerOutcome};
