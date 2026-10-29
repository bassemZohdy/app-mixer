import {createServer,type IncomingMessage,type Server,type ServerResponse} from 'node:http';
import {SqliteAgentTriggers} from './agent-triggers.js';
import {type AgentDefinitionVersion} from './persistent-definitions.js';

type SourceIdentity={tenantId:string;principalId:string;sourceId:string};
type EventRequest={agentId:string;eventId:string;eventType:string;payload:unknown};
type Options={
 triggers:SqliteAgentTriggers;
 definitions:{get:(tenantId:string,agentId:string)=>AgentDefinitionVersion|undefined};
 authenticate:(request:IncomingMessage)=>SourceIdentity|undefined|Promise<SourceIdentity|undefined>;
 authorize:(identity:SourceIdentity,event:EventRequest,definition:AgentDefinitionVersion)=>boolean|Promise<boolean>;
 maxPending:number;clock?:()=>number;
};
const id=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(x);
const reply=(res:ServerResponse,status:number,body:unknown)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(body));};
async function read(req:IncomingMessage):Promise<EventRequest>{
 if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??''))throw Error('CONTENT_TYPE');
 const parts:Buffer[]=[];let size=0;for await(const chunk of req){const part=Buffer.from(chunk);size+=part.length;if(size>256*1024)throw Error('TOO_LARGE');parts.push(part);}
 let value:unknown;try{value=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw Error('INVALID');}
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('INVALID');
 const obj=value as Record<string,unknown>,keys=Object.keys(obj);if(keys.length!==4||!['agentId','eventId','eventType','payload'].every(key=>Object.hasOwn(obj,key))||!id(obj.agentId)||!id(obj.eventId)||!id(obj.eventType))throw Error('INVALID');
 return {agentId:obj.agentId,eventId:obj.eventId,eventType:obj.eventType,payload:obj.payload};
}
/** Host supplies authentication, source authorization, definitions and network boundary. */
export function createAgentEventIngress(options:Options):Server {
 if(!options||!(options.triggers instanceof SqliteAgentTriggers)||!options.definitions||typeof options.definitions.get!=='function'||typeof options.authenticate!=='function'||typeof options.authorize!=='function'||!Number.isSafeInteger(options.maxPending)||options.maxPending<1||options.maxPending>10000||(options.clock!==undefined&&typeof options.clock!=='function'))throw Error('Invalid event ingress');
 const {triggers,definitions,authenticate,authorize,maxPending}=options,clock=options.clock??Date.now;
 return createServer(async(req,res)=>{
  if(req.method!=='POST'||req.url!=='/events'){reply(res,404,{error:'Not found'});return;}
  let source:SourceIdentity|undefined;try{source=await authenticate(req);}catch{}
  if(!source||!id(source.tenantId)||!id(source.principalId)||!id(source.sourceId)||source.sourceId.startsWith('schedule.')){reply(res,401,{error:'Unauthorized'});return;}
  source={tenantId:source.tenantId,principalId:source.principalId,sourceId:source.sourceId};
  let event:EventRequest;try{event=await read(req);}catch(error){const message=error instanceof Error?error.message:'';reply(res,message==='TOO_LARGE'?413:message==='CONTENT_TYPE'?415:400,{error:'Invalid event'});return;}
  try{
   const definition=definitions.get(source.tenantId,event.agentId);
   if(!definition||!definition.manifest.lifecycle.enabled||definition.manifest.tenantId!==source.tenantId||definition.manifest.agentId!==event.agentId){reply(res,403,{error:'Forbidden'});return;}
   let allowed=false;try{allowed=await authorize({...source},structuredClone(event),structuredClone(definition))===true;}catch{}
   const latest=definitions.get(source.tenantId,event.agentId);
   if(!allowed||!latest||latest.version!==definition.version||!latest.manifest.lifecycle.enabled){reply(res,403,{error:'Forbidden'});return;}
   const now=clock(),deadline=now+definition.manifest.lifecycle.runTimeoutMs;if(!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(deadline))throw Error('Invalid clock');
   const result=triggers.enqueue({tenantId:source.tenantId,agentId:event.agentId},{sourceId:source.sourceId,principalId:source.principalId,eventId:event.eventId,eventType:event.eventType,payload:event.payload},{definitionVersion:definition.version,maxAttempts:definition.manifest.lifecycle.maxAttempts,deadline,maxPending},now);
   reply(res,result.duplicate?200:202,result);
  }catch(error){const message=error instanceof Error?error.message:'';reply(res,message==='Trigger identity conflict'?409:message==='Trigger backlog full'?429:message==='Invalid trigger payload'?400:500,{error:message==='Trigger identity conflict'?'Event conflict':message==='Trigger backlog full'?'Backlog full':message==='Invalid trigger payload'?'Invalid event':'Event unavailable'});}
 });
}
export type {Options as AgentEventIngressOptions,SourceIdentity as AgentEventSourceIdentity,EventRequest as AgentEventRequest};
