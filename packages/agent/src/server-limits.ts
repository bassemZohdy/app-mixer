import type {IncomingMessage,Server,ServerResponse} from 'node:http';

/**
 * Conservative defaults for the HTTP servers this package creates. Node waits 60 s for headers and 300 s for a request by default, but only checks
 * for expired connections every 30 s, so a socket idle timeout (`idleTimeoutMs`, no bytes in either direction; 0 disables it) cuts stalled clients promptly.
 */
const DEFAULT_LIMITS={headersTimeoutMs:10000,requestTimeoutMs:30000,keepAliveTimeoutMs:5000,idleTimeoutMs:30000};
/** Apply request, header and keep-alive timeouts so a slow or stalled client cannot hold a connection open indefinitely. Returns the same server. */
export function limitServer<T extends Server>(server:T,limits:{headersTimeoutMs?:number;requestTimeoutMs?:number;keepAliveTimeoutMs?:number;idleTimeoutMs?:number}={}):T{
 const {headersTimeoutMs,requestTimeoutMs,keepAliveTimeoutMs,idleTimeoutMs}={...DEFAULT_LIMITS,...limits};
 if(![headersTimeoutMs,requestTimeoutMs,keepAliveTimeoutMs].every(value=>Number.isSafeInteger(value)&&value>=1)||!Number.isSafeInteger(idleTimeoutMs)||idleTimeoutMs<0||headersTimeoutMs>requestTimeoutMs)throw Error('Invalid server limits');
 server.headersTimeout=headersTimeoutMs;server.requestTimeout=requestTimeoutMs;server.keepAliveTimeout=keepAliveTimeoutMs;
 server.setTimeout(idleTimeoutMs);
 return server;
}

/** Wrap an async request handler so a rejection that escapes it ends the response instead of becoming an unhandled rejection that stops the process. */
export function guard(handler:(req:IncomingMessage,res:ServerResponse)=>Promise<void>):(req:IncomingMessage,res:ServerResponse)=>void{
 return (req,res)=>{void handler(req,res).catch(()=>{try{if(!res.headersSent)res.writeHead(500,{'content-type':'text/plain; charset=utf-8'});res.end();}catch{res.destroy();}});};
}
