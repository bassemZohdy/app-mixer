import {checkKey,type DataScope} from './data-provider.js';
import {SqliteOfflineQueue,type OfflineOperation} from './offline-queue.js';
import {createBoundedOperation} from './bounded-operation.js';

type Actor={tenantId:string;principalId:string};
export type OfflineRetentionWorkerOptions={
  queue:SqliteOfflineQueue;scope:DataScope;queuePrincipalId:string;operationId:string;operatorId:string;reference:string;
  minAgeMs:number;maxPerPass:number;pollMs:number;policyTimeoutMs?:number;maxPendingPolicies?:number;
  authorize:(actor:Actor,scope:DataScope,operation:OfflineOperation,signal:AbortSignal)=>boolean|Promise<boolean>;
  onError:(error:unknown)=>void|Promise<void>;now?:()=>number;
};

/** Opt-in host-controlled retention; only known-old terminal operations can be retired. */
export class OfflineRetentionWorker {
  private readonly queue:SqliteOfflineQueue;private readonly scope:DataScope;private readonly queuePrincipalId:string;private readonly operationId:string;private readonly actor:Actor;private readonly reference:string;
  private readonly minAgeMs:number;private readonly maxPerPass:number;private readonly pollMs:number;private readonly authorize:OfflineRetentionWorkerOptions['authorize'];private readonly onError:OfflineRetentionWorkerOptions['onError'];private readonly now:()=>number;
  private readonly runPolicy:ReturnType<typeof createBoundedOperation>;
  private cursor?:string;private active=false;private generation=0;private pending?:Promise<number>;private controller?:AbortController;private timer?:ReturnType<typeof setTimeout>;
  constructor(options:OfflineRetentionWorkerOptions){
    if(!options||!(options.queue instanceof SqliteOfflineQueue)||!Number.isSafeInteger(options.minAgeMs)||options.minAgeMs<0||options.minAgeMs>Number.MAX_SAFE_INTEGER||!Number.isSafeInteger(options.maxPerPass)||options.maxPerPass<1||options.maxPerPass>100||!Number.isSafeInteger(options.pollMs)||options.pollMs<100||options.pollMs>3600000||typeof options.authorize!=='function'||typeof options.onError!=='function'||(options.now!==undefined&&typeof options.now!=='function'))throw Error('Invalid offline retention worker');
    checkKey(options.scope,'principal',options.queuePrincipalId);checkKey(options.scope,'operation',options.operationId);checkKey(options.scope,'operator',options.operatorId);checkKey(options.scope,'reference',options.reference);
    this.runPolicy=createBoundedOperation(options.policyTimeoutMs,options.maxPendingPolicies,'Invalid offline retention worker','Offline retention policy unavailable');
    this.queue=options.queue;this.scope={tenantId:options.scope.tenantId,applicationId:options.scope.applicationId};this.queuePrincipalId=options.queuePrincipalId;this.operationId=options.operationId;this.actor={tenantId:this.scope.tenantId,principalId:options.operatorId};this.reference=options.reference;this.minAgeMs=options.minAgeMs;this.maxPerPass=options.maxPerPass;this.pollMs=options.pollMs;this.authorize=options.authorize;this.onError=options.onError;this.now=options.now??Date.now;
  }
  private report(error:unknown):void{try{void Promise.resolve(this.onError(error)).catch(()=>{});}catch{}}
  private async pass(signal:AbortSignal,generation:number):Promise<number>{
    const alive=()=>!signal.aborted&&generation===this.generation;if(!alive())return 0;const now=this.now();if(!Number.isSafeInteger(now)||now<0)throw Error('Invalid offline retention time');if(!alive())return 0;
    const cutoff=Math.max(0,now-this.minAgeMs),page=this.queue.listArchiveRecords(this.scope,this.queuePrincipalId,this.operationId,'candidates',{after:this.cursor,limit:this.maxPerPass,completedBefore:cutoff});let retired=0;
    for(const item of page.items){
      if(!alive())break;
      try{
        const operation=this.queue.get(this.scope,this.queuePrincipalId,item.id);if(!operation||operation.operationId!==this.operationId||(operation.status!=='succeeded'&&operation.status!=='discarded')||operation.completedAt===undefined||operation.completedAt>=cutoff)continue;
        const archived=await this.runPolicy(async policySignal=>{
          const combined=AbortSignal.any([signal,policySignal]),permitted=async()=>alive()&&!combined.aborted&&(await this.authorize({...this.actor},{...this.scope},structuredClone(operation),combined))===true&&alive()&&!combined.aborted;
          if(!await permitted()||!await permitted()||!alive()||combined.aborted)return false;
          this.queue.archiveTerminal(this.scope,this.queuePrincipalId,item.id,{operatorId:this.actor.principalId,reference:this.reference},now,operation);return true;
        });if(archived)retired++;
      }catch(error){if(alive())this.report(error);}
    }
    if(alive())this.cursor=page.nextAfter;return retired;
  }
  private launch():Promise<number>{const controller=new AbortController(),generation=this.generation;this.controller=controller;const pending=Promise.resolve().then(()=>this.pass(controller.signal,generation));this.pending=pending;void pending.finally(()=>{if(this.pending===pending){this.pending=undefined;this.controller=undefined;}}).catch(()=>{});return pending;}
  runOnce():Promise<number>{if(this.active||this.pending)throw Error('Offline retention worker already running');return this.launch();}
  start():void{if(this.active||this.pending)throw Error('Offline retention worker already running');this.active=true;const generation=this.generation,loop=()=>{if(!this.active||generation!==this.generation)return;const pending=this.launch();void pending.catch(error=>this.report(error)).finally(()=>{if(this.active&&generation===this.generation)this.timer=setTimeout(loop,this.pollMs);});};loop();}
  async stop():Promise<void>{this.active=false;this.generation++;if(this.timer!==undefined)clearTimeout(this.timer);this.timer=undefined;this.controller?.abort();const pending=this.pending;if(pending)try{await pending;}catch{}}
}
