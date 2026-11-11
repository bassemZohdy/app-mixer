import {createHash,createPublicKey,verify,type KeyObject} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import type {AgentEventSourceIdentity,AgentEventRequest} from './event-ingress.js';
import {isIdentifier} from './validation.js';

export type SendGridWebhookOptions={identity:AgentEventSourceIdentity;agentId:string;verificationKey:string;previousVerificationKeys?:string[];clock?:()=>number;toleranceSeconds?:number};
const id=isIdentifier;
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
function header(req:IncomingMessage,name:string):string|undefined{let value:string|undefined;for(let i=0;i<req.rawHeaders.length;i+=2)if(req.rawHeaders[i].toLowerCase()===name){if(value!==undefined)return undefined;value=req.rawHeaders[i+1];}return value;}
function events(body:Buffer):Record<string,unknown>[]{
 const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));
 if(!Array.isArray(value)||value.length<1||value.length>1000||!value.every(item=>object(item)&&typeof item.event==='string'&&/^[a-z_]{1,32}$/.test(item.event)&&typeof item.sg_event_id==='string'&&item.sg_event_id.length>0&&item.sg_event_id.length<=128))throw Error('Invalid SendGrid event payload');
 return value as Record<string,unknown>[];
}
function publicKey(value:unknown):KeyObject{
 if(typeof value!=='string'||!/^[A-Za-z0-9+/]{60,200}={0,2}$/.test(value))throw Error('Invalid SendGrid webhook configuration');
 const key=createPublicKey({key:Buffer.from(value,'base64'),format:'der',type:'spki'});if(key.asymmetricKeyType!=='ec'||key.asymmetricKeyDetails?.namedCurve!=='prime256v1')throw Error('Invalid SendGrid webhook configuration');return key;
}

/**
 * One SendGrid Event Webhook endpoint. SendGrid signs the timestamp and raw body with ECDSA P-256; the verification
 * key (base64 DER) comes from the host's SendGrid settings. A delivery is a batch of events, mapped to one event.
 */
export function createSendGridWebhookAdapter(options:SendGridWebhookOptions){
 const identity=options?.identity,tolerance=options?.toleranceSeconds??300;
 if(!options||!identity||!id(identity.tenantId)||!id(identity.principalId)||!id(identity.sourceId)||identity.sourceId.startsWith('schedule.')||!id(options.agentId)||(options.previousVerificationKeys!==undefined&&(!Array.isArray(options.previousVerificationKeys)||options.previousVerificationKeys.length>2))||!Number.isSafeInteger(tolerance)||tolerance<1||tolerance>3600||(options.clock!==undefined&&typeof options.clock!=='function'))throw Error('Invalid SendGrid webhook configuration');
 let keys:KeyObject[];try{keys=[options.verificationKey,...(options.previousVerificationKeys??[])].map(publicKey);}catch{throw Error('Invalid SendGrid webhook configuration');}
 if(new Set([options.verificationKey,...(options.previousVerificationKeys??[])]).size!==keys.length)throw Error('Invalid SendGrid webhook configuration');
 const fixed={tenantId:identity.tenantId,principalId:identity.principalId,sourceId:identity.sourceId},agentId=options.agentId,clock=options.clock??Date.now;
 return {
  authenticateRaw(req:IncomingMessage,body:Buffer):AgentEventSourceIdentity|undefined{
   const signature=header(req,'x-twilio-email-event-webhook-signature'),timestamp=header(req,'x-twilio-email-event-webhook-timestamp');
   if(!signature||!/^[A-Za-z0-9+/]{40,120}={0,2}$/.test(signature)||!timestamp||!/^[1-9][0-9]{0,11}$/.test(timestamp))return undefined;
   const now=clock();if(!Number.isSafeInteger(now)||now<0||Math.abs(now-Number(timestamp)*1000)>tolerance*1000)return undefined;
   const message=Buffer.concat([Buffer.from(timestamp,'utf8'),body]),der=Buffer.from(signature,'base64');
   if(der.toString('base64')!==signature)return undefined;
   let matched=false;for(const key of keys){try{matched||=verify('sha256',message,key,der);}catch{}}if(!matched)return undefined;
   try{events(body);}catch{return undefined;}return {...fixed};
  },
  mapAuthenticatedBody(body:Buffer):AgentEventRequest{
   const batch=events(body);
   return {agentId,eventType:'sendgrid.events',eventId:'sha256:'+createHash('sha256').update(body).digest('hex'),payload:{events:batch}};
  }
 };
}
