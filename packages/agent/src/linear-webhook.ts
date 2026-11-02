import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import type {AgentEventSourceIdentity,AgentEventRequest} from './event-ingress.js';

export type LinearWebhookOptions={identity:AgentEventSourceIdentity;agentId:string;organizationId:string;webhookId:string;eventType:string;secret:string;previousSecrets?:string[];clock?:()=>number;toleranceMs?:number};
const id=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(x);
const secret=(x:unknown):x is string=>typeof x==='string'&&/^[\x21-\x7e]{32,1024}$/.test(x);
const decode=(body:Buffer):Record<string,unknown>=>{const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid Linear event');return value as Record<string,unknown>;};

// Normalize object key order while preserving array order and JSON value types.
function canonical(value:unknown):string{if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;const record=value as Record<string,unknown>;return `{${Object.keys(record).sort().map(key=>`${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;}

/** One host-selected Linear organization, webhook and data-change event type. */
export function createLinearWebhookAdapter(options:LinearWebhookOptions){
 const identity=options?.identity,tolerance=options?.toleranceMs??60000;
 if(!options||!identity||!id(identity.tenantId)||!id(identity.principalId)||!id(identity.sourceId)||identity.sourceId.startsWith('schedule.')||!id(options.agentId)||!id(options.organizationId)||!id(options.webhookId)||typeof options.eventType!=='string'||!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(options.eventType)||!secret(options.secret)||(options.previousSecrets!==undefined&&(!Array.isArray(options.previousSecrets)||options.previousSecrets.length>2||!options.previousSecrets.every(secret)))||!Number.isSafeInteger(tolerance)||tolerance<1000||tolerance>86400000||(options.clock!==undefined&&typeof options.clock!=='function'))throw Error('Invalid Linear webhook configuration');
 const keys=[options.secret,...(options.previousSecrets??[])];if(new Set(keys).size!==keys.length)throw Error('Invalid Linear webhook configuration');
 const fixed={tenantId:identity.tenantId,principalId:identity.principalId,sourceId:identity.sourceId},agentId=options.agentId,organizationId=options.organizationId,webhookId=options.webhookId,eventType=options.eventType,clock=options.clock??Date.now;
 return {
  acknowledgement:'linear' as const,
  authenticateRaw(req:IncomingMessage,body:Buffer):AgentEventSourceIdentity|undefined{
   let header:string|undefined;for(let i=0;i<req.rawHeaders.length;i+=2)if(req.rawHeaders[i].toLowerCase()==='linear-signature'){if(header!==undefined)return undefined;header=req.rawHeaders[i+1];}
   if(!header||!/^[a-f0-9]{64}$/.test(header))return undefined;const actual=Buffer.from(header,'hex');let matched=0;for(const key of keys)matched|=Number(timingSafeEqual(createHmac('sha256',key).update(body).digest(),actual));if(!matched)return undefined;
   try{const event=decode(body),now=clock();if(!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(event.webhookTimestamp)||Number(event.webhookTimestamp)<0||Math.abs(now-Number(event.webhookTimestamp))>tolerance)return undefined;}catch{return undefined;}return {...fixed};
  },
  mapAuthenticatedBody(body:Buffer):AgentEventRequest{
   const event=decode(body);if(event.organizationId!==organizationId||event.webhookId!==webhookId||event.type!==eventType||!['create','update','remove'].includes(String(event.action))||!event.data||typeof event.data!=='object'||Array.isArray(event.data))throw Error('Invalid Linear event');
   const {webhookTimestamp:_timestamp,...payload}=event;return {agentId,eventId:`linear.${createHash('sha256').update(canonical(payload)).digest('hex')}`,eventType:`linear.${eventType}.${event.action}`,payload};
  }
 };
}
