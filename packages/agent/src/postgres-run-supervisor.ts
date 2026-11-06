import type {ActionVerification,ActionVerificationRequest} from './action-journal.js';
import type {AgentRunScope} from './durable-runs.js';
import type {PostgresAgentActionJournal,PostgresAgentRun,PostgresAgentRuns,PostgresRunClaimLimits} from './postgres-agent-runs.js';

type Outcome='succeeded'|'failed'|'stopped'|'uncertain';
export type PostgresRunExecution={run:PostgresAgentRun;journal:PostgresAgentActionJournal;signal:AbortSignal};
export type PostgresRunSupervisorEvent=
 {type:'claimed'|'settled'|'recovered'|'retried'|'failed'|'review';runId:string;status?:string|undefined}|
 {type:'reconciled';runId:string;actionId:string;outcome:ActionVerification['outcome']};
export type PostgresRunSupervisorOptions={
 runs:PostgresAgentRuns;scope:AgentRunScope;workerId:string;
 /** Perform one claimed run through `journal`; stop promptly when `signal` aborts (lease lost or stopping). */
 execute:(execution:PostgresRunExecution)=>Promise<Outcome>;
 /** Ask the external system whether an interrupted action took effect, without replaying it. */
 verify:(request:ActionVerificationRequest)=>Promise<ActionVerification>;
 onError:(error:unknown)=>void;onEvent?:(event:PostgresRunSupervisorEvent)=>void;
 leaseMs?:number;pollMs?:number;maxConcurrent?:number;limits?:PostgresRunClaimLimits;recoveryGraceMs?:number;
};
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(value);
const bounded=(value:unknown,min:number,max:number)=>Number.isSafeInteger(value)&&Number(value)>=min&&Number(value)<=max;
const lostRace=/revision conflict|cannot be claimed|Lease is active|Invalid run state|Invalid action state|verification stale|concurrency limit|daily run limit|Run is not uncertain/;

/**
 * The scheduling loop for one worker process sharing a PostgresAgentRuns registry with other nodes. Each pass
 * recovers runs whose lease expired more than `recoveryGraceMs` ago, reconciles uncertain runs by verifying each
 * interrupted action, then claims queued runs up to `maxConcurrent` and executes them with lease renewal.
 * `stop()` stops claiming and waits for running executions (a deployment's termination grace period).
 */
export class PostgresRunSupervisor {
 private readonly o:Required<Omit<PostgresRunSupervisorOptions,'onEvent'|'limits'>>&Pick<PostgresRunSupervisorOptions,'onEvent'|'limits'>;
 private readonly active=new Map<string,{controller:AbortController;done:Promise<void>}>();
 private timer:ReturnType<typeof setTimeout>|undefined;private pass:Promise<void>|undefined;private running=false;private stopped=false;
 constructor(options:PostgresRunSupervisorOptions){
  const o={leaseMs:30000,pollMs:1000,maxConcurrent:1,recoveryGraceMs:5000,...options};
  if(!options||!o.runs||typeof o.runs.claim!=='function'||!o.scope||!id(o.scope.tenantId)||!id(o.scope.agentId)||!id(o.workerId)||typeof o.execute!=='function'||typeof o.verify!=='function'||typeof o.onError!=='function'||(o.onEvent!==undefined&&typeof o.onEvent!=='function')||!bounded(o.leaseMs,1000,3600000)||!bounded(o.pollMs,10,600000)||!bounded(o.maxConcurrent,1,100)||!bounded(o.recoveryGraceMs,0,86400000))throw Error('Invalid run supervisor configuration');
  this.o={...o,scope:{tenantId:o.scope.tenantId,agentId:o.scope.agentId}};
 }
 /** Runs currently executing on this worker. */
 get executing():number{return this.active.size;}
 start():void{if(this.running)return;this.running=true;const loop=()=>{if(!this.running)return;this.pass=this.runOnce().catch(error=>this.o.onError(error)).finally(()=>{if(this.running)this.timer=setTimeout(loop,this.o.pollMs);});};loop();}
 /** Stop claiming, wait for the current pass and every running execution. With `abort`, executions are signalled to stop. */
 async stop(options:{abort?:boolean}={}):Promise<void>{this.running=false;this.stopped=true;clearTimeout(this.timer);await this.pass;if(options?.abort)for(const {controller} of this.active.values())controller.abort(Error('Worker stopping'));await Promise.all([...this.active.values()].map(entry=>entry.done));}
 /** One pass: recover, reconcile, then claim. Executions continue in the background. */
 async runOnce():Promise<void>{await this.recover();if(!this.stopped)await this.claim();}
 private event(event:PostgresRunSupervisorEvent):void{try{this.o.onEvent?.(event);}catch(error){this.o.onError(error);}}
 private async guard(operation:()=>Promise<void>):Promise<void>{try{await operation();}catch(error){if(!(error instanceof Error&&lostRace.test(error.message)))this.o.onError(error);}}
 private async recover():Promise<void>{
  const {runs,scope}=this.o;
  for(const run of await runs.expiredLeases(scope,50,this.o.recoveryGraceMs))await this.guard(async()=>{await runs.recoverExpired(scope,run.runId,run.revision);this.event({type:'recovered',runId:run.runId});});
  for(const run of await runs.uncertain(scope))await this.guard(()=>this.reconcile(run));
 }
 private async reconcile(run:PostgresAgentRun):Promise<void>{
  const {runs,scope}=this.o,journal=runs.journal(scope,run.runId,'recovery');let review=false;
  for(const action of await journal.unresolved()){
   if(action.status==='dispatching')await journal.markUncertain(action.actionId);
   const outcome=await journal.reconcileWith(action.actionId,this.o.verify);this.event({type:'reconciled',runId:run.runId,actionId:action.actionId,outcome});if(outcome==='unknown')review=true;
  }
  if(review){this.event({type:'review',runId:run.runId});return;}
  const current=await runs.get(scope,run.runId);if(!current||current.status!=='uncertain')return;
  try{await runs.reconcile(scope,run.runId,current.revision,'retry');this.event({type:'retried',runId:run.runId});}
  catch(error){if(!(error instanceof Error&&/cannot be retried/.test(error.message)))throw error;await runs.reconcile(scope,run.runId,current.revision,'failed');this.event({type:'failed',runId:run.runId});}
 }
 private async claim():Promise<void>{
  const {runs,scope}=this.o;
  for(const run of await runs.queued(scope)){
   if(this.active.size>=this.o.maxConcurrent||this.stopped)return;
   let lease:PostgresAgentRun|undefined;
   await this.guard(async()=>{lease=await runs.claim(scope,run.runId,run.revision,this.o.workerId,this.o.leaseMs,this.o.limits);});
   if(lease){this.event({type:'claimed',runId:lease.runId});this.launch(lease);}
  }
 }
 private launch(lease:PostgresAgentRun):void{
  const {runs,scope}=this.o,controller=new AbortController(),token=lease.leaseToken!;let revision=lease.revision;
  const renewal=setInterval(()=>{runs.renew(scope,lease.runId,revision,token,this.o.leaseMs).then(run=>{revision=run.revision;}).catch(async()=>{
   // A pause or cancel request changes the revision; follow it. Anything else means the lease is gone.
   const current=await runs.get(scope,lease.runId).catch(()=>undefined);
   if(current&&current.leaseToken===token&&current.status==='running'){revision=current.revision;return;}
   if(current&&current.leaseToken===token&&(current.status==='pause_requested'||current.status==='cancel_requested')){revision=current.revision;controller.abort(Error('Stop requested'));return;}
   controller.abort(Error('Lease lost'));
  });},Math.max(500,Math.floor(this.o.leaseMs/3)));
  const done=(async()=>{
   let outcome:Outcome;
   try{const result=await this.o.execute({run:lease,journal:runs.journal(scope,lease.runId,token),signal:controller.signal});outcome=['succeeded','failed','stopped','uncertain'].includes(result)?result:'uncertain';}catch{outcome='uncertain';}
   clearInterval(renewal);
   await this.guard(async()=>{const current=await runs.get(scope,lease.runId);if(!current||current.leaseToken!==token)return;
    // Stopping this worker (not a pause or cancel request) hands the run back as uncertain so another node retries it.
    const final=outcome==='stopped'&&current.status==='running'?'uncertain':outcome;
    const settled=await runs.settle(scope,lease.runId,current.revision,token,final);this.event({type:'settled',runId:lease.runId,status:settled.status});});
  })().finally(()=>this.active.delete(lease.runId));
  this.active.set(lease.runId,{controller,done});
 }
}
