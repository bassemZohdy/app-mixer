import {JwtJwksManager,type JwtJwksManagerOptions} from './jwt-jwks-manager.js';

export type OidcDiscoveryOptions={issuer:string;timeoutMs:number;allowedJwksOrigins?:string[];allowLoopbackHttp?:boolean};
export type OidcJwtJwksManagerOptions=Omit<JwtJwksManagerOptions,'jwksUrl'> & {issuer:string;allowedJwksOrigins?:string[]};

function checkedUrl(value:unknown,allowLoopbackHttp:boolean):URL{
 if(typeof value!=='string'||!value||value.length>2048||/[\x00-\x20\x7f]/.test(value))throw Error('Invalid OIDC discovery configuration');
 let url:URL;try{url=new URL(value);}catch{throw Error('Invalid OIDC discovery configuration');}
 if(url.username||url.password||url.search||url.hash||!(url.protocol==='https:'||(allowLoopbackHttp&&url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))))throw Error('Invalid OIDC discovery configuration');
 return url;
}

/** Discover a key set only for a host-configured issuer and explicitly trusted origins. */
export async function discoverOidcJwks(options:OidcDiscoveryOptions):Promise<{issuer:string;jwksUrl:string}>{
 if(!options||!Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<100||options.timeoutMs>30000||(options.allowLoopbackHttp!==undefined&&typeof options.allowLoopbackHttp!=='boolean')||(options.allowedJwksOrigins!==undefined&&(!Array.isArray(options.allowedJwksOrigins)||options.allowedJwksOrigins.length>20)))throw Error('Invalid OIDC discovery configuration');
 const issuer=options.issuer,allow=options.allowLoopbackHttp===true,base=checkedUrl(issuer,allow),origins=new Set([base.origin]);
 for(const origin of options.allowedJwksOrigins??[]){const parsed=checkedUrl(origin,allow);if(parsed.pathname!=='/')throw Error('Invalid OIDC discovery configuration');origins.add(parsed.origin);}
 const url=issuer.replace(/\/$/,'')+'/.well-known/openid-configuration';
 try{
  const response=await fetch(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(options.timeoutMs),headers:{accept:'application/json'}});
  if(!response.ok||!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??'')||!response.body)throw Error('Invalid metadata');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let length=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>128*1024)throw Error('Metadata too large');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
  const data:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
  if(!data||typeof data!=='object'||Array.isArray(data))throw Error('Invalid metadata');
  const metadata=data as Record<string,unknown>;if(metadata.issuer!==issuer)throw Error('Issuer mismatch');
  const jwks=checkedUrl(metadata.jwks_uri,allow);if(!origins.has(jwks.origin))throw Error('Untrusted JWKS origin');
  return {issuer,jwksUrl:jwks.href};
 }catch{throw Error('OIDC discovery failed');}
}

/** Bind discovery to the authenticator's issuer before creating the key manager. */
export async function createOidcJwtJwksManager(options:OidcJwtJwksManagerOptions):Promise<JwtJwksManager>{
 if(!options||typeof options.authenticator?.isIssuer!=='function'||!options.authenticator.isIssuer(options.issuer))throw Error('OIDC issuer mismatch');
 const {issuer,allowedJwksOrigins,authenticator,pollMs,maxStaleMs,timeoutMs,onError,allowLoopbackHttp,clock}=options;
 const metadata=await discoverOidcJwks({issuer,timeoutMs,allowedJwksOrigins:allowedJwksOrigins?.slice(),allowLoopbackHttp});
 return new JwtJwksManager({authenticator,jwksUrl:metadata.jwksUrl,pollMs,maxStaleMs,timeoutMs,onError,allowLoopbackHttp,clock});
}
