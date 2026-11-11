import {createHash,timingSafeEqual} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import type {AgentEventSourceIdentity,AgentEventRequest} from './event-ingress.js';
import {isIdentifier} from './validation.js';

export type TelegramWebhookOptions={identity:AgentEventSourceIdentity;agentId:string;secret:string;previousSecrets?:string[]}&({updateType:string;updateTypes?:never}|{updateType?:never;updateTypes:string[]});
const id=isIdentifier;
const secret=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9_-]{32,256}$/.test(x);
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const digest=(value:string)=>createHash('sha256').update(value,'utf8').digest();
const validType=(value:unknown):value is string=>typeof value==='string'&&value!=='update_id'&&/^[a-z][a-z0-9_]{0,63}$/.test(value);

/** One host-selected Telegram bot webhook and allowed update types. */
export function createTelegramWebhookAdapter(options:TelegramWebhookOptions){
 const identity=options?.identity;if(!options||!identity||!id(identity.tenantId)||!id(identity.principalId)||!id(identity.sourceId)||identity.sourceId.startsWith('schedule.')||!id(options.agentId)||!secret(options.secret)||(options.previousSecrets!==undefined&&(!Array.isArray(options.previousSecrets)||options.previousSecrets.length>2||!options.previousSecrets.every(secret))))throw Error('Invalid Telegram webhook configuration');
 const hasSingle=options.updateType!==undefined,hasMultiple=options.updateTypes!==undefined;if(hasSingle===hasMultiple)throw Error('Invalid Telegram webhook configuration');
 const selected=hasSingle?[options.updateType]:(Array.isArray(options.updateTypes)?options.updateTypes:[]);if(selected.length<1||selected.length>32||!selected.every(validType)||new Set(selected).size!==selected.length)throw Error('Invalid Telegram webhook configuration');
 const tokens=[options.secret,...(options.previousSecrets??[])];if(new Set(tokens).size!==tokens.length)throw Error('Invalid Telegram webhook configuration');
 const hashes=tokens.map(digest),fixed={tenantId:identity.tenantId,principalId:identity.principalId,sourceId:identity.sourceId},agentId=options.agentId,allowedTypes=new Set(selected);
 return {
  authenticateRaw(req:IncomingMessage,_body:Buffer):AgentEventSourceIdentity|undefined{
   let received:string|undefined;for(let i=0;i<req.rawHeaders.length;i+=2)if(req.rawHeaders[i].toLowerCase()==='x-telegram-bot-api-secret-token'){if(received!==undefined)return undefined;received=req.rawHeaders[i+1];}
   if(!secret(received))return undefined;const actual=digest(received);let matched=0;for(const hash of hashes)matched|=Number(timingSafeEqual(hash,actual));return matched?{...fixed}:undefined;
  },
  mapAuthenticatedBody(body:Buffer):AgentEventRequest{
   const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));if(!object(value)||Object.keys(value).length!==2||!Number.isSafeInteger(value.update_id)||Number(value.update_id)<1)throw Error('Invalid Telegram update');const updateType=Object.keys(value).find(key=>key!=='update_id');if(!updateType||!allowedTypes.has(updateType)||!object(value[updateType]))throw Error('Invalid Telegram update');
   return {agentId,eventId:`telegram.${value.update_id}`,eventType:`telegram.${updateType}`,payload:value};
  }
 };
}
