import {createHmac,timingSafeEqual} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import type {AgentEventSourceIdentity,AgentEventRequest} from './event-ingress.js';

export type StandardWebhookOptions={identity:AgentEventSourceIdentity;agentId:string;secret:string;previousSecrets?:string[];clock?:()=>number;toleranceSeconds?:number};
const id=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(x);
const base64=/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
function key(x:unknown):Buffer|undefined{
 if(typeof x!=='string'||!x.startsWith('whsec_')||!base64.test(x.slice(6)))return undefined;const bytes=Buffer.from(x.slice(6),'base64');return bytes.byteLength>=24&&bytes.byteLength<=64?bytes:undefined;
}
function header(req:IncomingMessage,name:string):string|undefined|null{
 let value:string|undefined;for(let i=0;i<req.rawHeaders.length;i+=2)if(req.rawHeaders[i].toLowerCase()===name){if(value!==undefined)return null;value=req.rawHeaders[i+1];}return value;
}

/** One host-configured endpoint for the Standard Webhooks signature scheme (symmetric `v1` signatures only). */
export function createStandardWebhookAdapter(options:StandardWebhookOptions){
 const identity=options?.identity,tolerance=options?.toleranceSeconds??300;
 if(!options||!identity||!id(identity.tenantId)||!id(identity.principalId)||!id(identity.sourceId)||identity.sourceId.startsWith('schedule.')||!id(options.agentId)||(options.previousSecrets!==undefined&&(!Array.isArray(options.previousSecrets)||options.previousSecrets.length>2))||!Number.isSafeInteger(tolerance)||tolerance<1||tolerance>3600||(options.clock!==undefined&&typeof options.clock!=='function'))throw Error('Invalid Standard Webhooks configuration');
 const keys=[options.secret,...(options.previousSecrets??[])].map(key);if(keys.some(value=>!value))throw Error('Invalid Standard Webhooks configuration');
 const secrets=keys as Buffer[];if(secrets.some((value,i)=>secrets.slice(0,i).some(other=>other.equals(value))))throw Error('Invalid Standard Webhooks configuration');
 const fixed={tenantId:identity.tenantId,principalId:identity.principalId,sourceId:identity.sourceId},agentId=options.agentId,clock=options.clock??Date.now;
 return {
  authenticateRaw(req:IncomingMessage,body:Buffer):AgentEventSourceIdentity|undefined{
   const messageId=header(req,'webhook-id'),timestamp=header(req,'webhook-timestamp'),signature=header(req,'webhook-signature');
   if(!id(messageId)||typeof timestamp!=='string'||!/^(0|[1-9][0-9]{0,15})$/.test(timestamp)||typeof signature!=='string'||signature.length>4096)return undefined;
   const now=clock(),seconds=Number(timestamp);if(!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(seconds)||Math.abs(Math.floor(now/1000)-seconds)>tolerance)return undefined;
   const entries=signature.split(' ').filter(Boolean),candidates:Buffer[]=[];if(!entries.length||entries.length>32)return undefined;
   for(const entry of entries){const comma=entry.indexOf(',');if(comma<1)return undefined;const version=entry.slice(0,comma),value=entry.slice(comma+1);if(version!=='v1')continue;if(value.length!==44||!base64.test(value))return undefined;candidates.push(Buffer.from(value,'base64'));}
   if(!candidates.length)return undefined;let matched=0;
   for(const secret of secrets){const expected=createHmac('sha256',secret).update(`${messageId}.${timestamp}.`).update(body).digest();for(const value of candidates)matched|=Number(value.byteLength===expected.byteLength&&timingSafeEqual(expected,value));}
   return matched?{...fixed}:undefined;
  },
  mapAuthenticatedBody(body:Buffer,_identity:AgentEventSourceIdentity,req:IncomingMessage):AgentEventRequest{
   const eventId=header(req,'webhook-id');if(!id(eventId))throw Error('Invalid Standard Webhooks event');
   const payload:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));if(!payload||typeof payload!=='object'||Array.isArray(payload))throw Error('Invalid Standard Webhooks event');
   const eventType=(payload as Record<string,unknown>).type;if(!id(eventType))throw Error('Invalid Standard Webhooks event');return {agentId,eventId,eventType,payload};
  }
 };
}
