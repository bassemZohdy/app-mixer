import type {ApplicationDefinition} from './index.js';
import {checkPromotionPackage,createPromotionPackage,validEnvironment,type PromotionPackage} from './promotion.js';
import {checkPromotionEvidence,type VerifiedPromotion,type SignedPromotionPackage} from './signed-promotion.js';
import type {RemotePromotionFloorAnchor} from './remote-control-connector.js';

type Published={version:number;definition:ApplicationDefinition};
type Actor={tenantId:string;principalId:string};
/** A signed promotion carried from a source to a disconnected target on removable media or another one-way channel. */
export type DisconnectedPromotionDocument={formatVersion:1;kind:'app-mixer-disconnected-promotion';applicationId:string;sourceEnvironment:string;targetEnvironment:string;sourceVersion:number;expectedVersion:number;signed:SignedPromotionPackage};
export type DisconnectedImportDetails={actor:Actor;applicationId:string;sourceEnvironment:string;targetEnvironment:string;sourceVersion?:number;expectedVersion?:number;digest?:string};
export type DisconnectedImportEvent={phase:'attempt'|'denied'|'rejected'|'floor_rejected'|'source_verified'|'completed'|'uncertain';details:DisconnectedImportDetails};
export type DisconnectedPromotionRepository={promoteAdvancing(input:unknown,expectedVersion:number,targetEnvironment:string,evidence?:VerifiedPromotion['evidence']):Published|Promise<Published>;getPromotionFloor(sourceEnvironment:string,targetEnvironment:string):number|Promise<number>};
export type DisconnectedPromotionImporterOptions={sourceEnvironment:string;targetEnvironment:string;applicationId:string;repository:DisconnectedPromotionRepository;authorize:(details:DisconnectedImportDetails)=>boolean|Promise<boolean>;audit:(event:DisconnectedImportEvent)=>void|Promise<void>;verifyWithEvidence:(input:unknown,targetEnvironment:string,applicationId:string,expectedVersion:number)=>VerifiedPromotion;promotionFloorAnchor?:RemotePromotionFloorAnchor};
const text=(value:unknown,max=256):value is string=>typeof value==='string'&&value.trim().length>0&&value.length<=max&&!/[\x00-\x1f\x7f]/.test(value);
const version=(value:unknown,min:number):value is number=>Number.isSafeInteger(value)&&Number(value)>=min&&Number(value)<Number.MAX_SAFE_INTEGER;
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);

/**
 * Source side: wrap one published version, signed for the target environment and bound to the target version it
 * must follow, into a document for transfer. `sign` is the host's authorized signer (signPromotionPackage with the
 * expected version). The host authorizes the export.
 */
export function exportDisconnectedPromotion(source:{getPublished(version?:number):Published|undefined},options:{applicationId:string;sourceEnvironment:string;targetEnvironment:string;sourceVersion:number;expectedVersion:number;sign:(pkg:PromotionPackage,targetEnvironment:string,expectedVersion:number)=>SignedPromotionPackage}):DisconnectedPromotionDocument{
 if(!options||!text(options.applicationId)||!validEnvironment(options.sourceEnvironment)||!validEnvironment(options.targetEnvironment)||options.sourceEnvironment===options.targetEnvironment||!version(options.sourceVersion,1)||!version(options.expectedVersion,0)||typeof options.sign!=='function')throw Error('Invalid disconnected promotion export');
 const published=source.getPublished(options.sourceVersion);if(!published||published.version!==options.sourceVersion||published.definition.id!==options.applicationId)throw Error('Source version unavailable');
 const signed=options.sign(createPromotionPackage(options.sourceEnvironment,{version:published.version,definition:published.definition}),options.targetEnvironment,options.expectedVersion);
 return {formatVersion:1,kind:'app-mixer-disconnected-promotion',applicationId:options.applicationId,sourceEnvironment:options.sourceEnvironment,targetEnvironment:options.targetEnvironment,sourceVersion:options.sourceVersion,expectedVersion:options.expectedVersion,signed:structuredClone(signed)};
}

/**
 * Target side, with no connection to the source: verify a carried document's signature, environment, application
 * and version binding, require the source version to advance past every earlier promotion (so a replayed or older
 * document is refused), and promote it atomically with its signature evidence.
 */
export function createDisconnectedPromotionImporter(options:DisconnectedPromotionImporterOptions){
 if(!options||!text(options.applicationId)||!validEnvironment(options.sourceEnvironment)||!validEnvironment(options.targetEnvironment)||options.sourceEnvironment===options.targetEnvironment||!options.repository||typeof options.repository.promoteAdvancing!=='function'||typeof options.repository.getPromotionFloor!=='function'||typeof options.authorize!=='function'||typeof options.audit!=='function'||typeof options.verifyWithEvidence!=='function'||(options.promotionFloorAnchor!==undefined&&(!options.promotionFloorAnchor||typeof options.promotionFloorAnchor.read!=='function'||typeof options.promotionFloorAnchor.advance!=='function')))throw Error('Invalid disconnected promotion configuration');
 const {applicationId,sourceEnvironment,targetEnvironment,repository,authorize,audit,verifyWithEvidence}=options,anchor=options.promotionFloorAnchor;
 return {async importDocument(input:{actor:Actor;document:unknown}):Promise<Published>{
  if(!input||!input.actor||!text(input.actor.tenantId)||!text(input.actor.principalId))throw Error('Invalid disconnected promotion import');
  const details:DisconnectedImportDetails={actor:{tenantId:input.actor.tenantId,principalId:input.actor.principalId},applicationId,sourceEnvironment,targetEnvironment};
  const emit=async(phase:DisconnectedImportEvent['phase'])=>audit({phase,details:structuredClone(details)});
  const reject=async(phase:'rejected'|'floor_rejected',message:string):Promise<never>=>{await emit(phase);throw Error(message);};
  await emit('attempt');
  const permit=async()=>{let allowed=false;try{allowed=await authorize(structuredClone(details))===true;}catch{}if(!allowed){await emit('denied');throw Error('Disconnected promotion denied');}};
  await permit();
  let document=input.document;
  if(typeof document==='string'){if(document.length>2*1024*1024)return reject('rejected','Invalid disconnected promotion document');try{document=JSON.parse(document) as unknown;}catch{return reject('rejected','Invalid disconnected promotion document');}}
  if(!object(document)||Object.keys(document).sort().join(',')!=='applicationId,expectedVersion,formatVersion,kind,signed,sourceEnvironment,sourceVersion,targetEnvironment'||document.formatVersion!==1||document.kind!=='app-mixer-disconnected-promotion'||document.applicationId!==applicationId||document.sourceEnvironment!==sourceEnvironment||document.targetEnvironment!==targetEnvironment||!version(document.sourceVersion,1)||!version(document.expectedVersion,0))return reject('rejected','Invalid disconnected promotion document');
  details.sourceVersion=document.sourceVersion;details.expectedVersion=document.expectedVersion;
  // A target floor below the host-held floor means the target database was restored or replaced.
  let local:unknown;try{local=await repository.getPromotionFloor(sourceEnvironment,targetEnvironment);}catch{return reject('floor_rejected','Promotion floor unavailable');}
  if(!Number.isSafeInteger(local)||(local as number)<0)return reject('floor_rejected','Invalid promotion floor');
  if(anchor){
   let floor:unknown;try{floor=await anchor.read();}catch{return reject('floor_rejected','Promotion floor unavailable');}
   if(!Number.isSafeInteger(floor)||(floor as number)<0)return reject('floor_rejected','Invalid promotion floor');
   if((local as number)<(floor as number))return reject('floor_rejected','Promotion floor rollback detected');
  }
  if(document.sourceVersion<=(local as number))return reject('floor_rejected','Source version is not newer than the promotion floor');
  let pkg:PromotionPackage,evidence:VerifiedPromotion['evidence'];
  try{const verified=verifyWithEvidence(document.signed,targetEnvironment,applicationId,document.expectedVersion);pkg=checkPromotionPackage(verified.package,targetEnvironment,applicationId);evidence=checkPromotionEvidence(pkg,targetEnvironment,verified.evidence,document.expectedVersion);if(evidence.expectedVersion!==document.expectedVersion||pkg.sourceEnvironment!==sourceEnvironment||pkg.sourceVersion!==document.sourceVersion)throw Error('Unexpected source');}
  catch{return reject('rejected','Disconnected promotion verification failed');}
  details.digest=pkg.digest;await emit('source_verified');await permit();
  let result:Published;
  try{result=await repository.promoteAdvancing(pkg,document.expectedVersion,targetEnvironment,evidence);if(!result||result.version!==document.expectedVersion+1||createPromotionPackage(sourceEnvironment,{version:document.sourceVersion,definition:result.definition}).digest!==pkg.digest)throw Error('Unexpected local publication');}
  catch(error){
   // A stale expected version is a definite refusal: nothing was written. Anything else may have been.
   if(error instanceof Error&&/version conflict|Expected version|not newer|advanc/i.test(error.message))return reject('rejected','Target version does not match the document: '+error.message);
   try{await emit('uncertain');}catch{}throw Error('Disconnected promotion outcome is uncertain; inspect publication and provenance before retrying');
  }
  await emit('completed');if(anchor)try{await anchor.advance(document.sourceVersion);}catch{}
  return result;
 }};
}
