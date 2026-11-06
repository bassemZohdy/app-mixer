import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import type {AgentEventSourceIdentity,AgentEventRequest} from './event-ingress.js';

export type LinearWebhookOptions={identity:AgentEventSourceIdentity;agentId:string;organizationId:string;secret:string;previousSecrets?:string[];clock?:()=>number;toleranceSeconds?:number};
const id=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(x);
const secret=(x:unknown):x is string=>typeof x==='string'&&/^[\x21-\x7e]{16,1024}$/.test(x);
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const decode=(body:Buffer):Record<string,unknown>=>{const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));if(!object(value))throw Error('Invalid Linear webhook payload');return value;};

/** One Linear webhook endpoint bound to a host-selected workspace (organization). */
export function createLinearWebhookAdapter(options:LinearWebhookOptions){
 const identity=options?.identity,tolerance=options?.toleranceSeconds??60;
 if(!options||!identity||!id(identity.tenantId)||!id(identity.principalId)||!id(identity.sourceId)||identity.sourceId.startsWith('schedule.')||!id(options.agentId)||!/^[A-Za-z0-9-]{8,64}$/.test(options.organizationId)||!secret(options.secret)||(options.previousSecrets!==undefined&&(!Array.isArray(options.previousSecrets)||options.previousSecrets.length>2||!options.previousSecrets.every(secret)))||!Number.isSafeInteger(tolerance)||tolerance<1||tolerance>3600||(options.clock!==undefined&&typeof options.clock!=='function'))throw Error('Invalid Linear webhook configuration');
 const keys=[options.secret,...(options.previousSecrets??[])];if(new Set(keys).size!==keys.length)throw Error('Invalid Linear webhook configuration');
 const fixed={tenantId:identity.tenantId,principalId:identity.principalId,sourceId:identity.sourceId},agentId=options.agentId,organizationId=options.organizationId,clock=options.clock??Date.now;
 return {
  authenticateRaw(req:IncomingMessage,body:Buffer):AgentEventSourceIdentity|undefined{
   let signature:string|undefined;for(let i=0;i<req.rawHeaders.length;i+=2)if(req.rawHeaders[i].toLowerCase()==='linear-signature'){if(signature!==undefined)return undefined;signature=req.rawHeaders[i+1];}
   if(!signature||!/^[a-f0-9]{64}$/.test(signature))return undefined;const actual=Buffer.from(signature,'hex');
   let matched=0;for(const key of keys)matched|=Number(timingSafeEqual(createHmac('sha256',key).update(body).digest(),actual));if(!matched)return undefined;
   // Only the signed body is trusted: the timestamp and organization are checked after the signature verifies.
   let payload:Record<string,unknown>;try{payload=decode(body);}catch{return undefined;}
   const now=clock(),stamp=payload.webhookTimestamp;if(!Number.isSafeInteger(now)||now<0||typeof stamp!=='number'||!Number.isSafeInteger(stamp)||Math.abs(now-stamp)>tolerance*1000)return undefined;
   return payload.organizationId===organizationId?{...fixed}:undefined;
  },
  mapAuthenticatedBody(body:Buffer):AgentEventRequest{
   const payload=decode(body);if(typeof payload.type!=='string'||!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(payload.type)||typeof payload.action!=='string'||!/^[a-z][a-z]{0,31}$/.test(payload.action))throw Error('Invalid Linear webhook payload');
   return {agentId,eventType:`linear.${payload.type}.${payload.action}`,eventId:'sha256:'+createHash('sha256').update(body).digest('hex'),payload};
  }
 };
}
