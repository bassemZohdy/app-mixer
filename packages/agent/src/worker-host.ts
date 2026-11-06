/** Any background worker with the start/stop contract used by the schedule, recovery and notice workers. */
export type AgentHostedWorker={start():void;stop():Promise<void>};
export type AgentWorkerHostState='idle'|'running'|'stopping'|'stopped';
export type AgentWorkerHostStopResult={stopped:string[];timedOut:string[];failed:string[]};
type Options={workers:Record<string,AgentHostedWorker>;stopTimeoutMs:number;onError?:(name:string,error:unknown)=>void};
type SignalSource={once(signal:string,listener:()=>void):unknown;removeListener(signal:string,listener:()=>void):unknown};

const NAME=/^[a-z][a-z0-9-]{0,62}$/;

/** Runs a fixed set of workers in one process and drains them together on shutdown. The host decides when to exit. */
export class AgentWorkerHost {
 private readonly workers:[string,AgentHostedWorker][];private readonly stopTimeoutMs:number;private readonly onError:((name:string,error:unknown)=>void)|undefined;
 private current:AgentWorkerHostState='idle';private started:[string,AgentHostedWorker][]=[];private stopping?:Promise<AgentWorkerHostStopResult>|undefined;
 constructor(options:Options){
  if(!options||typeof options!=='object'||!options.workers||typeof options.workers!=='object'||Array.isArray(options.workers)||!Number.isSafeInteger(options.stopTimeoutMs)||options.stopTimeoutMs<100||options.stopTimeoutMs>600000||(options.onError!==undefined&&typeof options.onError!=='function'))throw Error('Invalid worker host');
  const entries=Object.entries(options.workers);
  if(entries.length<1||entries.length>20||entries.some(([name,worker])=>!NAME.test(name)||!worker||typeof worker.start!=='function'||typeof worker.stop!=='function')||new Set(entries.map(([,worker])=>worker)).size!==entries.length)throw Error('Invalid worker host');
  this.workers=entries;this.stopTimeoutMs=options.stopTimeoutMs;this.onError=options.onError;
 }
 state():AgentWorkerHostState{return this.current;}
 /** True only while every worker is running; use it for a readiness probe. */
 ready():boolean{return this.current==='running';}
 /** Start every worker in order. If one fails to start, those already started are stopped and the error is rethrown. */
 async start():Promise<void>{
  if(this.current!=='idle')throw Error('Worker host already started');this.current='running';
  for(const entry of this.workers){
   try{entry[1].start();this.started.push(entry);}
   catch(error){await this.stop();throw error;}
  }
 }
 /** Stop all started workers in parallel. Each stop is bounded by `stopTimeoutMs`; repeated calls return the same result. */
 stop():Promise<AgentWorkerHostStopResult>{
  if(this.stopping)return this.stopping;
  if(this.current==='idle'){this.current='stopped';this.stopping=Promise.resolve({stopped:[],timedOut:[],failed:[]});return this.stopping;}
  this.current='stopping';
  const report=(name:string,error:unknown)=>{try{this.onError?.(name,error);}catch{}};
  const one=async([name,worker]:[string,AgentHostedWorker]):Promise<'stopped'|'timedOut'|'failed'>=>{
   let timer:ReturnType<typeof setTimeout>|undefined;
   const timeout=new Promise<'timedOut'>(resolve=>{timer=setTimeout(()=>resolve('timedOut'),this.stopTimeoutMs);});
   try{const outcome=await Promise.race([Promise.resolve().then(()=>worker.stop()).then(()=>'stopped' as const),timeout]);if(outcome==='timedOut')report(name,Error('Worker stop timed out'));return outcome;}
   catch(error){report(name,error);return 'failed';}
   finally{clearTimeout(timer);}
  };
  this.stopping=Promise.all(this.started.map(one)).then(outcomes=>{
   const result:AgentWorkerHostStopResult={stopped:[],timedOut:[],failed:[]};outcomes.forEach((outcome,index)=>result[outcome].push(this.started[index][0]));this.current='stopped';return result;
  });
  return this.stopping;
 }
 /** Stop on the first of `signals` (default SIGTERM and SIGINT) and pass the result to `onStopped`. Returns a function that removes the handlers. */
 handleSignals(source:SignalSource,onStopped:(result:AgentWorkerHostStopResult)=>void,signals:string[]=['SIGTERM','SIGINT']):()=>void{
  if(!source||typeof source.once!=='function'||typeof source.removeListener!=='function'||typeof onStopped!=='function'||!Array.isArray(signals)||signals.length<1||signals.some(signal=>typeof signal!=='string'||!/^SIG[A-Z0-9]+$/.test(signal)))throw Error('Invalid worker host signals');
  const listener=()=>{remove();void this.stop().then(result=>{try{onStopped(result);}catch{}});};
  const remove=()=>{for(const signal of signals)source.removeListener(signal,listener);};
  for(const signal of signals)source.once(signal,listener);return remove;
 }
}
export type {Options as AgentWorkerHostOptions};
