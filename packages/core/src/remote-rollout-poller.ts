import {SqliteRemoteRollout} from './remote-rollout.js';
import {PostgresRemoteRollout} from './postgres-remote-rollout.js';

type RolloutResult=Awaited<ReturnType<SqliteRemoteRollout['runOnce']>>;
type Options={rollout:SqliteRemoteRollout|PostgresRemoteRollout;intervalMs:number;maxBackoffMs:number;onResult:(result:RolloutResult)=>void;onError:(error:unknown,needsReview:boolean)=>void;
 /** Shorten each wait by a random fraction up to this ratio (0 to 0.5) so many pollers do not hit the source together. Default 0. */
 jitterRatio?:number;
 /** Random source returning [0,1); for tests. */
 random?:()=>number};

/** Explicitly started local polling; never recovers a durable rollout gate automatically. */
export class RemoteRolloutPoller {
 private readonly rollout:SqliteRemoteRollout|PostgresRemoteRollout;private readonly intervalMs:number;private readonly maxBackoffMs:number;private readonly onResult:Options['onResult'];private readonly onError:Options['onError'];
 private active=false;private pending?:Promise<void>;private timer?:ReturnType<typeof setTimeout>;private failures=0;private readonly jitterRatio:number;private readonly random:()=>number;
 constructor(options:Options){
  if(!options||!(options.rollout instanceof SqliteRemoteRollout||options.rollout instanceof PostgresRemoteRollout)||!Number.isSafeInteger(options.intervalMs)||options.intervalMs<100||options.intervalMs>3600000||!Number.isSafeInteger(options.maxBackoffMs)||options.maxBackoffMs<options.intervalMs||options.maxBackoffMs>3600000||typeof options.onResult!=='function'||typeof options.onError!=='function'||(options.jitterRatio!==undefined&&(typeof options.jitterRatio!=='number'||!Number.isFinite(options.jitterRatio)||options.jitterRatio<0||options.jitterRatio>0.5))||(options.random!==undefined&&typeof options.random!=='function'))throw Error('Invalid rollout poller');
  this.rollout=options.rollout;this.intervalMs=options.intervalMs;this.maxBackoffMs=options.maxBackoffMs;this.onResult=options.onResult;this.onError=options.onError;this.jitterRatio=options.jitterRatio??0;this.random=options.random??Math.random;
 }
 isRunning():boolean{return this.active;}
 start():void{
  if(this.active||this.pending)throw Error('Rollout poller already running');this.active=true;this.failures=0;this.loop();
 }
 private loop():void{
  if(!this.active)return;
  const pending=(async()=>{
   try{const result=await this.rollout.runOnce();this.failures=0;try{void Promise.resolve(this.onResult(result)).catch(()=>{});}catch{}}
   catch(error){let needsReview=true;try{needsReview=(await this.rollout.getState()).phase!=='idle';}catch{}if(needsReview)this.active=false;else this.failures++;try{void Promise.resolve(this.onError(error,needsReview)).catch(()=>{});}catch{}}
  })();this.pending=pending;
  void pending.finally(()=>{if(this.pending===pending)this.pending=undefined;if(this.active){const base=Math.min(this.maxBackoffMs,this.intervalMs*2**Math.min(this.failures,20)),draw=this.random(),delay=this.jitterRatio>0&&Number.isFinite(draw)&&draw>=0&&draw<1?Math.max(1,Math.floor(base*(1-this.jitterRatio*draw))):base;this.timer=setTimeout(()=>{this.timer=undefined;this.loop();},delay);}});
 }
 async stop():Promise<void>{this.active=false;if(this.timer)clearTimeout(this.timer);this.timer=undefined;const pending=this.pending;if(pending)await pending;}
}
export type {Options as RemoteRolloutPollerOptions,RolloutResult as RemoteRolloutResult};
