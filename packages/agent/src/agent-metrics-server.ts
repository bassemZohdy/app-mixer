import {createServer,type IncomingMessage,type Server,type ServerResponse} from 'node:http';
import type {AgentRunMetricsActor} from './agent-run-metrics.js';

export type AgentMetricsServerOptions={metrics:{render:(actor:AgentRunMetricsActor)=>string|Promise<string>};authenticate:(request:IncomingMessage,signal:AbortSignal)=>AgentRunMetricsActor|undefined|Promise<AgentRunMetricsActor|undefined>;timeoutMs:number;maxPending:number};
function reply(res:ServerResponse,status:number,body:string,type='text/plain; charset=utf-8'):void{if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(body);}

/** Host-authenticated, separately bound scrape endpoint for one scoped aggregate. */
export function createAgentMetricsServer(options:AgentMetricsServerOptions):Server{
 if(!options||!options.metrics||typeof options.metrics.render!=='function'||typeof options.authenticate!=='function'||!Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<100||options.timeoutMs>30000||!Number.isSafeInteger(options.maxPending)||options.maxPending<1||options.maxPending>1000)throw Error('Invalid agent metrics server configuration');
 const {metrics,authenticate,timeoutMs,maxPending}=options;let pending=0;
 return createServer((req,res)=>{
  if(req.method!=='GET'||req.url!=='/metrics'){reply(res,404,'Not found\n');return;}
  if(pending>=maxPending){reply(res,503,'Unavailable\n');return;}
  pending++;const controller=new AbortController();let finished=false;
  const timer=setTimeout(()=>{if(finished)return;finished=true;controller.abort();reply(res,503,'Unavailable\n');},timeoutMs);
  res.once('close',()=>{if(!finished){finished=true;clearTimeout(timer);controller.abort();}});
  void Promise.resolve().then(async()=>{
   let actor:AgentRunMetricsActor|undefined;try{actor=await authenticate(req,controller.signal);}catch{return {status:401,body:'Unauthorized\n'};}
   if(controller.signal.aborted)return {status:503,body:'Unavailable\n'};
   if(!actor)return {status:401,body:'Unauthorized\n'};
   try{const text=await metrics.render(actor);if(typeof text!=='string'||Buffer.byteLength(text)>65536)throw Error('Invalid metrics');return {status:200,body:text};}catch(error){const message=error instanceof Error?error.message:'';return message==='Agent metrics access denied'||message==='Invalid agent metrics actor'?{status:403,body:'Forbidden\n'}:{status:503,body:'Unavailable\n'};}
  }).then(result=>{if(finished)return;finished=true;clearTimeout(timer);reply(res,result.status,result.body,result.status===200?'text/plain; version=0.0.4; charset=utf-8':undefined);},()=>{if(!finished){finished=true;clearTimeout(timer);reply(res,503,'Unavailable\n');}}).finally(()=>{pending--;}).catch(()=>{});
 });
}
