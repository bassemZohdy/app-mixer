import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { CapabilityRegistry } from './capabilities.js';
import {traceHttp,type HttpServerTracingOptions} from './http-tracing.js';

type Actor = {tenantId:string; principalId:string};
type Authenticate = (request:IncomingMessage) => Actor | undefined | Promise<Actor | undefined>;
type AuditFailure = (event:{reason:'unauthenticated';remoteAddress?:string}) => void | Promise<void>;
export type CapabilityServerTracingOptions=HttpServerTracingOptions;
function reply(res:ServerResponse,status:number,value:unknown):void {
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
  res.end(JSON.stringify(value));
}
async function body(req:IncomingMessage):Promise<unknown> {
  if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??'')) throw Error('CONTENT_TYPE');
  const parts:Buffer[]=[];let size=0;
  for await(const chunk of req) {const part=Buffer.from(chunk);size+=part.length;if(size>1024*1024)throw Error('TOO_LARGE');parts.push(part);}
  try{return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown;}catch{throw Error('INVALID_JSON');}
}
/** Host-authenticated local endpoint; the authentication callback is trusted server code. */
export function createCapabilityServer(registry:CapabilityRegistry, authenticate:Authenticate, auditFailure:AuditFailure, tracing?:CapabilityServerTracingOptions):Server {
  if(typeof authenticate!=='function'||typeof auditFailure!=='function') throw Error('Authentication and failure audit are required');
  if(tracing!==undefined&&(!tracing||!tracing.tracer||typeof tracing.tracer.startSpan!=='function'||(tracing.trustRemoteParent!==undefined&&typeof tracing.trustRemoteParent!=='boolean')))throw Error('Invalid capability tracing configuration');
  const dispatch=tracing?traceHttp({tracer:tracing.tracer,trustRemoteParent:tracing.trustRemoteParent},req=>({method:req.method==='POST'?'POST':'_OTHER',...(req.method==='POST'&&/^\/capabilities\/[^/]+\/invoke$/.test(req.url??'')?{path:'/capabilities/{operationId}/invoke'}:{})})):undefined;
  return createServer((req,res)=>{
    const run=()=>{void (async()=>{
      let actor:Actor|undefined;
      try{actor=await authenticate(req);}catch{actor=undefined;}
      if(!actor){
        try{await auditFailure({reason:'unauthenticated',remoteAddress:req.socket.remoteAddress});}catch{reply(res,503,{error:'Audit unavailable'});return;}
        reply(res,401,{error:'Unauthorized'});return;
      }
      const match=/^\/capabilities\/([^/]+)\/invoke$/.exec(req.url??'');
      if(req.method!=='POST'||!match){reply(res,404,{error:'Not found'});return;}
      let operationId:string;
      try{operationId=decodeURIComponent(match[1]);}catch{reply(res,400,{error:'Invalid capability ID'});return;}
      let input:unknown;
      try{input=await body(req);}catch(error){const code=error instanceof Error?error.message:'';reply(res,code==='CONTENT_TYPE'?415:code==='TOO_LARGE'?413:400,{error:'Invalid request'});return;}
      if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['origin','input'].includes(key))||!Object.hasOwn(input,'input')){reply(res,400,{error:'Invalid request'});return;}
      const value=input as Record<string,unknown>;
      if(value.origin!=='ui'&&value.origin!=='agent'){reply(res,400,{error:'Invalid request'});return;}
      try{
        const result=await registry.invoke(operationId,value.input,{tenantId:actor.tenantId,principalId:actor.principalId,origin:value.origin});
        reply(res,200,{result});
      }catch(error){
        const message=error instanceof Error?error.message:'';
        const status=message==='Data schema guard unavailable'?503:message==='Capability not found'?404:message==='Capability forbidden'?403:message==='Invalid capability input'?400:['Data revision conflict','Data schema version conflict','Staging request conflict','Operation not staged'].includes(message)?409:500;
        reply(res,status,{error:status===500?'Capability invocation failed':message});
      }
    })().catch(()=>{if(!res.headersSent&&!res.destroyed)reply(res,500,{error:'Internal server error'});else if(!res.destroyed)res.destroy();});};
    if(dispatch)dispatch(req,res,run);else run();
  });
}
