import {type AgentDefinitionVersion} from './persistent-definitions.js';
import {SqliteAgentRuns,type AgentRunScope,type DurableAgentRun} from './durable-runs.js';

type Outcome='succeeded'|'failed'|'stopped'|'uncertain'|{status:'delegation_expired';grantId:string;revision:number}|{status:'approval_required';actionId:string};
type WorkerOptions={
 runs:SqliteAgentRuns;
 definitions:{get:(tenantId:string,agentId:string)=>AgentDefinitionVersion|undefined};
 workerId:string;leaseMs:number;pollMs:number;
 authorizeStart:(run:DurableAgentRun,definition:AgentDefinitionVersion)=>boolean|Promise<boolean>;
 execute:(run:DurableAgentRun,context:{signal:AbortSignal;assertLease:()=>void})=>Promise<Outcome>;
 clock?:()=>number;
};
/** Execute one explicitly selected run. The host supplies policy, execution and outcome classification. */
export class DurableAgentWorker {
 private readonly clock:()=>number;
 constructor(private readonly options:WorkerOptions){
  if(!options||!(options.runs instanceof SqliteAgentRuns)||!options.definitions||typeof options.definitions.get!=='function'||typeof options.workerId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(options.workerId)||!Number.isSafeInteger(options.leaseMs)||options.leaseMs<100||options.leaseMs>3600000||!Number.isSafeInteger(options.pollMs)||options.pollMs<10||options.pollMs*3>options.leaseMs||typeof options.authorizeStart!=='function'||typeof options.execute!=='function'||(options.clock!==undefined&&typeof options.clock!=='function'))throw Error('Invalid agent worker');
  this.clock=options.clock??Date.now;
 }
 async runOnce(scope:AgentRunScope,runId:string):Promise<DurableAgentRun>{
  scope={tenantId:scope.tenantId,agentId:scope.agentId};const {runs,definitions,workerId,leaseMs,pollMs,authorizeStart,execute}=this.options;
  let run=runs.get(scope,runId);if(!run||run.archived||run.status!=='queued')throw Error('Run unavailable');
  const definition=definitions.get(scope.tenantId,scope.agentId);
  if(!definition||definition.version!==run.definitionVersion||!definition.manifest.lifecycle.enabled||definition.manifest.tenantId!==scope.tenantId||definition.manifest.agentId!==scope.agentId)throw Error('Agent definition unavailable');
  const validDefinition=()=>{const latest=definitions.get(scope.tenantId,scope.agentId);return !!latest&&latest.version===run!.definitionVersion&&latest.manifest.lifecycle.enabled&&latest.manifest.tenantId===scope.tenantId&&latest.manifest.agentId===scope.agentId;};
  if(await authorizeStart(structuredClone(run),structuredClone(definition))!==true)throw Error('Agent run forbidden');
  if(!validDefinition())throw Error('Agent definition changed');
  run=runs.claim(scope,runId,run.revision,workerId,leaseMs,this.clock(),definition.manifest.quotas.maxConcurrentRuns,definition.manifest.quotas.maxRunsPerDay);const token=run.leaseToken!;
  const controller=new AbortController();let lost=false;
  const assertLease=()=>{
   const current=runs.get(scope,runId),now=this.clock();
   if(controller.signal.aborted||!validDefinition()||!current||current.leaseToken!==token||current.leaseOwner!==workerId||current.status!=='running'||current.leaseUntil===null||!Number.isSafeInteger(now)||now>=current.leaseUntil)throw Error('Agent run lease unavailable');
  };
  const pulse=()=>{
   try{assertLease();const current=runs.get(scope,runId)!;run=runs.renew(scope,runId,current.revision,token,leaseMs,this.clock());}
   catch{lost=true;controller.abort();}
  };
  const timer=setInterval(pulse,pollMs);let outcome:Outcome='uncertain',started=false;
  try{
   if(await authorizeStart(structuredClone(run),structuredClone(definition))!==true)throw Error('Agent run forbidden');
   assertLease();started=true;
   const result=await execute(structuredClone(run),{signal:controller.signal,assertLease});
   if(typeof result==='string'&&['succeeded','failed','stopped','uncertain'].includes(result))outcome=result;else if(result&&typeof result==='object'&&result.status==='delegation_expired')outcome={status:'delegation_expired',grantId:result.grantId,revision:result.revision};else if(result&&typeof result==='object'&&result.status==='approval_required')outcome={status:'approval_required',actionId:result.actionId};
  }catch{if(!started)outcome='failed';}
  finally{clearInterval(timer);}
  const current=runs.get(scope,runId);
  if(!current||current.leaseToken!==token||current.leaseOwner!==workerId||current.leaseUntil===null||this.clock()>=current.leaseUntil)throw Error('Agent run lease lost');
  if(typeof outcome==='object'){if(!lost&&current.status==='running'){try{return outcome.status==='approval_required'?runs.pauseForApproval(scope,runId,current.revision,token,outcome.actionId,this.clock()):runs.pauseForDelegation(scope,runId,current.revision,token,outcome.grantId,outcome.revision,this.clock());}catch{outcome='uncertain';}}else outcome=current.status==='pause_requested'||current.status==='cancel_requested'?'stopped':'uncertain';}
  if(lost&&outcome!=='succeeded'&&outcome!=='failed')outcome=current.status==='pause_requested'||current.status==='cancel_requested'?(outcome==='stopped'?'stopped':'uncertain'):'uncertain';
  if(outcome==='stopped'&&!['pause_requested','cancel_requested'].includes(current.status))outcome='uncertain';
  return runs.settle(scope,runId,current.revision,token,outcome,this.clock());
 }
}
export type {WorkerOptions as DurableAgentWorkerOptions,Outcome as DurableAgentWorkerOutcome};
