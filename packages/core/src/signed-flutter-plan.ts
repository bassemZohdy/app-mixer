import {KeyObject,sign} from 'node:crypto';
import {createFlutterExtensionPlan,type FlutterExtensionPlan} from './extension-adapters.js';
import type {ApplicationDefinition} from './index.js';
import type {ExtensionManifest,ExtensionHost} from './extensions.js';
import {validEnvironment} from './promotion.js';
export type SignedFlutterExtensionPlan={version:1;keyId:string;payload:string;signature:string};
type Options={tenantId:string;environment:string;keyId:string;privateKey:KeyObject;issuedAt:number;expiresAt:number};
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
/** Sign a compatibility-checked, short-lived Flutter plan for an explicitly selected tenant and environment. */
export function signFlutterExtensionPlan(application:ApplicationDefinition,manifests:ExtensionManifest[],host:ExtensionHost,options:Options):SignedFlutterExtensionPlan {
 if(!options||!id(options.tenantId)||!validEnvironment(options.environment)||!id(options.keyId)||!(options.privateKey instanceof KeyObject)||options.privateKey.type!=='private'||options.privateKey.asymmetricKeyType!=='ed25519'||!Number.isSafeInteger(options.issuedAt)||options.issuedAt<0||!Number.isSafeInteger(options.expiresAt)||options.expiresAt<=options.issuedAt||options.expiresAt-options.issuedAt>86400000)throw Error('Invalid Flutter plan signing configuration');
 const plan:FlutterExtensionPlan=createFlutterExtensionPlan(application,manifests,host),payload=Buffer.from(JSON.stringify({tenantId:options.tenantId,environment:options.environment,issuedAt:options.issuedAt,expiresAt:options.expiresAt,plan}),'utf8').toString('base64url');if(payload.length>1000000)throw Error('Flutter extension plan too large');const signature=sign(null,Buffer.from(`app-mixer-flutter-plan-v1.${options.keyId}.${payload}`,'utf8'),options.privateKey).toString('base64url');return {version:1,keyId:options.keyId,payload,signature};
}
export type {Options as FlutterPlanSigningOptions};
