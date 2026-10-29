import {SqliteAgentSchedules,type AgentSchedule,type AgentScheduleCursor} from './agent-schedules.js';
import {type AgentRunScope} from './durable-runs.js';
import {type AgentDefinitionVersion} from './persistent-definitions.js';

type Options={schedules:SqliteAgentSchedules;scope:AgentRunScope;definitions:{get:(tenantId:string,agentId:string)=>AgentDefinitionVersion|undefined};authorize:(schedule:AgentSchedule,definition:AgentDefinitionVersion)=>boolean|Promise<boolean>;maxPending:number;maxPerPass:number;pollMs:number;onError:(error:unknown)=>void;clock?:()=>number};
/** Host-driven polling for one agent; starts only when explicitly enabled. */
export class AgentScheduleWorker {
 private readonly scope:AgentRunScope;private readonly clock:()=>number;private active=false;private pending?:Promise<number>;private timer?:ReturnType<typeof setTimeout>;private cursor?:AgentScheduleCursor;
 constructor(private readonly options:Options){
  if(!options||!(options.schedules instanceof SqliteAgentSchedules)||!options.scope||typeof options.scope.tenantId!=='string'||typeof options.scope.agentId!=='string'||!options.definitions||typeof options.definitions.get!=='function'||typeof options.authorize!=='function'||!Number.isSafeInteger(options.maxPending)||options.maxPending<1||options.maxPending>10000||!Number.isSafeInteger(options.maxPerPass)||options.maxPerPass<1||options.maxPerPass>100||!Number.isSafeInteger(options.pollMs)||options.pollMs<100||options.pollMs>3600000||typeof options.onError!=='function'||(options.clock!==undefined&&typeof options.clock!=='function'))throw Error('Invalid schedule worker');
  this.scope={tenantId:options.scope.tenantId,agentId:options.scope.agentId};this.clock=options.clock??Date.now;
 }
 private async pass(keepGoing:()=>boolean):Promise<number>{
  const {schedules,definitions,authorize,maxPending,maxPerPass}=this.options,now=this.clock();let fired=0;
  const page=schedules.duePage(this.scope,now,maxPerPass,this.cursor);
  for(const schedule of page.items){
   if(!keepGoing())return fired;
   try{
    const definition=definitions.get(this.scope.tenantId,this.scope.agentId);
    if(!definition||!definition.manifest.lifecycle.enabled||definition.manifest.tenantId!==this.scope.tenantId||definition.manifest.agentId!==this.scope.agentId)continue;
    if(await authorize(structuredClone(schedule),structuredClone(definition))!==true||!keepGoing())continue;
    const latest=definitions.get(this.scope.tenantId,this.scope.agentId);if(!latest||latest.version!==definition.version||!latest.manifest.lifecycle.enabled)continue;
    schedules.fire(this.scope,schedule.scheduleId,schedule.revision,{definitionVersion:definition.version,maxAttempts:definition.manifest.lifecycle.maxAttempts,runTimeoutMs:definition.manifest.lifecycle.runTimeoutMs,maxPending},this.clock());fired++;
   }catch(error){if(!(error instanceof Error&&error.message==='Schedule revision conflict'))this.options.onError(error);}
   finally{if(keepGoing())this.cursor={nextAt:schedule.nextAt,scheduleId:schedule.scheduleId};}
  }
  if(keepGoing()&&!page.next)this.cursor=undefined;return fired;
 }
 runOnce():Promise<number>{if(this.active||this.pending)throw Error('Schedule pass already running');const pending=this.pass(()=>true);this.pending=pending;void pending.finally(()=>{if(this.pending===pending)this.pending=undefined;}).catch(()=>{});return pending;}
 start():void{
  if(this.active||this.pending)throw Error('Schedule worker already running');this.active=true;
  const loop=()=>{if(!this.active)return;const pending=this.pass(()=>this.active);this.pending=pending;
   void pending.catch(error=>{try{this.options.onError(error);}catch{}}).finally(()=>{if(this.pending===pending)this.pending=undefined;if(this.active)this.timer=setTimeout(loop,this.options.pollMs);});};
  loop();
 }
 async stop():Promise<void>{this.active=false;if(this.timer)clearTimeout(this.timer);this.timer=undefined;const pending=this.pending;if(pending)try{await pending;}catch{};}
}
export type {Options as AgentScheduleWorkerOptions};
