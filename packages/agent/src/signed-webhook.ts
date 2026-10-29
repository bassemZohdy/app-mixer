import {createHmac,timingSafeEqual} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import type {AgentEventSourceIdentity} from './event-ingress.js';

export type SignedWebhookSource = AgentEventSourceIdentity & {secret:Uint8Array;previousSecrets?:Uint8Array[]};
export type SignedWebhookOptions = {sources:SignedWebhookSource[];clock?:()=>number;maxAgeSeconds?:number};
const id=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(x);
function oneHeader(req:IncomingMessage,name:string):string|undefined {
 let value:string|undefined;for(let i=0;i<req.rawHeaders.length;i+=2){if(req.rawHeaders[i].toLowerCase()===name){if(value!==undefined)return undefined;value=req.rawHeaders[i+1];}}return value;
}
/** Host-controlled keys authenticate a source and its exact event body, before parsing. */
export function createSignedWebhookAuthenticator(options:SignedWebhookOptions){
 if(!options||!Array.isArray(options.sources)||options.sources.length<1||options.sources.length>1000||(options.clock!==undefined&&typeof options.clock!=='function'))throw Error('Invalid webhook configuration');
 const maxAge=options.maxAgeSeconds??300,clock=options.clock??Date.now;if(!Number.isSafeInteger(maxAge)||maxAge<1||maxAge>3600)throw Error('Invalid webhook configuration');
 const sources=new Map<string,{identity:AgentEventSourceIdentity;secrets:Buffer[]}>();
 for(const source of options.sources){
  if(!source||!id(source.sourceId)||source.sourceId.startsWith('schedule.')||!id(source.tenantId)||!id(source.principalId)||sources.has(source.sourceId)||(source.previousSecrets!==undefined&&(!Array.isArray(source.previousSecrets)||source.previousSecrets.length>2)))throw Error('Invalid webhook configuration');
  const keys=[source.secret,...(source.previousSecrets??[])];if(keys.some(key=>!(key instanceof Uint8Array)||key.byteLength<32||key.byteLength>1024))throw Error('Invalid webhook configuration');const secrets=keys.map(key=>Buffer.from(key));if(secrets.some((key,i)=>secrets.slice(0,i).some(other=>other.equals(key))))throw Error('Invalid webhook configuration');
  sources.set(source.sourceId,{identity:{tenantId:source.tenantId,principalId:source.principalId,sourceId:source.sourceId},secrets});
 }
 return (req:IncomingMessage,body:Buffer):AgentEventSourceIdentity|undefined=>{
  const sourceId=oneHeader(req,'x-app-mixer-source'),timestamp=oneHeader(req,'x-app-mixer-timestamp'),signature=oneHeader(req,'x-app-mixer-signature');
  if(!sourceId||!timestamp||!signature||!/^(0|[1-9][0-9]{0,12})$/.test(timestamp)||!/^v1=[a-f0-9]{64}$/.test(signature))return undefined;
  const source=sources.get(sourceId),seconds=Number(timestamp),now=clock();if(!source||!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(seconds)||Math.abs(Math.floor(now/1000)-seconds)>maxAge)return undefined;
  const actual=Buffer.from(signature.slice(3),'hex');let matched=0;for(const secret of source.secrets){const expected=createHmac('sha256',secret).update(`v1\n${timestamp}\n${sourceId}\n`,'utf8').update(body).digest();matched|=Number(timingSafeEqual(expected,actual));}
  return matched?{...source.identity}:undefined;
 };
}
