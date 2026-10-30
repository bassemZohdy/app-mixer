import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { CapabilityRegistry } from './capabilities.js';
import {traceHttp,type HttpServerTracingOptions} from './http-tracing.js';

type Actor = {tenantId:string; principalId:string};
type Authenticate = (request:IncomingMessage) => Actor | undefined | Promise<Actor | undefined>;
type AuditFailure = (event:{reason:'unauthenticated';remoteAddress?:string}) => void | Promise<void>;
export type CapabilityServerTracingOptions=HttpServerTracingOptions;
export type CapabilityHttpsOptions={cert:string|Buffer;key:string|Buffer;clientCa?:string|Buffer};
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
function createCapabilityHandler(registry:CapabilityRegistry, authenticate:Authenticate, auditFailure:AuditFailure, tracing?:CapabilityServerTracingOptions):RequestListener {
  if(typeof authenticate!=='function'||typeof auditFailure!=='function') throw Error('Authentication and failure audit are required');
  if(tracing!==undefined&&(!tracing||!tracing.tracer||typeof tracing.tracer.startSpan!=='function'||(tracing.trustRemoteParent!==undefined&&typeof tracing.trustRemoteParent!=='boolean')))throw Error('Invalid capability tracing configuration');
  const dispatch=tracing?traceHttp({tracer:tracing.tracer,trustRemoteParent:tracing.trustRemoteParent},req=>({method:req.method==='POST'?'POST':'_OTHER',...(req.method==='POST'&&/^\/capabilities\/[^/]+\/invoke$/.test(req.url??'')?{path:'/capabilities/{operationId}/invoke'}:{})})):undefined;
  return (req,res)=>{
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
        const status=message==='Data schema guard unavailable'?503:message==='Capability not found'?404:['Capability forbidden','Shared offline key forbidden'].includes(message)?403:message==='Invalid capability input'?400:['Data revision conflict','Data schema version conflict','Staging request conflict','Operation not staged','Shared offline request conflict','Shared offline slot conflict','Shared offline operation in progress','Shared offline outcome uncertain'].includes(message)?409:500;
        reply(res,status,{error:status===500?'Capability invocation failed':message});
      }
    })().catch(()=>{if(!res.headersSent&&!res.destroyed)reply(res,500,{error:'Internal server error'});else if(!res.destroyed)res.destroy();});};
    if(dispatch)dispatch(req,res,run);else run();
  };
}

/** Host-authenticated HTTP endpoint for local use or a trusted TLS-terminating proxy. */
export function createCapabilityServer(registry:CapabilityRegistry,authenticate:Authenticate,auditFailure:AuditFailure,tracing?:CapabilityServerTracingOptions):Server {
 return createServer(createCapabilityHandler(registry,authenticate,auditFailure,tracing));
}

/** Direct TLS transport; optional client CA requires a verified client certificate. */
export function createCapabilityHttpsServer(registry:CapabilityRegistry,authenticate:Authenticate,auditFailure:AuditFailure,tls:CapabilityHttpsOptions,tracing?:CapabilityServerTracingOptions):HttpsServer {
 const pem=(value:unknown):value is string|Buffer=>(typeof value==='string'&&value.trim().length>0)||(Buffer.isBuffer(value)&&value.length>0);
 if(!tls||typeof tls!=='object'||Array.isArray(tls)||Object.keys(tls).some(key=>!['cert','key','clientCa'].includes(key))||!pem(tls.cert)||!pem(tls.key)||(tls.clientCa!==undefined&&!pem(tls.clientCa)))throw Error('Invalid capability TLS configuration');
 const handler=createCapabilityHandler(registry,authenticate,auditFailure,tracing);
 return createHttpsServer({cert:tls.cert,key:tls.key,minVersion:'TLSv1.2',...(tls.clientCa!==undefined?{ca:tls.clientCa,requestCert:true,rejectUnauthorized:true}:{})},handler);
}
