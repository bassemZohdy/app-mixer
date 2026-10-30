import {createHmac,timingSafeEqual} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import type {AgentEventSourceIdentity,AgentEventRequest} from './event-ingress.js';

export type SlackWebhookOptions={identity:AgentEventSourceIdentity;agentId:string;appId:string;teamId:string;secret:string;previousSecrets?:string[];clock?:()=>number;toleranceSeconds?:number};
const id=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(x);
const secret=(x:unknown):x is string=>typeof x==='string'&&/^[\x21-\x7e]{32,1024}$/.test(x);
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const decode=(body:Buffer):Record<string,unknown>=>{const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));if(!object(value))throw Error('Invalid Slack event');return value;};

/** One Slack Events API endpoint bound to a host-selected app and workspace. */
export function createSlackWebhookAdapter(options:SlackWebhookOptions){
 const identity=options?.identity,tolerance=options?.toleranceSeconds??300;
 if(!options||!identity||!id(identity.tenantId)||!id(identity.principalId)||!id(identity.sourceId)||identity.sourceId.startsWith('schedule.')||!id(options.agentId)||!/^A[A-Z0-9]{1,127}$/.test(options.appId)||!/^T[A-Z0-9]{1,127}$/.test(options.teamId)||!secret(options.secret)||(options.previousSecrets!==undefined&&(!Array.isArray(options.previousSecrets)||options.previousSecrets.length>2||!options.previousSecrets.every(secret)))||!Number.isSafeInteger(tolerance)||tolerance<1||tolerance>3600||(options.clock!==undefined&&typeof options.clock!=='function'))throw Error('Invalid Slack webhook configuration');
 const keys=[options.secret,...(options.previousSecrets??[])];if(new Set(keys).size!==keys.length)throw Error('Invalid Slack webhook configuration');
 const fixed={tenantId:identity.tenantId,principalId:identity.principalId,sourceId:identity.sourceId},agentId=options.agentId,appId=options.appId,teamId=options.teamId,clock=options.clock??Date.now;
 return {
  authenticateRaw(req:IncomingMessage,body:Buffer):AgentEventSourceIdentity|undefined {
   let timestamp:string|undefined,signature:string|undefined;
   for(let i=0;i<req.rawHeaders.length;i+=2){const name=req.rawHeaders[i].toLowerCase();if(name==='x-slack-request-timestamp'){if(timestamp!==undefined)return undefined;timestamp=req.rawHeaders[i+1];}else if(name==='x-slack-signature'){if(signature!==undefined)return undefined;signature=req.rawHeaders[i+1];}}
   if(!timestamp||!/^(0|[1-9][0-9]{0,12})$/.test(timestamp)||!signature||!/^v0=[a-f0-9]{64}$/.test(signature))return undefined;
   const now=clock(),seconds=Number(timestamp);if(!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(seconds)||Math.abs(Math.floor(now/1000)-seconds)>tolerance)return undefined;
   const actual=Buffer.from(signature.slice(3),'hex');let matched=0;for(const key of keys)matched|=Number(timingSafeEqual(createHmac('sha256',key).update(`v0:${timestamp}:`,'utf8').update(body).digest(),actual));return matched?{...fixed}:undefined;
  },
  challengeAuthenticatedBody(body:Buffer):string|undefined {
   const event=decode(body);if(event.type!=='url_verification')return undefined;if(typeof event.challenge!=='string'||!/^[\x21-\x7e]{1,512}$/.test(event.challenge))throw Error('Invalid Slack challenge');return event.challenge;
  },
  mapAuthenticatedBody(body:Buffer):AgentEventRequest {
   const envelope=decode(body),event=envelope.event;
   if(envelope.type!=='event_callback'||envelope.api_app_id!==appId||envelope.team_id!==teamId||typeof envelope.event_id!=='string'||!/^Ev[A-Za-z0-9]{1,126}$/.test(envelope.event_id)||!object(event)||!id(event.type))throw Error('Invalid Slack event');
   // The deprecated verification token is not needed for authentication or execution.
   delete envelope.token;return {agentId,eventId:envelope.event_id,eventType:event.type,payload:envelope};
  }
 };
}
