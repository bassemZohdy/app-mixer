import {createPublicKey,verify,type KeyObject} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import type {AgentEventSourceIdentity,AgentEventRequest} from './event-ingress.js';

export type DiscordWebhookOptions={identity:AgentEventSourceIdentity;agentId:string;applicationId:string;publicKey:string;clock?:()=>number;toleranceSeconds?:number};
const id=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(x);
const snowflake=(x:unknown):x is string=>typeof x==='string'&&/^[1-9][0-9]{0,19}$/.test(x);
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const decode=(body:Buffer):Record<string,unknown>=>{const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));if(!object(value))throw Error('Invalid Discord interaction payload');return value;};
const TYPES:Record<number,string>={1:'ping',2:'command',3:'component',4:'autocomplete',5:'modal'};
function header(req:IncomingMessage,name:string):string|undefined{let value:string|undefined;for(let i=0;i<req.rawHeaders.length;i+=2)if(req.rawHeaders[i].toLowerCase()===name){if(value!==undefined)return undefined;value=req.rawHeaders[i+1];}return value;}

/**
 * One Discord interactions endpoint bound to a host-selected application. Discord signs the timestamp and raw body
 * with the application's Ed25519 key; the host must answer a `discord.ping` event with `{type: 1}`.
 */
export function createDiscordWebhookAdapter(options:DiscordWebhookOptions){
 const identity=options?.identity,tolerance=options?.toleranceSeconds??300;
 if(!options||!identity||!id(identity.tenantId)||!id(identity.principalId)||!id(identity.sourceId)||identity.sourceId.startsWith('schedule.')||!id(options.agentId)||!snowflake(options.applicationId)||typeof options.publicKey!=='string'||!/^[a-f0-9]{64}$/.test(options.publicKey)||!Number.isSafeInteger(tolerance)||tolerance<1||tolerance>3600||(options.clock!==undefined&&typeof options.clock!=='function'))throw Error('Invalid Discord webhook configuration');
 let key:KeyObject;try{key=createPublicKey({key:{kty:'OKP',crv:'Ed25519',x:Buffer.from(options.publicKey,'hex').toString('base64url')},format:'jwk'});}catch{throw Error('Invalid Discord webhook configuration');}
 const fixed={tenantId:identity.tenantId,principalId:identity.principalId,sourceId:identity.sourceId},agentId=options.agentId,applicationId=options.applicationId,clock=options.clock??Date.now;
 return {
  authenticateRaw(req:IncomingMessage,body:Buffer):AgentEventSourceIdentity|undefined{
   const signature=header(req,'x-signature-ed25519'),timestamp=header(req,'x-signature-timestamp');
   if(!signature||!/^[a-f0-9]{128}$/.test(signature)||!timestamp||!/^[1-9][0-9]{0,11}$/.test(timestamp))return undefined;
   const now=clock();if(!Number.isSafeInteger(now)||now<0||Math.abs(now-Number(timestamp)*1000)>tolerance*1000)return undefined;
   let valid=false;try{valid=verify(null,Buffer.concat([Buffer.from(timestamp,'utf8'),body]),key,Buffer.from(signature,'hex'));}catch{}if(!valid)return undefined;
   let payload:Record<string,unknown>;try{payload=decode(body);}catch{return undefined;}
   return payload.application_id===applicationId?{...fixed}:undefined;
  },
  mapAuthenticatedBody(body:Buffer):AgentEventRequest{
   const payload=decode(body),kind=typeof payload.type==='number'?TYPES[payload.type]:undefined;
   if(!kind||!snowflake(payload.id))throw Error('Invalid Discord interaction payload');
   const name=object(payload.data)&&typeof payload.data.name==='string'&&/^[\w-]{1,32}$/.test(payload.data.name)?payload.data.name:undefined;
   if(kind==='command'&&!name)throw Error('Invalid Discord interaction payload');
   return {agentId,eventType:kind==='ping'?'discord.ping':kind==='command'?`discord.command.${name}`:`discord.${kind}`,eventId:'discord:'+payload.id,payload};
  }
 };
}
