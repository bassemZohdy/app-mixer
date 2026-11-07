import {X509Certificate,createPrivateKey,createHash} from 'node:crypto';
import {createSecureContext} from 'node:tls';
import type {Server as HttpsServer} from 'node:https';

export type TlsCredentials={cert:string|Buffer;key:string|Buffer;clientCa?:string|Buffer};
/** `subject` is empty for a certificate without one (cert-manager's default); `altNames` lists its subject alternative names. */
export type TlsCredentialInfo={fingerprint:string;subject:string;altNames:string;validFrom:number;validTo:number};
export type TlsCredentialReloaderOptions={
 load:()=>TlsCredentials|Promise<TlsCredentials>;
 intervalMs:number;
 /** Must match whether the server was created with a client CA; a reload cannot add or remove client-certificate authentication. */
 clientCa:boolean;
 clock?:()=>number;
 onReload?:(info:TlsCredentialInfo)=>void;
 onError?:(error:Error)=>void;
};
const pem=(value:unknown):value is string|Buffer=>(typeof value==='string'&&value.trim().length>0&&value.length<=65536)||(Buffer.isBuffer(value)&&value.length>0&&value.length<=65536);

/** Validate a certificate chain and private key before use: parseable, matching, and currently valid. */
export function validateTlsCredentials(credentials:TlsCredentials,now:number=Date.now()):TlsCredentialInfo{
 if(!credentials||typeof credentials!=='object'||Object.keys(credentials).some(key=>!['cert','key','clientCa'].includes(key))||!pem(credentials.cert)||!pem(credentials.key)||(credentials.clientCa!==undefined&&!pem(credentials.clientCa))||!Number.isSafeInteger(now))throw Error('Invalid TLS credentials');
 let leaf:X509Certificate;
 try{leaf=new X509Certificate(credentials.cert);if(!leaf.checkPrivateKey(createPrivateKey(credentials.key)))throw Error('mismatch');if(credentials.clientCa!==undefined)new X509Certificate(credentials.clientCa);createSecureContext({cert:credentials.cert,key:credentials.key,minVersion:'TLSv1.2',...(credentials.clientCa!==undefined?{ca:credentials.clientCa}:{})});}
 catch{throw Error('Invalid TLS credentials');}
 const validFrom=Date.parse(leaf.validFrom),validTo=Date.parse(leaf.validTo);
 if(!Number.isFinite(validFrom)||!Number.isFinite(validTo)||now<validFrom||now>=validTo)throw Error('TLS certificate is not currently valid');
 // The served certificate may contain intermediates after the leaf. Hash the
 // complete chain and trust bundle so a chain-only rotation is not skipped.
 const chain=Buffer.from(credentials.cert),ca=credentials.clientCa===undefined?Buffer.alloc(0):Buffer.from(credentials.clientCa);
 const fingerprint=createHash('sha256').update(`${chain.length}:`).update(chain).update(`${ca.length}:`).update(ca).digest('hex');
 return {fingerprint,subject:leaf.subject??'',altNames:leaf.subjectAltName??'',validFrom,validTo};
}

/** Periodically reload server credentials; invalid or unchanged credentials keep the current context. */
export function createTlsCredentialReloader(server:HttpsServer,options:TlsCredentialReloaderOptions){
 if(!server||typeof (server as {setSecureContext?:unknown}).setSecureContext!=='function'||!options||typeof options.load!=='function'||!Number.isSafeInteger(options.intervalMs)||options.intervalMs<1000||options.intervalMs>86400000||typeof options.clientCa!=='boolean'||(options.clock!==undefined&&typeof options.clock!=='function')||(options.onReload!==undefined&&typeof options.onReload!=='function')||(options.onError!==undefined&&typeof options.onError!=='function'))throw Error('Invalid TLS reloader configuration');
 const {load,clientCa,onReload,onError,intervalMs}=options,clock=options.clock??Date.now;let current:string|undefined,running:Promise<boolean>|undefined,stopped=false;
 const report=(error:unknown)=>{try{onError?.(error instanceof Error?error:Error('TLS reload failed'));}catch{}};
 const attempt=async():Promise<boolean>=>{
  const credentials=await load();if(stopped)return false;
  if(!credentials||(credentials.clientCa!==undefined)!==clientCa)throw Error('TLS client CA presence changed');
  const info=validateTlsCredentials(credentials,clock());if(info.fingerprint===current)return false;
  server.setSecureContext({cert:credentials.cert,key:credentials.key,minVersion:'TLSv1.2',...(credentials.clientCa!==undefined?{ca:credentials.clientCa}:{})});
  current=info.fingerprint;try{onReload?.({...info});}catch{}return true;
 };
 /** Load once now. Resolves true when new credentials were applied; rejects when they were invalid. */
 const reloadNow=():Promise<boolean>=>{if(stopped)return Promise.resolve(false);if(!running)running=attempt().finally(()=>{running=undefined;});return running;};
 const timer=setInterval(()=>{reloadNow().catch(report);},intervalMs);timer.unref?.();
 return {reloadNow,stop(){stopped=true;clearInterval(timer);}};
}
