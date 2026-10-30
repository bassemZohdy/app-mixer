import {createServer,type IncomingMessage,type Server,type ServerResponse} from 'node:http';
import type {DataPlaneRequestMetrics} from './data-plane-metrics.js';

export type MetricsServerOptions={metrics:DataPlaneRequestMetrics;authorize:(request:IncomingMessage,signal:AbortSignal)=>boolean|Promise<boolean>;timeoutMs:number;maxPending:number};
function respond(res:ServerResponse,status:number,body:string,type='text/plain; charset=utf-8'):void{
 if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(body);
}
/** Host-authorized scrape boundary. The host must secure transport and the listener. */
export function createMetricsServer(options:MetricsServerOptions):Server{
 if(!options||!options.metrics||typeof options.metrics.render!=='function'||typeof options.authorize!=='function'||!Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<100||options.timeoutMs>30000||!Number.isSafeInteger(options.maxPending)||options.maxPending<1||options.maxPending>1000)throw Error('Invalid metrics server configuration');
 const {metrics,authorize,timeoutMs,maxPending}=options;let pending=0;
 return createServer((req,res)=>{
  if(req.method!=='GET'||req.url!=='/metrics'){respond(res,404,'Not found\n');return;}
  if(pending>=maxPending){respond(res,503,'Unavailable\n');return;}
  pending++;const controller=new AbortController();let finished=false;
  const timer=setTimeout(()=>{if(finished)return;finished=true;controller.abort();respond(res,503,'Unavailable\n');},timeoutMs);
  res.once('close',()=>{if(!finished){finished=true;clearTimeout(timer);controller.abort();}});
  void Promise.resolve().then(()=>authorize(req,controller.signal)).then(allowed=>{
   if(finished)return;finished=true;clearTimeout(timer);if(allowed!==true){respond(res,401,'Unauthorized\n');return;}
   try{respond(res,200,metrics.render(),'text/plain; version=0.0.4; charset=utf-8');}catch{respond(res,503,'Unavailable\n');}
  },()=>{if(!finished){finished=true;clearTimeout(timer);respond(res,401,'Unauthorized\n');}}).finally(()=>{pending--;}).catch(()=>{});
 });
}
