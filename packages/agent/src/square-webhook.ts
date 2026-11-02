import {createHmac,timingSafeEqual} from 'node:crypto';
import {Temporal} from '@js-temporal/polyfill';
import type {IncomingMessage} from 'node:http';
import type {AgentEventSourceIdentity,AgentEventRequest} from './event-ingress.js';

export type SquareWebhookOptions={identity:AgentEventSourceIdentity;agentId:string;merchantId:string;notificationUrl:string;eventTypes:string[];signatureKey:string;previousSignatureKeys?:string[];maxAgeMs?:number;futureSkewMs?:number;clock?:()=>number};
const id=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(x);
const key=(x:unknown):x is string=>typeof x==='string'&&/^[\x21-\x7e]{8,1024}$/.test(x);
const eventType=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(x);
/** One fixed Square merchant and host-approved set of event types. */
export function createSquareWebhookAdapter(options:SquareWebhookOptions){
 const identity=options?.identity;let url:URL;try{url=new URL(options.notificationUrl);}catch{throw Error('Invalid Square webhook configuration');}
 if(!identity||!id(identity.tenantId)||!id(identity.principalId)||!id(identity.sourceId)||identity.sourceId.startsWith('schedule.')||!id(options.agentId)||!id(options.merchantId)||typeof options.notificationUrl!=='string'||options.notificationUrl.length>2048||/[\x00-\x20\x7f]/.test(options.notificationUrl)||url.protocol!=='https:'||!!url.username||!!url.password||!!url.hash||!Array.isArray(options.eventTypes)||options.eventTypes.length<1||options.eventTypes.length>100||!options.eventTypes.every(eventType)||new Set(options.eventTypes).size!==options.eventTypes.length||!key(options.signatureKey)||(options.previousSignatureKeys!==undefined&&(!Array.isArray(options.previousSignatureKeys)||options.previousSignatureKeys.length>2||!options.previousSignatureKeys.every(key)))||(options.maxAgeMs!==undefined&&(!Number.isSafeInteger(options.maxAgeMs)||options.maxAgeMs<60000||options.maxAgeMs>604800000))||(options.futureSkewMs!==undefined&&(!Number.isSafeInteger(options.futureSkewMs)||options.futureSkewMs<0||options.futureSkewMs>300000))||(options.maxAgeMs===undefined&&(options.futureSkewMs!==undefined||options.clock!==undefined))||(options.clock!==undefined&&typeof options.clock!=='function'))throw Error('Invalid Square webhook configuration');
 const keys=[options.signatureKey,...(options.previousSignatureKeys??[])];if(new Set(keys).size!==keys.length)throw Error('Invalid Square webhook configuration');const fixed={tenantId:identity.tenantId,principalId:identity.principalId,sourceId:identity.sourceId},agentId=options.agentId,merchantId=options.merchantId,notificationUrl=options.notificationUrl,allowed=new Set(options.eventTypes),maxAgeMs=options.maxAgeMs,futureSkewMs=options.futureSkewMs??60000,clock=options.clock??Date.now;
 const fresh=(event:Record<string,unknown>):boolean=>{if(maxAgeMs===undefined)return true;const timestamp=event.created_at;if(typeof timestamp!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/i.test(timestamp))return false;try{const observed=Temporal.Instant.from(timestamp).epochMilliseconds,now=clock();return Number.isSafeInteger(now)&&now>=0&&Number.isSafeInteger(observed)&&observed>=0&&observed>=now-maxAgeMs&&observed<=now+futureSkewMs;}catch{return false;}};
 return {
  authenticateRaw(req:IncomingMessage,body:Buffer):AgentEventSourceIdentity|undefined{
   let signature:string|undefined;for(let i=0;i<req.rawHeaders.length;i+=2)if(req.rawHeaders[i].toLowerCase()==='x-square-hmacsha256-signature'){if(signature!==undefined)return undefined;signature=req.rawHeaders[i+1];}
   if(!signature||!/^[A-Za-z0-9+/]{43}=$/.test(signature))return undefined;const actual=Buffer.from(signature,'base64');if(actual.toString('base64')!==signature)return undefined;let matched=0;for(const secret of keys)matched|=Number(timingSafeEqual(createHmac('sha256',secret).update(notificationUrl,'utf8').update(body).digest(),actual));if(!matched)return undefined;if(maxAgeMs!==undefined){try{const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));if(!value||typeof value!=='object'||Array.isArray(value)||!fresh(value as Record<string,unknown>))return undefined;}catch{return undefined;}}return {...fixed};
  },
  mapAuthenticatedBody(body:Buffer):AgentEventRequest{
   const payload:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));if(!payload||typeof payload!=='object'||Array.isArray(payload))throw Error('Invalid Square webhook event');const event=payload as Record<string,unknown>;if(!fresh(event)||event.merchant_id!==merchantId||!eventType(event.type)||!allowed.has(event.type)||!id(event.event_id)||event.event_id.length>120||!event.data||typeof event.data!=='object'||Array.isArray(event.data))throw Error('Invalid Square webhook event');return {agentId,eventType:'square.'+event.type,eventId:'square.'+event.event_id,payload};
  }
 };
}
