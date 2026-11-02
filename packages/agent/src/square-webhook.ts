import {createHmac,timingSafeEqual} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import type {AgentEventSourceIdentity,AgentEventRequest} from './event-ingress.js';

export type SquareWebhookOptions={identity:AgentEventSourceIdentity;agentId:string;merchantId:string;notificationUrl:string;eventTypes:string[];signatureKey:string;previousSignatureKeys?:string[]};
const id=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(x);
const key=(x:unknown):x is string=>typeof x==='string'&&/^[\x21-\x7e]{8,1024}$/.test(x);
const eventType=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(x);
/** One fixed Square merchant and host-approved set of event types. */
export function createSquareWebhookAdapter(options:SquareWebhookOptions){
 const identity=options?.identity;let url:URL;try{url=new URL(options.notificationUrl);}catch{throw Error('Invalid Square webhook configuration');}
 if(!identity||!id(identity.tenantId)||!id(identity.principalId)||!id(identity.sourceId)||identity.sourceId.startsWith('schedule.')||!id(options.agentId)||!id(options.merchantId)||typeof options.notificationUrl!=='string'||options.notificationUrl.length>2048||/[\x00-\x20\x7f]/.test(options.notificationUrl)||url.protocol!=='https:'||!!url.username||!!url.password||!!url.hash||!Array.isArray(options.eventTypes)||options.eventTypes.length<1||options.eventTypes.length>100||!options.eventTypes.every(eventType)||new Set(options.eventTypes).size!==options.eventTypes.length||!key(options.signatureKey)||(options.previousSignatureKeys!==undefined&&(!Array.isArray(options.previousSignatureKeys)||options.previousSignatureKeys.length>2||!options.previousSignatureKeys.every(key))))throw Error('Invalid Square webhook configuration');
 const keys=[options.signatureKey,...(options.previousSignatureKeys??[])];if(new Set(keys).size!==keys.length)throw Error('Invalid Square webhook configuration');const fixed={tenantId:identity.tenantId,principalId:identity.principalId,sourceId:identity.sourceId},agentId=options.agentId,merchantId=options.merchantId,notificationUrl=options.notificationUrl,allowed=new Set(options.eventTypes);
 return {
  authenticateRaw(req:IncomingMessage,body:Buffer):AgentEventSourceIdentity|undefined{
   let signature:string|undefined;for(let i=0;i<req.rawHeaders.length;i+=2)if(req.rawHeaders[i].toLowerCase()==='x-square-hmacsha256-signature'){if(signature!==undefined)return undefined;signature=req.rawHeaders[i+1];}
   if(!signature||!/^[A-Za-z0-9+/]{43}=$/.test(signature))return undefined;const actual=Buffer.from(signature,'base64');if(actual.toString('base64')!==signature)return undefined;let matched=0;for(const secret of keys)matched|=Number(timingSafeEqual(createHmac('sha256',secret).update(notificationUrl,'utf8').update(body).digest(),actual));return matched?{...fixed}:undefined;
  },
  mapAuthenticatedBody(body:Buffer):AgentEventRequest{
   const payload:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));if(!payload||typeof payload!=='object'||Array.isArray(payload))throw Error('Invalid Square webhook event');const event=payload as Record<string,unknown>;if(event.merchant_id!==merchantId||!eventType(event.type)||!allowed.has(event.type)||!id(event.event_id)||event.event_id.length>120||!event.data||typeof event.data!=='object'||Array.isArray(event.data))throw Error('Invalid Square webhook event');return {agentId,eventType:'square.'+event.type,eventId:'square.'+event.event_id,payload};
  }
 };
}
