import type {AgentNoticeMessage} from './agent-notice-delivery.js';
import type {AgentRunScope} from './durable-runs.js';

type Destination={id:string;url:string;bearerToken:string};
type Options={scope:AgentRunScope;destinations:Destination[];timeoutMs?:number};
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(value);
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0;

function createClient(options:Options,verify:boolean):(message:AgentNoticeMessage,destinationId:string,idempotencyKey:string)=>Promise<boolean>{
 const timeout=options?.timeoutMs??10000;
 if(!options||!options.scope||!id(options.scope.tenantId)||!id(options.scope.agentId)||!Array.isArray(options.destinations)||options.destinations.length<1||options.destinations.length>100||!Number.isSafeInteger(timeout)||timeout<100||timeout>60000)throw Error('Invalid notice transport configuration');
 const destinations=new Map<string,{url:string;bearerToken:string}>();
 for(const destination of options.destinations){
  if(!destination||!id(destination.id)||destinations.has(destination.id)||typeof destination.url!=='string'||destination.url.length>2048||typeof destination.bearerToken!=='string'||!/^\S{32,1024}$/.test(destination.bearerToken)||/[^\x21-\x7e]/.test(destination.bearerToken))throw Error('Invalid notice transport configuration');
  let url:URL;try{url=new URL(destination.url);}catch{throw Error('Invalid notice transport configuration');}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw Error('Invalid notice transport configuration');
  destinations.set(destination.id,{url:url.href,bearerToken:destination.bearerToken});
 }
 const scope={tenantId:options.scope.tenantId,agentId:options.scope.agentId};
 return async(message,destinationId,idempotencyKey)=>{
  const target=destinations.get(destinationId);
  if(!target||!message||message.tenantId!==scope.tenantId||message.agentId!==scope.agentId||!positive(message.noticeId)||!id(message.runId)||!['approval_requested','delegation_renewal_required'].includes(message.kind)||!id(message.subjectId)||!Number.isSafeInteger(message.subjectRevision)||message.subjectRevision<0||typeof idempotencyKey!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(idempotencyKey))throw Error('Invalid notice transport request');
  const payload={version:1,noticeId:message.noticeId,tenantId:scope.tenantId,agentId:scope.agentId,runId:message.runId,kind:message.kind,subjectId:message.subjectId,subjectRevision:message.subjectRevision};
  try{const response=await fetch(verify?target.url.replace(/\/$/,'')+'/status':target.url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(timeout),headers:{authorization:`Bearer ${target.bearerToken}`,'content-type':'application/json','idempotency-key':idempotencyKey},body:JSON.stringify(payload)});void response.body?.cancel().catch(()=>{});if(verify){if(response.status===204)return true;if(response.status===404)return false;throw Error();}if(!response.ok)throw Error();return true;}catch{throw Error(verify?'Notice verification failed':'Notice transport failed');}
 };
}
/** Host-selected HTTPS endpoints receive metadata only. The receiver must enforce idempotency. */
export function createAgentNoticeHttpsTransport(options:Options):(message:AgentNoticeMessage,destinationId:string,idempotencyKey:string)=>Promise<void>{const send=createClient(options,false);return async(message,destination,key)=>{await send(message,destination,key);};}
/** Only a positive, authenticated receipt proves delivery; absence remains inconclusive. */
export function createAgentNoticeHttpsVerifier(options:Options):(message:AgentNoticeMessage,destinationId:string,idempotencyKey:string)=>Promise<boolean>{return createClient(options,true);}
export type {Options as AgentNoticeHttpsTransportOptions,Destination as AgentNoticeHttpsDestination};
