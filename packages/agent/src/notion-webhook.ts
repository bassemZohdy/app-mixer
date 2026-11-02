import {createHmac,timingSafeEqual} from 'node:crypto';
import {Temporal} from '@js-temporal/polyfill';
import type {IncomingMessage} from 'node:http';
import type {AgentEventSourceIdentity,AgentEventRequest} from './event-ingress.js';

export type NotionWebhookOptions={identity:AgentEventSourceIdentity;agentId:string;workspaceId:string;subscriptionId:string;integrationId:string;eventTypes:string[];verificationToken:string;previousVerificationTokens?:string[];maxAgeMs?:number;futureSkewMs?:number;clock?:()=>number};
const id=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(x);
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(x);
const token=(x:unknown):x is string=>typeof x==='string'&&/^[\x21-\x7e]{16,1024}$/.test(x);
const timestamp=(x:unknown):boolean=>{if(typeof x!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/i.test(x))return false;try{Temporal.Instant.from(x);return true;}catch{return false;}};
const eventType=(x:unknown):x is string=>typeof x==='string'&&/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(x)&&x.length<=120;
/** One verified Notion subscription. Subscription verification is a separate trusted setup step. */
export function createNotionWebhookAdapter(options:NotionWebhookOptions){
 const identity=options?.identity;
 if(!options||!identity||!id(identity.tenantId)||!id(identity.principalId)||!id(identity.sourceId)||identity.sourceId.startsWith('schedule.')||!id(options.agentId)||!uuid(options.workspaceId)||!uuid(options.subscriptionId)||!uuid(options.integrationId)||!Array.isArray(options.eventTypes)||options.eventTypes.length<1||options.eventTypes.length>100||!options.eventTypes.every(eventType)||new Set(options.eventTypes).size!==options.eventTypes.length||!token(options.verificationToken)||(options.previousVerificationTokens!==undefined&&(!Array.isArray(options.previousVerificationTokens)||options.previousVerificationTokens.length>2||!options.previousVerificationTokens.every(token)))||(options.maxAgeMs!==undefined&&(!Number.isSafeInteger(options.maxAgeMs)||options.maxAgeMs<60000||options.maxAgeMs>604800000))||(options.futureSkewMs!==undefined&&(!Number.isSafeInteger(options.futureSkewMs)||options.futureSkewMs<0||options.futureSkewMs>300000))||(options.maxAgeMs===undefined&&(options.futureSkewMs!==undefined||options.clock!==undefined))||(options.clock!==undefined&&typeof options.clock!=='function'))throw Error('Invalid Notion webhook configuration');
 const keys=[options.verificationToken,...(options.previousVerificationTokens??[])];if(new Set(keys).size!==keys.length)throw Error('Invalid Notion webhook configuration');const fixed={tenantId:identity.tenantId,principalId:identity.principalId,sourceId:identity.sourceId},agentId=options.agentId,workspaceId=options.workspaceId,subscriptionId=options.subscriptionId,integrationId=options.integrationId,allowed=new Set(options.eventTypes),maxAgeMs=options.maxAgeMs,futureSkewMs=options.futureSkewMs??60000,clock=options.clock??Date.now;
 const fresh=(value:unknown):boolean=>{if(!timestamp(value))return false;if(maxAgeMs===undefined)return true;try{const at=Temporal.Instant.from(value as string).epochMilliseconds,now=clock();return Number.isSafeInteger(now)&&now>=0&&Number.isSafeInteger(at)&&at>=0&&at>=now-maxAgeMs&&at<=now+futureSkewMs;}catch{return false;}};
 return {
  authenticateRaw(req:IncomingMessage,body:Buffer):AgentEventSourceIdentity|undefined{
   let signature:string|undefined;for(let i=0;i<req.rawHeaders.length;i+=2)if(req.rawHeaders[i].toLowerCase()==='x-notion-signature'){if(signature!==undefined)return undefined;signature=req.rawHeaders[i+1];}
   if(!signature||!/^sha256=[a-f0-9]{64}$/.test(signature))return undefined;const actual=Buffer.from(signature.slice(7),'hex');let matched=0;for(const secret of keys)matched|=Number(timingSafeEqual(createHmac('sha256',secret).update(body).digest(),actual));if(!matched)return undefined;if(maxAgeMs!==undefined){try{const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));if(!value||typeof value!=='object'||Array.isArray(value)||!fresh((value as Record<string,unknown>).timestamp))return undefined;}catch{return undefined;}}return {...fixed};
  },
  mapAuthenticatedBody(body:Buffer):AgentEventRequest{
   const payload:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));if(!payload||typeof payload!=='object'||Array.isArray(payload))throw Error('Invalid Notion webhook event');const event=payload as Record<string,unknown>;
   if(event.workspace_id!==workspaceId||event.subscription_id!==subscriptionId||event.integration_id!==integrationId||!uuid(event.id)||!fresh(event.timestamp)||!eventType(event.type)||!allowed.has(event.type)||!Number.isSafeInteger(event.attempt_number)||Number(event.attempt_number)<1||Number(event.attempt_number)>8||!event.entity||typeof event.entity!=='object'||Array.isArray(event.entity)||!uuid((event.entity as Record<string,unknown>).id)||!id((event.entity as Record<string,unknown>).type)||!event.data||typeof event.data!=='object'||Array.isArray(event.data))throw Error('Invalid Notion webhook event');
   // Delivery attempts vary for the same signed event; omit only this transport field from the durable identity.
   const {attempt_number:_,...stablePayload}=event;return {agentId,eventType:'notion.'+event.type,eventId:'notion.'+event.id,payload:stablePayload};
  }
 };
}
