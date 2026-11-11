import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import type {AgentEventSourceIdentity,AgentEventRequest} from './event-ingress.js';
import {isIdentifier} from './validation.js';

export type SentryWebhookOptions={identity:AgentEventSourceIdentity;agentId:string;installationId:string;secret:string;previousSecrets?:string[]};
const id=isIdentifier;
const secret=(x:unknown):x is string=>typeof x==='string'&&/^[\x21-\x7e]{16,1024}$/.test(x);
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const decode=(body:Buffer):Record<string,unknown>=>{const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));if(!object(value))throw Error('Invalid Sentry webhook payload');return value;};

/** One Sentry integration installation. The signature covers only the body, so the installation is pinned from the signed payload. */
export function createSentryWebhookAdapter(options:SentryWebhookOptions){
 const identity=options?.identity;
 if(!options||!identity||!id(identity.tenantId)||!id(identity.principalId)||!id(identity.sourceId)||identity.sourceId.startsWith('schedule.')||!id(options.agentId)||!/^[A-Za-z0-9-]{8,64}$/.test(options.installationId)||!secret(options.secret)||(options.previousSecrets!==undefined&&(!Array.isArray(options.previousSecrets)||options.previousSecrets.length>2||!options.previousSecrets.every(secret))))throw Error('Invalid Sentry webhook configuration');
 const keys=[options.secret,...(options.previousSecrets??[])];if(new Set(keys).size!==keys.length)throw Error('Invalid Sentry webhook configuration');
 const fixed={tenantId:identity.tenantId,principalId:identity.principalId,sourceId:identity.sourceId},agentId=options.agentId,installationId=options.installationId;
 return {
  authenticateRaw(req:IncomingMessage,body:Buffer):AgentEventSourceIdentity|undefined{
   let signature:string|undefined;for(let i=0;i<req.rawHeaders.length;i+=2)if(req.rawHeaders[i].toLowerCase()==='sentry-hook-signature'){if(signature!==undefined)return undefined;signature=req.rawHeaders[i+1];}
   if(!signature||!/^[a-f0-9]{64}$/.test(signature))return undefined;const actual=Buffer.from(signature,'hex');
   let matched=0;for(const key of keys)matched|=Number(timingSafeEqual(createHmac('sha256',key).update(body).digest(),actual));if(!matched)return undefined;
   // Only the signed body is trusted: the installation is checked after the signature verifies.
   let payload:Record<string,unknown>;try{payload=decode(body);}catch{return undefined;}
   return object(payload.installation)&&payload.installation.uuid===installationId?{...fixed}:undefined;
  },
  mapAuthenticatedBody(body:Buffer):AgentEventRequest{
   const payload=decode(body),data=payload.data;
   // The resource name comes from the signed data object (for example `issue`), never from the unsigned Sentry-Hook-Resource header.
   const resources=object(data)?Object.keys(data):[];
   if(typeof payload.action!=='string'||!/^[a-z_]{1,32}$/.test(payload.action)||resources.length!==1||!/^[a-z_]{1,32}$/.test(resources[0]))throw Error('Invalid Sentry webhook payload');
   return {agentId,eventType:`sentry.${resources[0]}.${payload.action}`,eventId:'sha256:'+createHash('sha256').update(body).digest('hex'),payload};
  }
 };
}
