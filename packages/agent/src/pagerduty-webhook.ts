import {createHmac,timingSafeEqual} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import type {AgentEventSourceIdentity,AgentEventRequest} from './event-ingress.js';

export type PagerDutyWebhookOptions={identity:AgentEventSourceIdentity;agentId:string;secret:string;previousSecrets?:string[]};
const id=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(x);
const secret=(x:unknown):x is string=>typeof x==='string'&&/^[\x21-\x7e]{16,1024}$/.test(x);
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);

/** PagerDuty v3 webhook subscriptions sign the body; the header may hold several `v1=` signatures during rotation. */
export function createPagerDutyWebhookAdapter(options:PagerDutyWebhookOptions){
 const identity=options?.identity;
 if(!options||!identity||!id(identity.tenantId)||!id(identity.principalId)||!id(identity.sourceId)||identity.sourceId.startsWith('schedule.')||!id(options.agentId)||!secret(options.secret)||(options.previousSecrets!==undefined&&(!Array.isArray(options.previousSecrets)||options.previousSecrets.length>2||!options.previousSecrets.every(secret))))throw Error('Invalid PagerDuty webhook configuration');
 const keys=[options.secret,...(options.previousSecrets??[])];if(new Set(keys).size!==keys.length)throw Error('Invalid PagerDuty webhook configuration');
 const fixed={tenantId:identity.tenantId,principalId:identity.principalId,sourceId:identity.sourceId},agentId=options.agentId;
 return {
  authenticateRaw(req:IncomingMessage,body:Buffer):AgentEventSourceIdentity|undefined{
   let header:string|undefined;for(let i=0;i<req.rawHeaders.length;i+=2)if(req.rawHeaders[i].toLowerCase()==='x-pagerduty-signature'){if(header!==undefined)return undefined;header=req.rawHeaders[i+1];}
   if(!header||header.length>1024)return undefined;const parts=header.split(',');if(parts.length>4||parts.some(part=>!/^v1=[a-f0-9]{64}$/.test(part)))return undefined;
   const expected=keys.map(key=>createHmac('sha256',key).update(body).digest());let matched=0;
   for(const part of parts){const actual=Buffer.from(part.slice(3),'hex');for(const digest of expected)matched|=Number(timingSafeEqual(digest,actual));}
   return matched?{...fixed}:undefined;
  },
  mapAuthenticatedBody(body:Buffer):AgentEventRequest{
   const payload:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));if(!object(payload)||!object(payload.event))throw Error('Invalid PagerDuty webhook payload');
   const {id:eventId,event_type:type}=payload.event;if(typeof eventId!=='string'||!/^[A-Za-z0-9]{1,64}$/.test(eventId)||typeof type!=='string'||!/^[a-z][a-z0-9_.]{0,63}$/.test(type))throw Error('Invalid PagerDuty webhook payload');
   return {agentId,eventType:`pagerduty.${type}`,eventId:`pagerduty:${eventId}`,payload};
  }
 };
}
