/**
 * Device-side opening of an offline provisioning grant (see signOfflineProvisioning in @app-mixer/core). Everything is
 * verified locally with WebCrypto Ed25519 against keys pinned in the installed app, so a device that has never been
 * online can start from a grant carried to it out of band. No network access is used.
 */
export type OfflineProvisioningKey={keyId:string;publicKey:string};
export type OfflineProvisioningRelease={formatVersion:1;environment:string;keyId:string;publication:{version:number;definition:{id:string;[key:string]:unknown}};signature:string};
export type OpenedOfflineProvisioning={deviceId:string;tenantId:string;applicationId:string;principalId:string;environment:string;issuedAt:number;notAfter:number;publication:OfflineProvisioningRelease['publication']};
export type OfflineProvisioningOptions={environment:string;applicationId:string;deviceId:string;keys:OfflineProvisioningKey[];releaseKeys:OfflineProvisioningKey[];now:number;crypto?:Crypto};
const MAX_MS=30*86400000;
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(value);
const releaseId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const time=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;
function decode(value:string,length:number):Uint8Array<ArrayBuffer>{
 if(!/^[A-Za-z0-9_-]*$/.test(value))throw Error('Invalid encoding');
 const binary=atob(value.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-value.length%4)%4)),out=new Uint8Array(new ArrayBuffer(binary.length));
 for(let i=0;i<binary.length;i++)out[i]=binary.charCodeAt(i);
 // Reject non-canonical spellings (padding bits set), so one signature has one encoding.
 if(out.length!==length||btoa(binary).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'')!==value)throw Error('Invalid encoding');
 return out;
}
async function keyring(crypto:Crypto,keys:OfflineProvisioningKey[],valid:(value:unknown)=>boolean):Promise<Map<string,CryptoKey>>{
 if(!Array.isArray(keys)||keys.length<1||keys.length>20)throw Error('Invalid offline provisioning configuration');
 const ring=new Map<string,CryptoKey>();
 for(const entry of keys){if(!entry||!valid(entry.keyId)||typeof entry.publicKey!=='string'||ring.has(entry.keyId))throw Error('Invalid offline provisioning configuration');const raw=decode(entry.publicKey,32);try{ring.set(entry.keyId,await crypto.subtle.importKey('raw',raw,{name:'Ed25519'},false,['verify']));}catch(error){throw (error as {name?:string})?.name==='NotSupportedError'?Error('Offline provisioning requires WebCrypto Ed25519, which this browser does not support'):error;}}
 return ring;
}
async function verified(crypto:Crypto,ring:Map<string,CryptoKey>,keyId:unknown,signature:unknown,message:unknown[]):Promise<boolean>{
 if(typeof keyId!=='string'||typeof signature!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(signature))return false;const key=ring.get(keyId);if(!key)return false;
 try{return await crypto.subtle.verify({name:'Ed25519'},key,decode(signature,64),new TextEncoder().encode(JSON.stringify(message)));}catch{return false;}
}

export async function openOfflineProvisioning(input:unknown,options:OfflineProvisioningOptions):Promise<OpenedOfflineProvisioning>{
 const crypto=options?.crypto??globalThis.crypto;
 if(!options||!crypto?.subtle||!id(options.environment)||!id(options.applicationId)||!id(options.deviceId)||!time(options.now))throw Error('Invalid offline provisioning configuration');
 const keys=await keyring(crypto,options.keys,id),releaseKeys=await keyring(crypto,options.releaseKeys,releaseId);
 if(!object(input)||Object.keys(input).sort().join(',')!=='formatVersion,grant,keyId,signature'||input.formatVersion!==1||!id(input.keyId))throw Error('Invalid offline provisioning');
 const grant=input.grant;
 if(!object(grant)||Object.keys(grant).sort().join(',')!=='applicationId,deviceId,environment,issuedAt,notAfter,principalId,release,tenantId'||!id(grant.deviceId)||!id(grant.tenantId)||!id(grant.applicationId)||!id(grant.principalId)||!id(grant.environment)||!time(grant.issuedAt)||!time(grant.notAfter)||grant.notAfter<=grant.issuedAt||grant.notAfter-grant.issuedAt>MAX_MS)throw Error('Invalid offline provisioning');
 if(!await verified(crypto,keys,input.keyId,input.signature,['app-mixer-offline-provisioning-v1',input.keyId,grant]))throw Error('Invalid offline provisioning');
 const release=grant.release;
 if(!object(release)||Object.keys(release).sort().join(',')!=='environment,formatVersion,keyId,publication,signature'||release.formatVersion!==1||release.environment!==grant.environment||!releaseId(release.keyId)||!object(release.publication))throw Error('Invalid offline provisioning release');
 const publication=release.publication;
 if(Object.keys(publication).sort().join(',')!=='definition,version'||!Number.isSafeInteger(publication.version)||Number(publication.version)<1||!object(publication.definition)||publication.definition.id!==grant.applicationId)throw Error('Invalid offline provisioning release');
 if(!await verified(crypto,releaseKeys,release.keyId,release.signature,['app-mixer-publication-release-v1',release.environment,release.keyId,publication]))throw Error('Invalid offline provisioning release');
 if(grant.environment!==options.environment||grant.applicationId!==options.applicationId||grant.deviceId!==options.deviceId)throw Error('Offline provisioning is for another device or application');
 if(options.now<grant.issuedAt||options.now>=grant.notAfter)throw Error('Offline provisioning is not current');
 return {deviceId:grant.deviceId,tenantId:grant.tenantId,applicationId:grant.applicationId,principalId:grant.principalId,environment:grant.environment,issuedAt:grant.issuedAt,notAfter:grant.notAfter,publication:JSON.parse(JSON.stringify(publication))};
}
