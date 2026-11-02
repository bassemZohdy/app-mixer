import {EncryptedBrowserQueue,type BrowserQueueItem,type BrowserQueueScope} from './offline.js';
export type BrowserOfflineFailure='retry'|'conflict'|'uncertain';
export type BrowserOfflineWorkerOptions={
  intervalMs:number;
  maxPerPass:number;
  maxAttempts:number;
  isOnline:()=>boolean|Promise<boolean>;
  resolveActor:()=>BrowserQueueScope|undefined|Promise<BrowserQueueScope|undefined>;
  dispatch:(operationId:string,input:{idempotencyKey:string;payload:Record<string,unknown>},actor:BrowserQueueScope)=>unknown|Promise<unknown>;
  classify:(error:unknown)=>BrowserOfflineFailure;
  onError:(error:unknown)=>void|Promise<void>;
};

/** Explicitly started browser worker; the host authenticates every remote invocation. */
export class BrowserOfflineWorker {
  private active=false;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private inFlight:Promise<void>|undefined;
  private readonly scope:BrowserQueueScope;
  private readonly options:BrowserOfflineWorkerOptions;
  constructor(private readonly queue:EncryptedBrowserQueue,options:BrowserOfflineWorkerOptions){
    if(!(queue instanceof EncryptedBrowserQueue)||!options||!Number.isSafeInteger(options.intervalMs)||options.intervalMs<100||options.intervalMs>3600000||!Number.isSafeInteger(options.maxPerPass)||options.maxPerPass<1||options.maxPerPass>100||!Number.isSafeInteger(options.maxAttempts)||options.maxAttempts<1||options.maxAttempts>20||typeof options.isOnline!=='function'||typeof options.resolveActor!=='function'||typeof options.dispatch!=='function'||typeof options.classify!=='function'||typeof options.onError!=='function')throw Error('Invalid browser offline worker policy');
    this.scope=queue.getScope();this.options={...options};
  }
  start():void {if(this.active)return;if(this.inFlight)throw Error('Browser offline worker is stopping');this.active=true;this.schedule(0);}
  async stop():Promise<void>{this.active=false;if(this.timer!==undefined){clearTimeout(this.timer);this.timer=undefined;}await this.inFlight;}
  private schedule(delay:number):void{
    if(!this.active)return;
    this.timer=setTimeout(()=>{this.timer=undefined;const pending=this.pass();this.inFlight=pending;void pending.finally(()=>{if(this.inFlight===pending)this.inFlight=undefined;this.schedule(this.options.intervalMs);});},delay);
  }
  private async authorized():Promise<boolean>{
    if(!this.active||await this.options.isOnline()!==true||!this.active)return false;
    const actor=await this.options.resolveActor();return !!this.active&&!!actor&&actor.tenantId===this.scope.tenantId&&actor.applicationId===this.scope.applicationId&&actor.principalId===this.scope.principalId;
  }
  private async pass():Promise<void>{
    try{
      if(!await this.authorized())return;
      const items=await this.queue.list();let processed=0;
      for(const item of items){
        if(!this.active||processed>=this.options.maxPerPass)return;
        if(item.status!=='pending')continue;
        if(!await this.authorized())return;
        if(item.attempts>=this.options.maxAttempts){try{await this.queue.transition(item.id,item.version,'exhaustPending');}catch(error){if(!(error instanceof Error&&error.message==='Offline version conflict'))throw error;}continue;}
        let claimed:BrowserQueueItem;
        try{claimed=await this.queue.transition(item.id,item.version,'claim');}catch(error){if(error instanceof Error&&error.message==='Offline version conflict')continue;throw error;}
        processed++;
        let permitted:boolean;
        try{permitted=await this.authorized();}catch(error){await this.queue.transition(claimed.id,claimed.version,'release');throw error;}
        if(!permitted){await this.queue.transition(claimed.id,claimed.version,'release');return;}
        let outcome:'succeed'|'conflict'|'uncertain'|'exhaust'|'requeue'='succeed';
        try{await this.options.dispatch(claimed.operationId,{idempotencyKey:claimed.idempotencyKey,payload:structuredClone(claimed.payload)},{...this.scope});}
        catch(error){
          let classification:BrowserOfflineFailure='uncertain';if(!(error&&typeof error==='object'&&'code' in error&&error.code==='CAPABILITY_OUTCOME_UNCERTAIN'))try{const value=this.options.classify(error);if(value==='retry'||value==='conflict')classification=value;}catch{}
          outcome=classification==='retry'?(claimed.attempts>=this.options.maxAttempts?'exhaust':'requeue'):classification;
        }
        await this.queue.transition(claimed.id,claimed.version,outcome);
      }
    }catch(error){try{await this.options.onError(error);}catch{/* The host's reporting callback cannot crash the scheduler. */}}
  }
}
