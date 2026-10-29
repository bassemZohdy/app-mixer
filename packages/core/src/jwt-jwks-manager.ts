import type {IncomingMessage} from 'node:http';
import type {JSONWebKeySet} from 'jose';
import type {createJwtCapabilityAuthenticator,JwtCapabilityActor} from './jwt-capability-auth.js';

type Authenticator=ReturnType<typeof createJwtCapabilityAuthenticator>;
export type JwtJwksManagerOptions={authenticator:Authenticator;jwksUrl:string;pollMs:number;maxStaleMs:number;timeoutMs:number;onError:(error:unknown)=>void;allowLoopbackHttp?:boolean;clock?:()=>number};
const integer=(x:unknown):x is number=>Number.isSafeInteger(x)&&Number(x)>=0;
/** Host-configured, bounded key refresh. Use authenticate, not the underlying authenticator. */
export class JwtJwksManager {
 private readonly auth:Authenticator;private readonly url:string;private readonly pollMs:number;private readonly maxStaleMs:number;private readonly timeoutMs:number;private readonly clock:()=>number;private readonly onError:(error:unknown)=>void;
 private lastSuccess?:number;private lastDocument?:string;private epoch=0;private cancelled=0;private closed=false;private active=false;private pending?:Promise<void>;private controller?:AbortController;private timer?:ReturnType<typeof setTimeout>;private closePromise?:Promise<void>;
 constructor(options:JwtJwksManagerOptions){
  if(!options||typeof options.authenticator!=='function'||typeof options.authenticator.replaceKeys!=='function'||typeof options.authenticator.close!=='function'||typeof options.jwksUrl!=='string'||options.jwksUrl.length>2048||!integer(options.pollMs)||options.pollMs<100||options.pollMs>3600000||!integer(options.maxStaleMs)||options.maxStaleMs<options.pollMs||options.maxStaleMs>86400000||!integer(options.timeoutMs)||options.timeoutMs<100||options.timeoutMs>30000||typeof options.onError!=='function'||(options.allowLoopbackHttp!==undefined&&typeof options.allowLoopbackHttp!=='boolean')||(options.clock!==undefined&&typeof options.clock!=='function'))throw Error('Invalid JWKS manager configuration');
  let url:URL;try{url=new URL(options.jwksUrl);}catch{throw Error('Invalid JWKS manager configuration');}if(url.username||url.password||url.search||url.hash||!(url.protocol==='https:'||(options.allowLoopbackHttp===true&&url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))))throw Error('Invalid JWKS manager configuration');
  this.auth=options.authenticator;this.url=url.href;this.pollMs=options.pollMs;this.maxStaleMs=options.maxStaleMs;this.timeoutMs=options.timeoutMs;this.onError=options.onError;this.clock=options.clock??Date.now;
 }
 private now():number{const value=this.clock();if(!integer(value))throw Error('Invalid clock');return value;}
 private fresh(now:number,last:number|undefined):boolean{return last!==undefined&&now>=last&&now-last<this.maxStaleMs;}
 /** Use as createCapabilityServer's authentication callback. */
 authenticate=async(req:IncomingMessage):Promise<JwtCapabilityActor|undefined>=>{
  try{const started=this.now(),last=this.lastSuccess,epoch=this.epoch;if(this.closed||!this.fresh(started,last))return undefined;const actor=await this.auth(req),finished=this.now();if(this.closed||this.epoch!==epoch||!this.fresh(finished,last)||!this.fresh(finished,this.lastSuccess))return undefined;return actor;}catch{return undefined;}
 };
 /** Fetch and validate the complete replacement set; failures retain the prior set only until maxStaleMs. */
 refresh():Promise<void>{
  if(this.closed)throw Error('JWKS manager closed');if(this.pending)return this.pending;const cancelled=this.cancelled,controller=new AbortController();this.controller=controller;
  const operation=(async()=>{try{const response=await fetch(this.url,{method:'GET',redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(this.timeoutMs)]),headers:{accept:'application/json'}});if(!response.ok||!/^application\/(?:json|jwk-set\+json)(?:\s*;|$)/i.test(response.headers.get('content-type')??'')||!response.body)throw Error('Invalid JWKS response');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let length=0;try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>128*1024)throw Error('JWKS too large');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}const document=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)),keys=JSON.parse(document) as JSONWebKeySet;if(this.closed||this.cancelled!==cancelled)throw Error('JWKS refresh cancelled');const now=this.now();if(document!==this.lastDocument){this.auth.replaceKeys(keys);this.epoch++;this.lastDocument=document;}this.lastSuccess=now;}catch{throw Error('JWKS refresh failed');}})();this.pending=operation;void operation.finally(()=>{if(this.pending===operation)this.pending=undefined;if(this.controller===controller)this.controller=undefined;}).catch(()=>{});return operation;
 }
 start():void{if(this.closed||this.active||this.pending)throw Error('JWKS manager unavailable');this.active=true;const loop=()=>{if(!this.active)return;const operation=this.refresh();void operation.catch(error=>{if(this.active)try{this.onError(error);}catch{}}).finally(()=>{if(this.active)this.timer=setTimeout(loop,this.pollMs);});};loop();}
 async stop():Promise<void>{this.active=false;this.cancelled++;if(this.timer)clearTimeout(this.timer);this.timer=undefined;this.controller?.abort();const pending=this.pending;if(pending)try{await pending;}catch{}}
 close():Promise<void>{if(this.closePromise)return this.closePromise;this.closed=true;this.epoch++;this.auth.close();this.closePromise=this.stop();return this.closePromise;}
}
