import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import type {AgentEventSourceIdentity,AgentEventRequest} from './event-ingress.js';

export type GitlabWebhookOptions={identity:AgentEventSourceIdentity;agentId:string;eventType:string;signingToken:string;previousSigningTokens?:string[];clock?:()=>number;toleranceSeconds?:number};
const id=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(x);
const token=(x:unknown):x is string=>{if(typeof x!=='string'||!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(x)||x.length>1400)return false;const encoded=x.slice(6),key=Buffer.from(encoded,'base64');return key.length===32&&key.toString('base64')===encoded;};

/** One GitLab project or group webhook bound to a host-selected source and event type. */
export function createGitlabWebhookAdapter(options:GitlabWebhookOptions){
 const identity=options?.identity,tolerance=options?.toleranceSeconds??300;
 if(!options||!identity||!id(identity.tenantId)||!id(identity.principalId)||!id(identity.sourceId)||identity.sourceId.startsWith('schedule.')||!id(options.agentId)||!id(options.eventType)||!token(options.signingToken)||(options.previousSigningTokens!==undefined&&(!Array.isArray(options.previousSigningTokens)||options.previousSigningTokens.length>2||!options.previousSigningTokens.every(token)))||!Number.isSafeInteger(tolerance)||tolerance<1||tolerance>3600||(options.clock!==undefined&&typeof options.clock!=='function'))throw Error('Invalid GitLab webhook configuration');
 const tokens=[options.signingToken,...(options.previousSigningTokens??[])];if(new Set(tokens).size!==tokens.length)throw Error('Invalid GitLab webhook configuration');
 const keys=tokens.map(value=>Buffer.from(value.slice(6),'base64')),fixed={tenantId:identity.tenantId,principalId:identity.principalId,sourceId:identity.sourceId},agentId=options.agentId,eventType=options.eventType,clock=options.clock??Date.now,verified=new WeakMap<IncomingMessage,{eventId:string;digest:string}>();
 return {
  authenticateRaw(req:IncomingMessage,body:Buffer):AgentEventSourceIdentity|undefined{
   verified.delete(req);let messageId:string|undefined,timestamp:string|undefined,header:string|undefined;
   for(let i=0;i<req.rawHeaders.length;i+=2){const name=req.rawHeaders[i].toLowerCase(),value=req.rawHeaders[i+1];if(name==='webhook-id'){if(messageId!==undefined)return undefined;messageId=value;}else if(name==='webhook-timestamp'){if(timestamp!==undefined)return undefined;timestamp=value;}else if(name==='webhook-signature'){if(header!==undefined)return undefined;header=value;}}
   if(!id(messageId)||!timestamp||!/^(0|[1-9][0-9]{0,12})$/.test(timestamp)||!header||header.length>4096)return undefined;
   const now=clock(),seconds=Number(timestamp);if(!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(seconds)||Math.abs(Math.floor(now/1000)-seconds)>tolerance)return undefined;
   const parts=header.split(' ');if(parts.length>16||parts.some(part=>!/^v1,[A-Za-z0-9+/]{43}=$/.test(part)))return undefined;
   const signatures=parts.map(part=>Buffer.from(part.slice(3),'base64'));if(signatures.some((signature,i)=>signature.length!==32||signature.toString('base64')!==parts[i].slice(3)))return undefined;
   let matched=0;for(const key of keys){const expected=createHmac('sha256',key).update(messageId+'.'+timestamp+'.','utf8').update(body).digest();for(const signature of signatures)matched|=Number(timingSafeEqual(expected,signature));}
   if(!matched)return undefined;verified.set(req,{eventId:messageId,digest:createHash('sha256').update(body).digest('hex')});return {...fixed};
  },
  mapAuthenticatedBody(body:Buffer,_identity:AgentEventSourceIdentity,req:IncomingMessage):AgentEventRequest{
   const proof=verified.get(req);verified.delete(req);if(!proof||proof.digest!==createHash('sha256').update(body).digest('hex'))throw Error('Invalid GitLab event');
   const payload:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));if(!payload||typeof payload!=='object'||Array.isArray(payload))throw Error('Invalid GitLab event');return {agentId,eventId:proof.eventId,eventType,payload};
  }
 };
}
