import {createHash} from 'node:crypto';
import {checkPromotionPackage,validEnvironment} from './promotion.js';
import {checkPromotionEvidence,type PromotionSignatureEvidence} from './signed-promotion.js';
type ComponentProps = {id:string;props?:Record<string,string|number|boolean>};
export type Component = ComponentProps & ({type:'Text'|'Card'|'Table'|'Input'}|{type:'Extension';extensionId:string;name:string});
export type Page = {id:string;title:string;route:string;components:Component[];description?:string};
export type ExtensionReference = {id:string;version:string;scope:'platform'|'development'|'application'};
export type ExtensionOperation = {extensionId:string;kind:'tool'|'provider';name:string};
export type ApplicationDefinition = {id:string;schemaVersion:1|2;revision:number;pages:Page[];extensions?:ExtensionReference[];extensionOperations?:ExtensionOperation[]};
export type PublicationProvenance = {version:number;kind:'unknown'} | {version:number;kind:'publish';previousVersion:number;definitionSha256:string} | {version:number;kind:'rollback';previousVersion:number;sourceVersion:number;definitionSha256:string} | {version:number;kind:'promotion';previousVersion:number;sourceEnvironment:string;targetEnvironment:string;sourceVersion:number;packageDigest:string;definitionSha256:string;signature?:PromotionSignatureEvidence};
export function definitionSha256(definition:ApplicationDefinition):string{return createHash('sha256').update(JSON.stringify(definition)).digest('hex');}
export type PublicationGuard = (draft:ApplicationDefinition) => true;
export function enforcePublicationGuard(guard:PublicationGuard | undefined, draft:ApplicationDefinition):void {
 if(!guard){if(draft.extensions?.length || draft.extensionOperations?.length || draft.pages.some(page=>page.components.some(component=>component.type==='Extension')))throw Error('Extension compatibility failed');return;}
 const result:unknown=guard(structuredClone(draft));
 if(result instanceof Promise) result.catch(()=>{});
 if(result!==true)throw Error("Publication guard must synchronously return true");
}
export type Patch = {op:"addPage";page:Page}|{op:"setPageTitle";pageId:string;title:string}|{op:"setPageDescription";pageId:string;description:string}|{op:"addComponent";pageId:string;component:Component}|{op:'setExtensions';extensions:ExtensionReference[]}|{op:'setExtensionOperations';operations:ExtensionOperation[]};
const copy = <T>(x:T):T => structuredClone(x);
export function isValidExtensionReferences(value:unknown):value is ExtensionReference[] {
 if(!Array.isArray(value)||value.length>256)return false;
 const ids=new Set<string>();
 for(const ref of value){
  if(!ref||typeof ref!=='object'||Array.isArray(ref)||Object.keys(ref).length!==3||!Object.hasOwn(ref,'id')||!Object.hasOwn(ref,'version')||!Object.hasOwn(ref,'scope')||typeof ref.id!=='string'||!/^[a-z][a-z0-9.-]{0,127}$/.test(ref.id)||typeof ref.version!=='string'||!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(ref.version)||!['platform','development','application'].includes(ref.scope)||ids.has(ref.id))return false;
  ids.add(ref.id);
 }
 return true;
}
export function isValidExtensionOperations(value:unknown):value is ExtensionOperation[] {
 if(!Array.isArray(value)||value.length>256)return false;
 const seen=new Set<string>();
 for(const operation of value){
  if(!operation||typeof operation!=='object'||Array.isArray(operation)||Object.keys(operation).length!==3||!Object.hasOwn(operation,'extensionId')||!Object.hasOwn(operation,'kind')||!Object.hasOwn(operation,'name')||typeof operation.extensionId!=='string'||!/^[a-z][a-z0-9.-]{0,127}$/.test(operation.extensionId)||!['tool','provider'].includes(operation.kind)||typeof operation.name!=='string'||!/^[a-z][a-z0-9.-]{0,127}$/.test(operation.name))return false;
  const key=JSON.stringify([operation.extensionId,operation.kind,operation.name]);if(seen.has(key))return false;seen.add(key);
 }
 return true;
}
export function validate(d:ApplicationDefinition):void {
 if(!d.id.trim()||![1,2].includes(d.schemaVersion)||!Number.isSafeInteger(d.revision)||d.revision<0)throw Error("Invalid manifest");
 if(d.extensions!==undefined&&!isValidExtensionReferences(d.extensions))throw Error('Invalid manifest');
 if(d.extensionOperations!==undefined&&!isValidExtensionOperations(d.extensionOperations))throw Error('Invalid manifest');
 const ids=new Set<string>(),routes=new Set<string>();
 for(const p of d.pages){if((d.schemaVersion===1&&p.description!==undefined)||(d.schemaVersion===2&&(typeof p.description!=='string'||p.description.length>10000))||!p.id||!p.title||!p.route.startsWith("/")||ids.has(p.id)||routes.has(p.route))throw Error("Duplicate or invalid page");ids.add(p.id);routes.add(p.route);
 const components=new Set<string>();for(const c of p.components){if(!c.id||components.has(c.id)||(!['Text','Card','Table','Input'].includes(c.type) && !(c.type==='Extension' && typeof c.extensionId==='string' && /^[a-z][a-z0-9.-]{0,127}$/.test(c.extensionId) && typeof c.name==='string' && /^[a-z][a-z0-9.-]{0,127}$/.test(c.name))))throw Error("Invalid component");components.add(c.id);}
 }
}
export class ApplicationStore {
 private draft:ApplicationDefinition;private provenance=new Map<number,PublicationProvenance>();private published:{version:number;definition:ApplicationDefinition}[]=[];
 constructor(initial:ApplicationDefinition, private readonly publicationGuard?:PublicationGuard){validate(initial);if(publicationGuard!==undefined && typeof publicationGuard!=="function")throw Error("Invalid publication guard");this.draft=copy(initial);}
 getDraft(){return copy(this.draft);}
 getPublished(version?:number){if(version!==undefined&&(!Number.isSafeInteger(version)||version<1))throw Error("Invalid version");const p=version===undefined?this.published.at(-1):this.published.find(x=>x.version===version);return p?copy(p):undefined;}
 getPromotionFloor(sourceEnvironment:string,targetEnvironment:string):number{if(!validEnvironment(sourceEnvironment)||!validEnvironment(targetEnvironment)||sourceEnvironment===targetEnvironment)throw Error('Invalid promotion environment');let floor=0;for(const previous of this.provenance.values())if(previous.kind==='promotion'&&previous.sourceEnvironment===sourceEnvironment&&previous.targetEnvironment===targetEnvironment)floor=Math.max(floor,previous.sourceVersion);return floor;}
 getPublicationProvenance(version:number):PublicationProvenance|undefined{if(!Number.isSafeInteger(version)||version<1)throw Error('Invalid version');if(!this.published.some(p=>p.version===version))return undefined;return copy(this.provenance.get(version)??{version,kind:'unknown'});}
 apply(baseRevision:number,patches:Patch[]):ApplicationDefinition{
  if(baseRevision!==this.draft.revision)throw Error("Revision conflict");
  const candidate=copy(this.draft);
  for(const p of patches){switch(p.op){
   case "addPage":candidate.pages.push(copy(p.page));break;
   case "setPageTitle":{const page=candidate.pages.find(x=>x.id===p.pageId);if(!page)throw Error("Unknown page");page.title=p.title;break;}
   case "setPageDescription":{if(candidate.schemaVersion!==2||typeof p.description!=='string'||p.description.length>10000)throw Error('Invalid page description');const page=candidate.pages.find(x=>x.id===p.pageId);if(!page)throw Error('Unknown page');page.description=p.description;break;}
   case "addComponent":{const page=candidate.pages.find(x=>x.id===p.pageId);if(!page)throw Error("Unknown page");page.components.push(copy(p.component));break;}
   case 'setExtensions':if(!isValidExtensionReferences(p.extensions))throw Error('Invalid manifest');candidate.extensions=copy(p.extensions);break;
   case 'setExtensionOperations':if(!isValidExtensionOperations(p.operations))throw Error('Invalid manifest');candidate.extensionOperations=copy(p.operations);break;
   default: throw Error("Unknown patch operation");
  }}
  candidate.revision++;validate(candidate);this.draft=candidate;return copy(candidate);
 }
 migrateDraft(expectedRevision:number,targetVersion:number):ApplicationDefinition{
  if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0||!Number.isSafeInteger(targetVersion))throw Error('Invalid migration request');
  if(expectedRevision!==this.draft.revision)throw Error('Revision conflict');
  if(!((this.draft.schemaVersion===1&&targetVersion===2)||(this.draft.schemaVersion===2&&targetVersion===1)))throw Error('Unsupported schema migration');
  if(expectedRevision>=Number.MAX_SAFE_INTEGER)throw Error('Invalid migration request');
  const candidate=copy(this.draft);candidate.revision++;
  if(targetVersion===2){candidate.schemaVersion=2;candidate.pages=candidate.pages.map(page=>({...page,description:''}));}
  else{if(candidate.pages.some(page=>page.description!==''))throw Error('Migration would lose page descriptions');candidate.schemaVersion=1;candidate.pages=candidate.pages.map(({description:unused,...page})=>page);}
  validate(candidate);this.draft=candidate;return copy(candidate);
 }
 publish(expectedRevision:number){if(expectedRevision!==this.draft.revision)throw Error("Revision conflict");enforcePublicationGuard(this.publicationGuard,this.draft);const p={version:this.published.length+1,definition:copy(this.draft)},hash=definitionSha256(p.definition);this.published.push(p);this.provenance.set(p.version,{version:p.version,kind:'publish',previousVersion:p.version-1,definitionSha256:hash});return copy(p);}
 promote(input:unknown,expectedVersion:number,targetEnvironment:string,evidence?:PromotionSignatureEvidence){
  return this.promoteInternal(input,expectedVersion,targetEnvironment,evidence,false);
 }
 promoteAdvancing(input:unknown,expectedVersion:number,targetEnvironment:string,evidence?:PromotionSignatureEvidence){return this.promoteInternal(input,expectedVersion,targetEnvironment,evidence,true);}
 private promoteInternal(input:unknown,expectedVersion:number,targetEnvironment:string,evidence:PromotionSignatureEvidence|undefined,advancing:boolean){
  if(!Number.isSafeInteger(expectedVersion)||expectedVersion<0)throw Error('Invalid version');
  const item=checkPromotionPackage(input,targetEnvironment,this.draft.id),signature=evidence===undefined?undefined:checkPromotionEvidence(item,targetEnvironment,evidence,expectedVersion),latest=this.published.at(-1)?.version??0;
  if(latest!==expectedVersion)throw Error('Publication version conflict');
  if(advancing)for(const previous of this.provenance.values())if(previous.kind==='promotion'&&previous.sourceEnvironment===item.sourceEnvironment&&previous.targetEnvironment===targetEnvironment&&item.sourceVersion<=previous.sourceVersion)throw Error('Source publication did not advance');
  enforcePublicationGuard(this.publicationGuard,item.definition);
  const version=latest+1;if(!Number.isSafeInteger(version))throw Error('Invalid version');
  const publication={version,definition:item.definition},hash=definitionSha256(item.definition);
  this.published.push(publication);this.provenance.set(version,{version,kind:'promotion',previousVersion:latest,sourceEnvironment:item.sourceEnvironment,targetEnvironment,sourceVersion:item.sourceVersion,packageDigest:item.digest,definitionSha256:hash,...(signature?{signature}: {})});return copy(publication);
 }
 promoteVerified(input:unknown,expectedVersion:number,targetEnvironment:string,evidence:PromotionSignatureEvidence){if(evidence===undefined)throw Error('Invalid promotion evidence');return this.promote(input,expectedVersion,targetEnvironment,evidence);}
 rollback(sourceVersion:number,expectedVersion:number){
  if(!Number.isSafeInteger(sourceVersion)||sourceVersion<1||!Number.isSafeInteger(expectedVersion)||expectedVersion<1)throw Error('Invalid version');
  const latest=this.published.at(-1);if(!latest||latest.version!==expectedVersion)throw Error('Publication version conflict');
  const source=this.published.find(p=>p.version===sourceVersion);if(!source)throw Error('Publication not found');
  if(sourceVersion>=expectedVersion)throw Error('Rollback requires an earlier version');
  const definition=copy(source.definition);validate(definition);enforcePublicationGuard(this.publicationGuard,definition);
  const version=latest.version+1;if(!Number.isSafeInteger(version))throw Error('Invalid version');
  const publication={version,definition},hash=definitionSha256(definition);this.published.push(publication);this.provenance.set(version,{version,kind:'rollback',previousVersion:expectedVersion,sourceVersion,definitionSha256:hash});return copy(publication);
 }
}

export { createPromotionPackage } from './promotion.js';
export type { PromotionPackage } from './promotion.js';

export { SqliteApplicationStore } from './sqlite.js';
export { SqliteRemoteRollout } from './remote-rollout.js';
export { RemoteRolloutPoller } from './remote-rollout-poller.js';
export type { RemoteRolloutPollerOptions, RemoteRolloutResult } from './remote-rollout-poller.js';
export { createControlPlane, createDataPlane, createProposalPlane, createDevelopmentPlanes } from './planes.js';
export type { DefinitionRepository, DevelopmentRunner, DevelopmentPreviewOptions, PromotionImportPolicy, PromotionExportSigner, DataPlaneHealthOptions, DataPlaneRequestObservation, DataPlaneTracingOptions, ControlPlaneTracingOptions } from './planes.js';

export { DevelopmentProposals } from './proposals.js';
export type { Proposal } from './proposals.js';
export { importOpenAPI, CapabilityRegistry } from './capabilities.js';
export type { CapabilityCandidate, InvocationContext, CapabilityAuditEvent, CapabilityAuditSink } from './capabilities.js';
export { createCapabilityServer } from './capability-server.js';
export type { CapabilityServerTracingOptions } from './capability-server.js';
export { createOpenAPIGetBinding } from './openapi-get.js';
export { PublishedDefinitionCache, CachedPublishedRepository } from './published-cache.js';
export type { CacheScope } from './published-cache.js';
export { checkExtensionCompatibility, createExtensionPublicationGuard, ExtensionRegistry } from './extensions.js';
export { registerExtensionComponent, registerDeclaredNativeExtensionComponent, createFlutterExtensionPlan, registerExtensionCapability, registerDeclaredExtensionCapability, createExtensionRuntime } from './extension-adapters.js';
export type { ExtensionRuntimeBindings, FlutterExtensionPlan } from './extension-adapters.js';
export type { ExtensionManifest, ExtensionHost, ExtensionRequirements, ExtensionBindings, ExtensionImplementation, ExtensionConfigRule, ExtensionConfigSchema, ExtensionConfigValue, ExtensionConfiguration } from './extensions.js';

export { SqliteDataProvider } from './data-provider.js';
export type { DataProvider, DataRecord, DataRecordPage, DataScope, DataMigration, MigrationPreview } from './data-provider.js';

export { SqliteStagedOperations } from './staged-operations.js';
export type { StagedOperation, StagedStatus } from './staged-operations.js';

export { registerDataCapability } from './data-capabilities.js';
export type { DataCapabilityOptions } from './data-capabilities.js';

export { registerStagedCapability } from './staged-capabilities.js';
export type { StagedCapabilityOptions } from './staged-capabilities.js';

export { SqliteOfflineQueue } from './offline-queue.js';
export type { OfflineStatus, OfflineOperation, OfflineQueueOptions, OfflineFailure } from './offline-queue.js';

export { OfflineSyncWorker } from './offline-worker.js';
export type { OfflineWorkerOptions } from './offline-worker.js';

export {createRecordFieldValidator} from './record-field-validator.js';
export type {RecordField,RecordFieldValidatorOptions} from './record-field-validator.js';

export {registerDataListCapability} from './data-list-capability.js';
export type {DataListCapabilityOptions} from './data-list-capability.js';

export {createRemotePromotionClient, RemotePromotionUncertainError} from './remote-promotion.js';
export type {RemotePromotionRequest, RemotePromotionDetails, RemotePromotionEvent, RemotePromotionOptions} from './remote-promotion.js';

export {createRecordJsonSchemaValidator} from './record-json-schema.js';

export {signPromotionPackage,createSignedPromotionVerifier} from './signed-promotion.js';
export type {SignedPromotionPackage,PromotionSigningKey,PromotionSignatureEvidence,VerifiedPromotion} from './signed-promotion.js';

export {createJwtCapabilityAuthenticator} from './jwt-capability-auth.js';
export type {JwtCapabilityActor,JwtCapabilityAuthOptions} from './jwt-capability-auth.js';

export {SqliteJwtRevocations} from './jwt-revocations.js';
export {PostgresJwtRevocations} from './postgres-jwt-revocations.js';
export type {PostgresJwtRevocationsOptions,PostgresJwtRevocationQuery} from './postgres-jwt-revocations.js';

export {JwtJwksManager} from './jwt-jwks-manager.js';
export type {JwtJwksManagerOptions} from './jwt-jwks-manager.js';
export {discoverOidcJwks,createOidcJwtJwksManager} from './oidc-discovery.js';
export type {OidcDiscoveryOptions,OidcJwtJwksManagerOptions} from './oidc-discovery.js';
export {SqliteCapabilityAudit} from './capability-audit.js';
export {PostgresCapabilityAudit} from './postgres-capability-audit.js';
export type {PostgresCapabilityAuditOptions} from './postgres-capability-audit.js';
export {PostgresAuthenticationFailureAudit} from './postgres-auth-failure-audit.js';
export type {AuthenticationFailureEvent,StoredAuthenticationFailure,PostgresAuthenticationFailureAuditOptions} from './postgres-auth-failure-audit.js';
export type {StoredCapabilityAuditEvent} from './capability-audit.js';
export {createRemoteControlConnector,RemoteControlImportUncertainError} from './remote-control-connector.js';
export type {RemoteControlConnectorOptions,RemoteControlImportRequest,RemoteControlImportDetails,RemoteControlImportEvent,RemoteControlDiscoveryDetails,RemoteControlDiscoveryEvent} from './remote-control-connector.js';
export {DataPlaneRequestMetrics} from './data-plane-metrics.js';
export {createMetricsServer} from './metrics-server.js';
export type {MetricsServerOptions} from './metrics-server.js';
