import {createHmac,timingSafeEqual} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import type {AgentEventSourceIdentity,AgentEventRequest} from './event-ingress.js';

export type PaddleWebhookOptions={identity:AgentEventSourceIdentity;agentId:string;secret:string;previousSecrets?:string[];clock?:()=>number;toleranceSeconds?:number};
const id=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(x);
const secret=(x:unknown):x is string=>typeof x==='string'&&/^[\x21-\x7e]{16,1024}$/.test(x);

/** One host-configured Paddle Billing notification destination. */
export function createPaddleWebhookAdapter(options:PaddleWebhookOptions){
 const identity=options?.identity,tolerance=options?.toleranceSeconds??5;
 if(!options||!identity||!id(identity.tenantId)||!id(identity.principalId)||!id(identity.sourceId)||identity.sourceId.startsWith('schedule.')||!id(options.agentId)||!secret(options.secret)||(options.previousSecrets!==undefined&&(!Array.isArray(options.previousSecrets)||options.previousSecrets.length>2||!options.previousSecrets.every(secret)))||!Number.isSafeInteger(tolerance)||tolerance<1||tolerance>3600||(options.clock!==undefined&&typeof options.clock!=='function'))throw Error('Invalid Paddle webhook configuration');
 const keys=[options.secret,...(options.previousSecrets??[])];if(new Set(keys).size!==keys.length)throw Error('Invalid Paddle webhook configuration');
 const fixed={tenantId:identity.tenantId,principalId:identity.principalId,sourceId:identity.sourceId},agentId=options.agentId,clock=options.clock??Date.now;
 return {
  acknowledgement:'paddle' as const,
  authenticateRaw(req:IncomingMessage,body:Buffer):AgentEventSourceIdentity|undefined{
   let header:string|undefined;for(let i=0;i<req.rawHeaders.length;i+=2)if(req.rawHeaders[i].toLowerCase()==='paddle-signature'){if(header!==undefined)return undefined;header=req.rawHeaders[i+1];}
   if(!header||header.length>4096)return undefined;const parts=header.split(';');if(parts.length>32)return undefined;let timestamp:string|undefined;const signatures:Buffer[]=[];
   for(const part of parts){const match=/^\s*([A-Za-z0-9]+)=([^\s;=]+)\s*$/.exec(part);if(!match)return undefined;const [,name,value]=match;if(name==='ts'){if(timestamp!==undefined||!/^(0|[1-9][0-9]{0,15})$/.test(value))return undefined;timestamp=value;}else if(name==='h1'){if(!/^[a-f0-9]{64}$/.test(value)||signatures.length>=16)return undefined;signatures.push(Buffer.from(value,'hex'));}}
   if(timestamp===undefined||!signatures.length)return undefined;const now=clock(),seconds=Number(timestamp);if(!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(seconds)||Math.abs(Math.floor(now/1000)-seconds)>tolerance)return undefined;
   let matched=0;for(const key of keys){const expected=createHmac('sha256',key).update(timestamp+':').update(body).digest();for(const value of signatures)matched|=Number(timingSafeEqual(expected,value));}return matched?{...fixed}:undefined;
  },
  mapAuthenticatedBody(body:Buffer):AgentEventRequest{
   const payload:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));if(!payload||typeof payload!=='object'||Array.isArray(payload))throw Error('Invalid Paddle event');const event=payload as Record<string,unknown>;if(typeof event.event_id!=='string'||!/^evt_[A-Za-z0-9]{1,124}$/.test(event.event_id)||!id(event.event_type)||typeof event.notification_id!=='string'||!/^ntf_[A-Za-z0-9]{1,124}$/.test(event.notification_id)||!event.data||typeof event.data!=='object'||Array.isArray(event.data))throw Error('Invalid Paddle event');const {notification_id:_notificationId,...stablePayload}=event;return {agentId,eventId:event.event_id,eventType:event.event_type,payload:stablePayload};
  }
 };
}
