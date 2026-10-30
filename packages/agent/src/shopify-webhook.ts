import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import type {AgentEventSourceIdentity,AgentEventRequest} from './event-ingress.js';

export type ShopifyWebhookOptions={identity:AgentEventSourceIdentity;agentId:string;eventType:string;secret:Uint8Array;previousSecrets?:Uint8Array[]};
const id=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(x);

/** Shopify HTTPS webhooks sign only the body with an app-wide secret. */
export function createShopifyWebhookAdapter(options:ShopifyWebhookOptions){
 const identity=options?.identity;if(!options||!identity||!id(identity.tenantId)||!id(identity.principalId)||!id(identity.sourceId)||identity.sourceId.startsWith('schedule.')||!id(options.agentId)||!id(options.eventType)||(options.previousSecrets!==undefined&&(!Array.isArray(options.previousSecrets)||options.previousSecrets.length>2)))throw Error('Invalid Shopify webhook configuration');
 const keys=[options.secret,...(options.previousSecrets??[])];if(keys.some(key=>!(key instanceof Uint8Array)||key.byteLength<32||key.byteLength>1024))throw Error('Invalid Shopify webhook configuration');const secrets=keys.map(key=>Buffer.from(key));if(secrets.some((key,i)=>secrets.slice(0,i).some(other=>other.equals(key))))throw Error('Invalid Shopify webhook configuration');
 const fixed={tenantId:identity.tenantId,principalId:identity.principalId,sourceId:identity.sourceId},agentId=options.agentId,eventType=options.eventType;
 return {
  authenticateRaw(req:IncomingMessage,body:Buffer):AgentEventSourceIdentity|undefined{
   let signature:string|undefined;for(let i=0;i<req.rawHeaders.length;i+=2)if(req.rawHeaders[i].toLowerCase()==='x-shopify-hmac-sha256'){if(signature!==undefined)return undefined;signature=req.rawHeaders[i+1];}
   if(!signature||!/^[A-Za-z0-9+/]{43}=$/.test(signature))return undefined;const actual=Buffer.from(signature,'base64');if(actual.toString('base64')!==signature)return undefined;
   let matched=0;for(const key of secrets)matched|=Number(timingSafeEqual(createHmac('sha256',key).update(body).digest(),actual));return matched?{...fixed}:undefined;
  },
  mapAuthenticatedBody(body:Buffer):AgentEventRequest{
   const payload:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));if(!payload||typeof payload!=='object'||Array.isArray(payload))throw Error('Invalid Shopify webhook payload');return {agentId,eventType,eventId:'sha256:'+createHash('sha256').update(body).digest('hex'),payload};
  }
 };
}
