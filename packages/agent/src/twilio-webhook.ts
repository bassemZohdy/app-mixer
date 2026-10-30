import {createHash} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import twilio from 'twilio';
import type {AgentEventSourceIdentity,AgentEventRequest} from './event-ingress.js';

export type TwilioMessageWebhookOptions={identity:AgentEventSourceIdentity;agentId:string;accountSid:string;url:string;authToken:string;previousAuthTokens?:string[]};
const id=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(x);
const token=(x:unknown):x is string=>typeof x==='string'&&/^[a-fA-F0-9]{32}$/.test(x);
function form(body:Buffer):Record<string,string>{
 const raw=new TextDecoder('utf-8',{fatal:true}).decode(body),result:Record<string,string>=Object.create(null),parts=raw.split('&');
 if(parts.length>1000)throw Error('Invalid Twilio form');
 for(const part of parts){const index=part.indexOf('=');if(index<0)throw Error('Invalid Twilio form');const decode=(v:string)=>decodeURIComponent(v.replace(/\+/g,' '));const key=decode(part.slice(0,index)),value=decode(part.slice(index+1));if(!key||/[\x00-\x1f\x7f]/.test(key)||['__proto__','prototype','constructor'].includes(key)||Object.hasOwn(result,key))throw Error('Invalid Twilio form');result[key]=value;}
 return result;
}

/** Accept incoming Twilio Messaging webhooks for one configured account and agent. */
export function createTwilioMessageWebhookAdapter(options:TwilioMessageWebhookOptions){
 const identity=options?.identity;let parsed:URL;try{parsed=new URL(options.url);}catch{throw Error('Invalid Twilio webhook configuration');}
 if(!identity||!id(identity.tenantId)||!id(identity.principalId)||!id(identity.sourceId)||identity.sourceId.startsWith('schedule.')||!id(options.agentId)||!/^AC[a-fA-F0-9]{32}$/.test(options.accountSid)||parsed.protocol!=='https:'||!!parsed.username||!!parsed.password||!!parsed.hash||parsed.searchParams.has('bodySHA256')||!token(options.authToken)||(options.previousAuthTokens!==undefined&&(!Array.isArray(options.previousAuthTokens)||options.previousAuthTokens.length>2||!options.previousAuthTokens.every(token))))throw Error('Invalid Twilio webhook configuration');
 const keys=[options.authToken,...(options.previousAuthTokens??[])];if(new Set(keys).size!==keys.length)throw Error('Invalid Twilio webhook configuration');
 const fixed={...identity},agentId=options.agentId,accountSid=options.accountSid,url=options.url,verified=new WeakMap<IncomingMessage,string>();
 return {
  contentType:'application/x-www-form-urlencoded' as const,acknowledgement:'twiml' as const,
  authenticateRaw(req:IncomingMessage,body:Buffer):AgentEventSourceIdentity|undefined {
   verified.delete(req);let signature:string|undefined;
   for(let i=0;i<req.rawHeaders.length;i+=2)if(req.rawHeaders[i].toLowerCase()==='x-twilio-signature'){if(signature!==undefined)return undefined;signature=req.rawHeaders[i+1];}
   if(!signature||!/^[A-Za-z0-9+/]{27}=$/.test(signature)||Buffer.from(signature,'base64').toString('base64')!==signature)return undefined;
   let params:Record<string,string>;try{params=form(body);}catch{return undefined;}
   let valid=false;for(const key of keys)valid=twilio.validateRequest(key,signature,url,params)||valid;
   if(!valid)return undefined;verified.set(req,createHash('sha256').update(body).digest('hex'));return {...fixed};
  },
  mapAuthenticatedBody(body:Buffer,_identity:AgentEventSourceIdentity,req:IncomingMessage):AgentEventRequest {
   const digest=verified.get(req);verified.delete(req);if(!digest||digest!==createHash('sha256').update(body).digest('hex'))throw Error('Invalid Twilio event');
   const payload=form(body);if(payload.AccountSid!==accountSid||!/^(?:SM|MM)[a-fA-F0-9]{32}$/.test(payload.MessageSid??'')||!payload.From||!payload.To||typeof payload.Body!=='string')throw Error('Invalid Twilio event');
   return {agentId,eventId:payload.MessageSid,eventType:'twilio.message',payload};
  }
 };
}
