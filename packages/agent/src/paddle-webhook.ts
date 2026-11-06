import {createHmac,timingSafeEqual} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import type {AgentEventSourceIdentity,AgentEventRequest} from './event-ingress.js';
import {isIdentifier} from './validation.js';

export type PaddleWebhookOptions={identity:AgentEventSourceIdentity;agentId:string;secret:string;previousSecrets?:string[];clock?:()=>number;toleranceSeconds?:number};
const id=isIdentifier;
const secret=(x:unknown):x is string=>typeof x==='string'&&/^[\x21-\x7e]{16,1024}$/.test(x);
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);

/** Paddle Billing notifications sign `<ts>:<body>`; the header may list several `h1` signatures during secret rotation. */
export function createPaddleWebhookAdapter(options:PaddleWebhookOptions){
 const identity=options?.identity,tolerance=options?.toleranceSeconds??5;
 if(!options||!identity||!id(identity.tenantId)||!id(identity.principalId)||!id(identity.sourceId)||identity.sourceId.startsWith('schedule.')||!id(options.agentId)||!secret(options.secret)||(options.previousSecrets!==undefined&&(!Array.isArray(options.previousSecrets)||options.previousSecrets.length>2||!options.previousSecrets.every(secret)))||!Number.isSafeInteger(tolerance)||tolerance<1||tolerance>3600||(options.clock!==undefined&&typeof options.clock!=='function'))throw Error('Invalid Paddle webhook configuration');
 const keys=[options.secret,...(options.previousSecrets??[])];if(new Set(keys).size!==keys.length)throw Error('Invalid Paddle webhook configuration');
 const fixed={tenantId:identity.tenantId,principalId:identity.principalId,sourceId:identity.sourceId},agentId=options.agentId,clock=options.clock??Date.now;
 return {
  authenticateRaw(req:IncomingMessage,body:Buffer):AgentEventSourceIdentity|undefined{
   let header:string|undefined;for(let i=0;i<req.rawHeaders.length;i+=2)if(req.rawHeaders[i].toLowerCase()==='paddle-signature'){if(header!==undefined)return undefined;header=req.rawHeaders[i+1];}
   if(!header||header.length>512)return undefined;
   let timestamp:string|undefined;const signatures:string[]=[];
   for(const part of header.split(';')){const match=/^(ts|h1)=([A-Za-z0-9]+)$/.exec(part);if(!match)return undefined;if(match[1]==='ts'){if(timestamp!==undefined)return undefined;timestamp=match[2];}else{if(!/^[a-f0-9]{64}$/.test(match[2])||signatures.length>=3)return undefined;signatures.push(match[2]);}}
   if(timestamp===undefined||!/^(0|[1-9][0-9]{0,12})$/.test(timestamp)||!signatures.length)return undefined;
   const now=clock(),seconds=Number(timestamp);if(!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(seconds)||Math.abs(Math.floor(now/1000)-seconds)>tolerance)return undefined;
   let matched=0;for(const key of keys){const digest=createHmac('sha256',key).update(`${timestamp}:`,'utf8').update(body).digest();for(const signature of signatures)matched|=Number(timingSafeEqual(digest,Buffer.from(signature,'hex')));}
   return matched?{...fixed}:undefined;
  },
  mapAuthenticatedBody(body:Buffer):AgentEventRequest{
   const payload:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));if(!object(payload))throw Error('Invalid Paddle webhook payload');
   const {event_id:eventId,event_type:type}=payload;if(typeof eventId!=='string'||!/^[A-Za-z0-9_]{1,64}$/.test(eventId)||typeof type!=='string'||!/^[a-z][a-z_]{0,63}(\.[a-z][a-z_]{0,63}){0,3}$/.test(type))throw Error('Invalid Paddle webhook payload');
   return {agentId,eventType:`paddle.${type}`,eventId:`paddle:${eventId}`,payload};
  }
 };
}
