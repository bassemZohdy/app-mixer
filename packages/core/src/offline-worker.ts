import {CapabilityRegistry, type InvocationContext} from './capabilities.js';
import {checkKey,type DataScope} from './data-provider.js';
import {SqliteOfflineQueue,type OfflineFailure} from './offline-queue.js';

type WorkerContext={tenantId:string;principalId:string};
export type OfflineWorkerOptions={
  scope:DataScope;
  principalId:string;
  intervalMs:number;
  maxPerPass:number;
  isOnline:()=>boolean|Promise<boolean>;
  resolveActor:()=>WorkerContext|undefined|Promise<WorkerContext|undefined>;
  classify:(error:unknown)=>OfflineFailure;
  onError:(error:unknown)=>void|Promise<void>;
};

/** Explicitly started polling worker; the host supplies connectivity and current identity. */
export class OfflineSyncWorker {
  private active=false;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private inFlight:Promise<void>|undefined;
  private readonly scope:DataScope;
  private readonly principalId:string;
  private readonly intervalMs:number;
  private readonly maxPerPass:number;
  private readonly isOnline:OfflineWorkerOptions['isOnline'];
  private readonly resolveActor:OfflineWorkerOptions['resolveActor'];
  private readonly classify:OfflineWorkerOptions['classify'];
  private readonly onError:OfflineWorkerOptions['onError'];
  constructor(private readonly queue:SqliteOfflineQueue,private readonly registry:CapabilityRegistry,options:OfflineWorkerOptions){
    if(!(queue instanceof SqliteOfflineQueue)||!(registry instanceof CapabilityRegistry)||!options||!Number.isSafeInteger(options.intervalMs)||options.intervalMs<100||options.intervalMs>3600000||!Number.isSafeInteger(options.maxPerPass)||options.maxPerPass<1||options.maxPerPass>100||typeof options.isOnline!=='function'||typeof options.resolveActor!=='function'||typeof options.classify!=='function'||typeof options.onError!=='function')throw Error('Invalid offline worker policy');
    checkKey(options.scope,'principal',options.principalId);
    this.scope={tenantId:options.scope.tenantId,applicationId:options.scope.applicationId};this.principalId=options.principalId;
    this.intervalMs=options.intervalMs;this.maxPerPass=options.maxPerPass;this.isOnline=options.isOnline;this.resolveActor=options.resolveActor;this.classify=options.classify;this.onError=options.onError;
  }
  start():void {
    if(this.active)return;
    if(this.inFlight)throw Error('Offline worker is stopping');
    this.active=true;this.schedule(0);
  }
  async stop():Promise<void>{
    this.active=false;if(this.timer!==undefined){clearTimeout(this.timer);this.timer=undefined;}
    await this.inFlight;
  }
  private schedule(delay:number):void {
    if(!this.active)return;
    this.timer=setTimeout(()=>{
      this.timer=undefined;
      const pending=this.pass();this.inFlight=pending;
      void pending.finally(()=>{if(this.inFlight===pending)this.inFlight=undefined;this.schedule(this.intervalMs);});
    },delay);
  }
  private async pass():Promise<void> {
    try{
      for(let i=0;i<this.maxPerPass&&this.active;i++){
        const online=await this.isOnline();if(!this.active||online!==true)return;
        const actor=await this.resolveActor();if(!this.active||!actor||actor.tenantId!==this.scope.tenantId||actor.principalId!==this.principalId)return;
        const context:InvocationContext={tenantId:actor.tenantId,principalId:actor.principalId,origin:'service'};
        const result=await this.queue.processOne(this.scope,context,this.registry,this.classify);
        if(!result)return;
      }
    }catch(error){try{await this.onError(error);}catch{ /* Error reporting cannot restart or crash the worker. */ }}
  }
}
