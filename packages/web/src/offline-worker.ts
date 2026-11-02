import {EncryptedBrowserQueue,type BrowserQueueItem,type BrowserQueueScope} from './offline.js';
export type BrowserOfflineFailure='retry'|'conflict'|'uncertain';
export type BrowserOfflineWorkerOptions={
  intervalMs:number;
  maxPerPass:number;
  maxAttempts:number;
  isOnline:(signal:AbortSignal)=>boolean|Promise<boolean>;
  resolveActor:(signal:AbortSignal)=>BrowserQueueScope|undefined|Promise<BrowserQueueScope|undefined>;
  policyTimeoutMs?:number;
  maxPendingPolicies?:number;
  dispatch:(operationId:string,input:{idempotencyKey:string;payload:Record<string,unknown>},actor:BrowserQueueScope)=>unknown|Promise<unknown>;
  classify:(error:unknown)=>BrowserOfflineFailure;
  onError:(error:unknown)=>void|Promise<void>;
};

/** Explicitly started browser worker; the host authenticates every remote invocation. */
export class BrowserOfflineWorker {
  private active=false;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private inFlight:Promise<void>|undefined;
  private cursor:string|undefined;
  private pendingPolicies=0;
  private readonly policyControllers=new Set<AbortController>();
  private readonly scope:BrowserQueueScope;
  private readonly options:BrowserOfflineWorkerOptions;
  constructor(private readonly queue:EncryptedBrowserQueue,options:BrowserOfflineWorkerOptions){
    if(!(queue instanceof EncryptedBrowserQueue)||!options||!Number.isSafeInteger(options.intervalMs)||options.intervalMs<100||options.intervalMs>3600000||!Number.isSafeInteger(options.maxPerPass)||options.maxPerPass<1||options.maxPerPass>100||!Number.isSafeInteger(options.maxAttempts)||options.maxAttempts<1||options.maxAttempts>20||typeof options.isOnline!=='function'||typeof options.resolveActor!=='function'||typeof options.dispatch!=='function'||typeof options.classify!=='function'||typeof options.onError!=='function'||(options.policyTimeoutMs===undefined)!==(options.maxPendingPolicies===undefined)||(options.policyTimeoutMs!==undefined&&(!Number.isSafeInteger(options.policyTimeoutMs)||options.policyTimeoutMs<100||options.policyTimeoutMs>30000))||(options.maxPendingPolicies!==undefined&&(!Number.isSafeInteger(options.maxPendingPolicies)||options.maxPendingPolicies<1||options.maxPendingPolicies>100)))throw Error('Invalid browser offline worker policy');
    this.scope=queue.getScope();this.options={...options};
  }
  start():void {if(this.active)return;if(this.inFlight)throw Error('Browser offline worker is stopping');this.active=true;this.schedule(0);}
  async stop():Promise<void>{this.active=false;if(this.timer!==undefined){clearTimeout(this.timer);this.timer=undefined;}for(const controller of this.policyControllers)controller.abort();await this.inFlight;}
  private schedule(delay:number):void{
    if(!this.active)return;
    this.timer=setTimeout(()=>{this.timer=undefined;const pending=this.pass();this.inFlight=pending;void pending.finally(()=>{if(this.inFlight===pending)this.inFlight=undefined;this.schedule(this.options.intervalMs);});},delay);
  }
  private async policy<T>(callback:(signal:AbortSignal)=>T|Promise<T>):Promise<T>{
    if(!this.active)throw Error('Browser offline worker stopped');
    const timeout=this.options.policyTimeoutMs,limit=this.options.maxPendingPolicies,controller=new AbortController();
    if(timeout!==undefined&&this.pendingPolicies>=limit!)throw Error('Browser offline policy unavailable');
    this.policyControllers.add(controller);
    if(timeout===undefined){try{return await callback(controller.signal);}finally{this.policyControllers.delete(controller);}}
    this.pendingPolicies++;
    const task=Promise.resolve().then(()=>{if(controller.signal.aborted)throw Error('Browser offline worker stopped');return callback(controller.signal);});
    void task.then(()=>{this.pendingPolicies--;this.policyControllers.delete(controller);},()=>{this.pendingPolicies--;this.policyControllers.delete(controller);});
    let timer:ReturnType<typeof setTimeout>|undefined,abort:()=>void=()=>{};
    try{return await Promise.race([task,new Promise<never>((_resolve,reject)=>{abort=()=>reject(Error(this.active?'Browser offline policy unavailable':'Browser offline worker stopped'));controller.signal.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>controller.abort(),timeout);})]);}
    finally{if(timer!==undefined)clearTimeout(timer);controller.signal.removeEventListener('abort',abort);}
  }
  private async authorized():Promise<boolean>{
    if(!this.active||await this.policy(signal=>this.options.isOnline(signal))!==true||!this.active)return false;
    const actor=await this.policy(signal=>this.options.resolveActor(signal));return !!this.active&&!!actor&&actor.tenantId===this.scope.tenantId&&actor.applicationId===this.scope.applicationId&&actor.principalId===this.scope.principalId;
  }
  private async pass():Promise<void>{
    try{
      if(!await this.authorized())return;
      const items=(await this.queue.list()).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);let processed=0;
      const next=this.cursor===undefined?0:items.findIndex(item=>item.id>this.cursor!);const start=next<0?0:next;
      for(const item of [...items.slice(start),...items.slice(0,start)]){
        if(!this.active||processed>=this.options.maxPerPass)return;
        if(item.status!=='pending')continue;
        processed++;this.cursor=item.id;
        if(!await this.authorized())return;
        if(item.attempts>=this.options.maxAttempts){try{await this.queue.transition(item.id,item.version,'exhaustPending');}catch(error){if(!(error instanceof Error&&error.message==='Offline version conflict'))throw error;}continue;}
        let claimed:BrowserQueueItem;
        try{claimed=await this.queue.transition(item.id,item.version,'claim');}catch(error){if(error instanceof Error&&error.message==='Offline version conflict')continue;throw error;}
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
    }catch(error){if(!this.active&&error instanceof Error&&error.message==='Browser offline worker stopped')return;try{await this.options.onError(error);}catch{/* The host's reporting callback cannot crash the scheduler. */}}
  }
}
