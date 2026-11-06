import {KeyObject,sign,verify} from 'node:crypto';
import {verifyPublicationRelease,type PublicationReleaseKey,type SignedPublicationRelease} from './signed-publication.js';

/** What a device that has never been online needs to start: who it acts for, for how long, and which signed release. */
export type OfflineProvisioningGrant={deviceId:string;tenantId:string;applicationId:string;principalId:string;environment:string;issuedAt:number;notAfter:number;release:SignedPublicationRelease};
export type SignedOfflineProvisioning={formatVersion:1;keyId:string;grant:OfflineProvisioningGrant;signature:string};
export const MAX_OFFLINE_PROVISIONING_MS=30*86400000;
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(value);
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const time=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;
const FIELDS='applicationId,deviceId,environment,issuedAt,notAfter,principalId,release,tenantId';
/** The exact signed bytes; the device recomputes them from the grant as delivered. */
const bytes=(keyId:string,grant:OfflineProvisioningGrant)=>Buffer.from(JSON.stringify(['app-mixer-offline-provisioning-v1',keyId,grant]),'utf8');
function checkGrant(grant:unknown,releaseKeys:PublicationReleaseKey[]):OfflineProvisioningGrant{
 if(!object(grant)||Object.keys(grant).sort().join(',')!==FIELDS||!id(grant.deviceId)||!id(grant.tenantId)||!id(grant.applicationId)||!id(grant.principalId)||!id(grant.environment)||!time(grant.issuedAt)||!time(grant.notAfter)||Number(grant.notAfter)<=Number(grant.issuedAt)||Number(grant.notAfter)-Number(grant.issuedAt)>MAX_OFFLINE_PROVISIONING_MS)throw Error('Invalid offline provisioning');
 verifyPublicationRelease(grant.release,grant.environment as string,grant.applicationId as string,releaseKeys);
 return grant as OfflineProvisioningGrant;
}

/**
 * Sign a provisioning grant for one device, carried to it out of band (for example by QR code, removable media or
 * an installer). The host authorizes the principal and device before calling this; the release must already verify.
 */
export function signOfflineProvisioning(input:Omit<OfflineProvisioningGrant,never>,options:{keyId:string;privateKey:KeyObject;releaseKeys:PublicationReleaseKey[]}):SignedOfflineProvisioning{
 if(!options||!id(options.keyId)||!(options.privateKey instanceof KeyObject)||options.privateKey.type!=='private'||options.privateKey.asymmetricKeyType!=='ed25519')throw Error('Invalid offline provisioning signing configuration');
 const checked=checkGrant(input,options.releaseKeys);
 // Fixed field order, so the device recomputes identical bytes.
 const grant:OfflineProvisioningGrant={deviceId:checked.deviceId,tenantId:checked.tenantId,applicationId:checked.applicationId,principalId:checked.principalId,environment:checked.environment,issuedAt:checked.issuedAt,notAfter:checked.notAfter,release:JSON.parse(JSON.stringify(checked.release))};
 return {formatVersion:1,keyId:options.keyId,grant,signature:sign(null,bytes(options.keyId,grant),options.privateKey).toString('base64url')};
}

/** Server-side check when a provisioned device first connects: the grant is genuine, current and for this device. */
export function verifyOfflineProvisioning(input:unknown,options:{environment:string;applicationId:string;deviceId:string;keys:PublicationReleaseKey[];releaseKeys:PublicationReleaseKey[];now:number}):OfflineProvisioningGrant{
 if(!options||!id(options.environment)||!id(options.applicationId)||!id(options.deviceId)||!Array.isArray(options.keys)||options.keys.length<1||options.keys.length>20||!time(options.now))throw Error('Invalid offline provisioning verification configuration');
 const trusted=new Map<string,KeyObject>();for(const entry of options.keys){if(!entry||!id(entry.keyId)||!(entry.publicKey instanceof KeyObject)||entry.publicKey.type!=='public'||entry.publicKey.asymmetricKeyType!=='ed25519'||trusted.has(entry.keyId))throw Error('Invalid offline provisioning verification configuration');trusted.set(entry.keyId,entry.publicKey);}
 if(!object(input)||Object.keys(input).sort().join(',')!=='formatVersion,grant,keyId,signature'||input.formatVersion!==1||!id(input.keyId)||typeof input.signature!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(input.signature))throw Error('Invalid offline provisioning');
 const key=trusted.get(input.keyId);if(!key)throw Error('Invalid offline provisioning');
 let grant:OfflineProvisioningGrant;
 try{grant=checkGrant(input.grant,options.releaseKeys);const signature=Buffer.from(input.signature,'base64url');if(signature.length!==64||!verify(null,bytes(input.keyId,grant),key,signature))throw Error('signature');}catch{throw Error('Invalid offline provisioning');}
 if(grant.environment!==options.environment||grant.applicationId!==options.applicationId||grant.deviceId!==options.deviceId)throw Error('Offline provisioning is for another device or application');
 if(options.now<grant.issuedAt||options.now>=grant.notAfter)throw Error('Offline provisioning is not current');
 return grant;
}
