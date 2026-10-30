import {createHmac,timingSafeEqual} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import type {AgentEventSourceIdentity,AgentEventRequest} from './event-ingress.js';

export type StripeWebhookOptions={identity:AgentEventSourceIdentity;agentId:string;secret:string;previousSecrets?:string[];clock?:()=>number;toleranceSeconds?:number};
const id=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(x);
const secret=(x:unknown):x is string=>typeof x==='string'&&/^whsec_[\x21-\x7e]{16,1018}$/.test(x);

/** One host-configured Stripe snapshot-event endpoint. */
export function createStripeWebhookAdapter(options:StripeWebhookOptions){
 const identity=options?.identity,tolerance=options?.toleranceSeconds??300;
 if(!options||!identity||!id(identity.tenantId)||!id(identity.principalId)||!id(identity.sourceId)||identity.sourceId.startsWith('schedule.')||!id(options.agentId)||!secret(options.secret)||(options.previousSecrets!==undefined&&(!Array.isArray(options.previousSecrets)||options.previousSecrets.length>2||!options.previousSecrets.every(secret)))||!Number.isSafeInteger(tolerance)||tolerance<1||tolerance>3600||(options.clock!==undefined&&typeof options.clock!=='function'))throw Error('Invalid Stripe webhook configuration');
 const keys=[options.secret,...(options.previousSecrets??[])];if(new Set(keys).size!==keys.length)throw Error('Invalid Stripe webhook configuration');
 const fixed={tenantId:identity.tenantId,principalId:identity.principalId,sourceId:identity.sourceId},agentId=options.agentId,clock=options.clock??Date.now;
 return {
  authenticateRaw(req:IncomingMessage,body:Buffer):AgentEventSourceIdentity|undefined{
   let header:string|undefined;for(let i=0;i<req.rawHeaders.length;i+=2)if(req.rawHeaders[i].toLowerCase()==='stripe-signature'){if(header!==undefined)return undefined;header=req.rawHeaders[i+1];}
   if(!header||header.length>4096)return undefined;const parts=header.split(',');if(parts.length>32)return undefined;let timestamp:string|undefined;const signatures:Buffer[]=[];
   for(const part of parts){const match=/^\s*([A-Za-z0-9]+)=([^\s,=]+)\s*$/.exec(part);if(!match)return undefined;const [,name,value]=match;if(name==='t'){if(timestamp!==undefined||!/^(0|[1-9][0-9]{0,15})$/.test(value))return undefined;timestamp=value;}else if(name==='v1'){if(!/^[a-f0-9]{64}$/.test(value)||signatures.length>=16)return undefined;signatures.push(Buffer.from(value,'hex'));}}
   if(timestamp===undefined||!signatures.length)return undefined;const now=clock(),seconds=Number(timestamp);if(!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(seconds)||Math.abs(Math.floor(now/1000)-seconds)>tolerance)return undefined;
   let matched=0;for(const key of keys){const expected=createHmac('sha256',key).update(timestamp+'.').update(body).digest();for(const value of signatures)matched|=Number(timingSafeEqual(expected,value));}return matched?{...fixed}:undefined;
  },
  mapAuthenticatedBody(body:Buffer):AgentEventRequest{
   const payload:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));if(!payload||typeof payload!=='object'||Array.isArray(payload))throw Error('Invalid Stripe event');const event=payload as Record<string,unknown>;if(event.object!=='event'||typeof event.id!=='string'||!/^evt_[A-Za-z0-9]{1,124}$/.test(event.id)||!id(event.type))throw Error('Invalid Stripe event');return {agentId,eventId:event.id,eventType:event.type,payload};
  }
 };
}
