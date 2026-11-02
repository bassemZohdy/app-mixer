import {KeyObject,sign} from 'node:crypto';
import {createNativeExtensionPlanFromRegistry} from './extension-adapters.js';
import {ExtensionRegistry} from './extensions.js';
import {validEnvironment} from './promotion.js';
import type {ApplicationDefinition} from './index.js';

export type SignedNativeExtensionPlan={version:1;keyId:string;payload:string;signature:string};
export type NativePlanSigningOptions={tenantId:string;environment:string;keyId:string;privateKey:KeyObject;issuedAt:number;expiresAt:number};
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
/** Sign a checked plan; the native host supplies its own trusted Ed25519 verifier. */
export function signNativeExtensionPlanFromRegistry(application:ApplicationDefinition,registry:ExtensionRegistry,options:NativePlanSigningOptions):SignedNativeExtensionPlan{
 if(!options||!id(options.tenantId)||!validEnvironment(options.environment)||!id(options.keyId)||!(options.privateKey instanceof KeyObject)||options.privateKey.type!=='private'||options.privateKey.asymmetricKeyType!=='ed25519'||!Number.isSafeInteger(options.issuedAt)||options.issuedAt<0||!Number.isSafeInteger(options.expiresAt)||options.expiresAt<=options.issuedAt||options.expiresAt-options.issuedAt>86400000)throw Error('Invalid native plan signing configuration');
 const plan=createNativeExtensionPlanFromRegistry(application,registry),payload=JSON.stringify({tenantId:options.tenantId,environment:options.environment,issuedAt:options.issuedAt,expiresAt:options.expiresAt,plan});if(Buffer.byteLength(payload,'utf8')>1000000)throw Error('Native extension plan too large');const signature=sign(null,Buffer.from(`app-mixer-native-plan-v1.${options.keyId}.${payload}`,'utf8'),options.privateKey).toString('base64url');return {version:1,keyId:options.keyId,payload,signature};
}
