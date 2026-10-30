import {SqliteAgentNoticeDelivery,type AgentNoticeDeliveryActor,type AgentNoticeMessage} from './agent-notice-delivery.js';

type Options={outbox:SqliteAgentNoticeDelivery;actor:AgentNoticeDeliveryActor;send:(message:AgentNoticeMessage,destinationId:string,idempotencyKey:string)=>Promise<void>;maxPerPass:number;pollMs:number;onError:(error:unknown,deliveryId?:number)=>void};
const id=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(x);

/** Explicit host-operated delivery of already queued notices. */
export class AgentNoticeDeliveryWorker {
 private readonly outbox:SqliteAgentNoticeDelivery;private readonly actor:AgentNoticeDeliveryActor;private readonly send:Options['send'];private readonly maxPerPass:number;private readonly pollMs:number;private readonly onError:Options['onError'];private cursor?:number;private active=false;private pending?:Promise<number>;private timer?:ReturnType<typeof setTimeout>;
 constructor(options:Options){
  if(!options||!(options.outbox instanceof SqliteAgentNoticeDelivery)||!options.actor||!id(options.actor.tenantId)||!id(options.actor.principalId)||typeof options.send!=='function'||!Number.isSafeInteger(options.maxPerPass)||options.maxPerPass<1||options.maxPerPass>100||!Number.isSafeInteger(options.pollMs)||options.pollMs<100||options.pollMs>3600000||typeof options.onError!=='function')throw Error('Invalid notice delivery worker');
  this.outbox=options.outbox;this.actor={tenantId:options.actor.tenantId,principalId:options.actor.principalId};this.send=options.send;this.maxPerPass=options.maxPerPass;this.pollMs=options.pollMs;this.onError=options.onError;
 }
 private report(error:unknown,id?:number):void{try{this.onError(error,id);}catch{}}
 private async pass(keepGoing:()=>boolean):Promise<number>{
  const page=await this.outbox.list({...this.actor},{...(this.cursor===undefined?{}:{after:this.cursor}),limit:this.maxPerPass});let delivered=0;
  for(const delivery of page.items){
   if(!keepGoing())return delivered;
   if(delivery.status!=='pending')continue;
   try{await this.outbox.dispatch({...this.actor},delivery.id,async(message,destination,key)=>{if(!keepGoing())throw Error('Notice delivery worker stopped');await this.send(message,destination,key);});delivered++;}catch(error){this.report(error,delivery.id);}
  }
  if(keepGoing())this.cursor=page.nextAfter;return delivered;
 }
 runOnce():Promise<number>{if(this.active||this.pending)throw Error('Notice delivery pass already running');const pending=this.pass(()=>true);this.pending=pending;void pending.finally(()=>{if(this.pending===pending)this.pending=undefined;}).catch(()=>{});return pending;}
 start():void{if(this.active||this.pending)throw Error('Notice delivery worker already running');this.active=true;const loop=()=>{if(!this.active)return;const pending=this.pass(()=>this.active);this.pending=pending;void pending.catch(error=>this.report(error)).finally(()=>{if(this.pending===pending)this.pending=undefined;if(this.active)this.timer=setTimeout(loop,this.pollMs);});};loop();}
 async stop():Promise<void>{this.active=false;if(this.timer)clearTimeout(this.timer);this.timer=undefined;const pending=this.pending;if(pending)try{await pending;}catch{}}
}
export type {Options as AgentNoticeDeliveryWorkerOptions};
