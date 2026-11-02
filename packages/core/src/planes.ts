import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from 'node:http';
import {createServer as createHttpsServer,type Server as HttpsServer,type ServerOptions as HttpsOptions} from 'node:https';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ApplicationDefinition, Component, Page, Patch, PublicationProvenance } from './index.js';
import { isValidExtensionReferences, isValidExtensionOperations } from './index.js';
import {createPromotionPackage,validEnvironment,type PromotionPackage} from './promotion.js';
import type {PromotionSignatureEvidence,VerifiedPromotion,SignedPromotionPackage} from './signed-promotion.js';
import { DevelopmentProposals } from './proposals.js';
import { DEVELOPMENT_UI } from './development-ui.js';
import { RECORD_EDITOR_PREVIEW } from './data-editor-preview.js';
import { STAGED_EDITOR_PREVIEW } from './staged-editor-preview.js';
import {traceHttp,type HttpServerTracingOptions} from './http-tracing.js';
import {createBoundedOperation} from './bounded-operation.js';

export interface DefinitionRepository {
  getDraft(): ApplicationDefinition;
  migrateDraft?(expectedRevision:number,targetVersion:number):ApplicationDefinition;
  apply(revision: number, patches: Patch[]): ApplicationDefinition;
  publish(revision: number): { version: number; definition: ApplicationDefinition };
  promote?(input:unknown,expectedVersion:number,targetEnvironment:string): { version: number; definition: ApplicationDefinition };
  promoteVerified?(input:unknown,expectedVersion:number,targetEnvironment:string,evidence:PromotionSignatureEvidence): { version: number; definition: ApplicationDefinition };
  promoteAdvancing?(input:unknown,expectedVersion:number,targetEnvironment:string,evidence?:PromotionSignatureEvidence): { version: number; definition: ApplicationDefinition };
  getPublicationProvenance?(version:number): PublicationProvenance | undefined;
  rollback?(sourceVersion: number, expectedVersion: number): { version: number; definition: ApplicationDefinition };
  getPublished(version?: number): { version: number; definition: ApplicationDefinition } | undefined;
}

class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const exact = (obj: Record<string, unknown>, keys: string[]) => Object.keys(obj).every(key => keys.includes(key));
const string = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1024;
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
function component(value: unknown): value is Component {
  if (!record(value) || !string(value.id)) return false;
  if (value.type === 'Extension') {
    if (!exact(value, ['id','type','props','extensionId','name']) || typeof value.extensionId !== 'string' || !/^[a-z][a-z0-9.-]{0,127}$/.test(value.extensionId) || typeof value.name !== 'string' || !/^[a-z][a-z0-9.-]{0,127}$/.test(value.name)) return false;
  } else if (!exact(value, ['id', 'type', 'props']) || !['Text','Card','Table','Input'].includes(value.type as string)) return false;
  if (value.props === undefined) return true;
  return record(value.props) && Object.keys(value.props).length <= 100 &&
    Object.entries(value.props).every(([key, prop]) => string(key) &&
      (typeof prop === 'boolean' || (typeof prop === 'number' && Number.isFinite(prop)) ||
       (typeof prop === 'string' && prop.length <= 10000)));
}
function page(value: unknown): value is Page {
  return record(value) && exact(value, ['id','title','route','components','description']) && (value.description===undefined||(typeof value.description==='string'&&value.description.length<=10000)) &&
    string(value.id) && string(value.title) && string(value.route) &&
    Array.isArray(value.components) && value.components.length <= 500 && value.components.every(component);
}
export function isValidPatch(value: unknown): value is Patch {
  if (!record(value)) return false;
  if (value.op === 'addPage') return exact(value, ['op','page']) && page(value.page);
  if (value.op === 'setPageTitle') return exact(value, ['op','pageId','title']) && string(value.pageId) && string(value.title);
  if (value.op === 'setPageDescription') return exact(value,['op','pageId','description']) && string(value.pageId) && typeof value.description === 'string' && value.description.length <= 10000;
  if (value.op === 'addComponent') return exact(value, ['op','pageId','component']) && string(value.pageId) && component(value.component);
  if (value.op === 'setExtensions') return exact(value, ['op','extensions']) && isValidExtensionReferences(value.extensions);
  if (value.op === 'setExtensionOperations') return exact(value, ['op','operations']) && isValidExtensionOperations(value.operations);
  return false;
}
async function body(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new RequestError(415, 'Expected application/json');
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const part = Buffer.from(chunk);
    length += part.length;
    if (length > 1024 * 1024) throw new RequestError(413, 'Request too large');
    chunks.push(part);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new RequestError(400, 'Invalid JSON'); }
}
function respond(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {'content-type':'application/json; charset=utf-8', 'cache-control':'no-store', 'x-content-type-options':'nosniff'});
  res.end(JSON.stringify(value));
}
function authorized(req: IncomingMessage, token: string): boolean {
  const supplied = Buffer.from(req.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
function listener(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,dispatch?:(req:IncomingMessage,res:ServerResponse,run:()=>void)=>void):RequestListener {
  return (req, res) => {
    const run=()=>handler(req, res).catch(error => {
      if (res.headersSent || res.destroyed) return;
      if (error instanceof RequestError) respond(res, error.status, {error: error.message});
      else if (error instanceof Error && ['Revision conflict','Unsupported schema migration','Migration would lose page descriptions','Proposal is not pending','Extension compatibility failed','Publication version conflict','Rollback requires an earlier version'].includes(error.message)) respond(res, 409, {error:error.message});
      else if (error instanceof Error && ['Proposal not found','Publication not found'].includes(error.message)) respond(res, 404, {error:error.message});
      else if (error instanceof Error && error.message === 'Proposal limit reached') respond(res, 429, {error:error.message});
      else if (error instanceof Error && ['Duplicate or invalid page','Invalid component','Unknown page','Invalid manifest','Unknown patch operation','Invalid proposal','Invalid promotion package','Invalid page description','Invalid migration request'].includes(error.message)) respond(res, 400, {error:error.message});
      else respond(res, 500, {error:'Internal server error'});
    });
    if(dispatch)dispatch(req,res,run);else run();
  };
}
function server(handler:(req:IncomingMessage,res:ServerResponse)=>Promise<void>,dispatch?:(req:IncomingMessage,res:ServerResponse,run:()=>void)=>void):Server{return createServer(listener(handler,dispatch));}
/** Local-development control plane. Bind to loopback and protect its token. */
export type DevelopmentRunner = (instruction:string, draft:ApplicationDefinition) => Promise<{id:string}>;
/** Trusted host-owned browser module source. It must not contain secrets. */
export type DevelopmentPreviewOptions = {extensionModule?: string};
export type PromotionImportPolicy = {verify:(input:unknown,targetEnvironment:string,applicationId:string,expectedVersion:number)=>PromotionPackage;verifyWithEvidence?:never}|{verify?:never;verifyWithEvidence:(input:unknown,targetEnvironment:string,applicationId:string,expectedVersion:number)=>VerifiedPromotion};
export type PromotionExportSigner = (pkg:PromotionPackage,targetEnvironment:string,expectedVersion:number)=>SignedPromotionPackage|Promise<SignedPromotionPackage>;
export function createControlPlane(repository: DefinitionRepository, token: string, proposals?: DevelopmentProposals, develop?: DevelopmentRunner, preview?: DevelopmentPreviewOptions, promotionPolicy?: PromotionImportPolicy, exportSigner?:PromotionExportSigner, tracing?:ControlPlaneTracingOptions): Server {
  if (typeof token !== 'string' || token.length < 32 || /[\r\n]/.test(token)) throw Error('Control token must contain at least 32 characters');
  if (preview?.extensionModule !== undefined && (typeof preview.extensionModule !== 'string' || preview.extensionModule.length > 1024 * 1024)) throw Error('Invalid preview extension module');
  if(promotionPolicy!==undefined&&(!promotionPolicy||(typeof promotionPolicy.verify==='function')===(typeof promotionPolicy.verifyWithEvidence==='function')))throw Error('Invalid promotion policy');
  if(exportSigner!==undefined&&typeof exportSigner!=='function')throw Error('Invalid promotion export signer');
  if(tracing!==undefined&&(!tracing||!tracing.tracer||typeof tracing.tracer.startSpan!=='function'||(tracing.trustRemoteParent!==undefined&&typeof tracing.trustRemoteParent!=='boolean')))throw Error('Invalid control plane tracing configuration');
  const verifyPromotion=promotionPolicy?.verify,verifyWithEvidence=promotionPolicy?.verifyWithEvidence;
  const extensionModule=preview?.extensionModule ?? 'export const installedExtensions = [];';
  return server(async (req, res) => {
    if (proposals && req.method === 'GET' && (req.url === '/development' || req.url === '/development/renderer.mjs' || req.url === '/development/extensions.mjs' || req.url === '/development/data-editor.mjs' || req.url === '/development/staged-editor.mjs')) {
      const host=req.headers.host, port=req.socket.localPort;
      if (host !== '127.0.0.1:'+port && host !== 'localhost:'+port) { respond(res,400,{error:'Invalid host'}); return; }
      if (req.url === '/development/renderer.mjs') {
        const source=await readFile(new URL(import.meta.resolve('@app-mixer/web')));
        res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}); res.end(source); return;
      }
      if (req.url === '/development/staged-editor.mjs') {
        res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}); res.end(STAGED_EDITOR_PREVIEW); return;
      }
      if (req.url === '/development/data-editor.mjs') {
        res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}); res.end(RECORD_EDITOR_PREVIEW); return;
      }
      if (req.url === '/development/extensions.mjs') {
        res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}); res.end(extensionModule); return;
      }
      res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'"});
      res.end(DEVELOPMENT_UI); return;
    }
    if (!authorized(req, token)) { respond(res, 401, {error:'Unauthorized'}); return; }
    if (proposals && develop && req.method === 'POST' && req.url === '/development/propose') {
      const input=await body(req);
      if (!record(input) || !exact(input,['instruction']) || !string(input.instruction) || input.instruction.length>1000) throw new RequestError(400,'Invalid development request');
      const result=await develop(input.instruction,repository.getDraft());
      const proposal=proposals.get(result.id);
      if (!proposal || proposal.status !== 'pending') throw Error('Proposal not found');
      respond(res,201,proposal); return;
    }
    const proposalRoute = /^\/proposals\/([0-9a-f-]{36})(?:\/(approve|reject))?$/.exec(req.url ?? '');
    if (proposals && proposalRoute) {
      const [,proposalId,action] = proposalRoute;
      if (req.method === 'GET' && !action) {
        const proposal=proposals.get(proposalId);
        if (!proposal) throw Error('Proposal not found');
        respond(res,200,proposal); return;
      }
      if (req.method === 'POST' && action === 'approve') { respond(res,200,proposals.approve(proposalId)); return; }
      if (req.method === 'POST' && action === 'reject') { respond(res,200,proposals.reject(proposalId)); return; }
    }
    if (req.method === 'GET' && (req.url === '/draft' || req.url === '/preview')) {
      respond(res, 200, repository.getDraft()); return;
    }
    if (req.method === 'POST' && req.url === '/draft/patches') {
      const input = await body(req);
      if (!record(input) || !exact(input, ['baseRevision','patches']) || !revision(input.baseRevision) ||
          !Array.isArray(input.patches) || input.patches.length > 100 || !input.patches.every(isValidPatch)) throw new RequestError(400, 'Invalid patch request');
      respond(res, 200, repository.apply(input.baseRevision, input.patches)); return;
    }
    if (req.method === 'POST' && req.url === '/draft/migrate') {
      const input=await body(req);
      if(!record(input)||!exact(input,['expectedRevision','targetVersion'])||!revision(input.expectedRevision)||!revision(input.targetVersion)||input.targetVersion<1)throw new RequestError(400,'Invalid migration request');
      if(!repository.migrateDraft)throw new RequestError(501,'Migration unavailable');
      respond(res,200,repository.migrateDraft(input.expectedRevision,input.targetVersion));return;
    }
    if (req.method === 'POST' && req.url === '/publish') {
      const input = await body(req);
      if (!record(input) || !exact(input, ['expectedRevision']) || !revision(input.expectedRevision)) throw new RequestError(400, 'Invalid publish request');
      respond(res, 201, repository.publish(input.expectedRevision)); return;
    }
    if (req.method === 'GET' && req.url === '/publications/latest') {
      const publication=repository.getPublished();if(!publication)throw Error('Publication not found');
      respond(res,200,{applicationId:publication.definition.id,version:publication.version});return;
    }
    if (req.method === 'POST' && req.url === '/promotion/export') {
      const input=await body(req);
      if(!record(input)||!exact(input,['sourceEnvironment','version'])||!validEnvironment(input.sourceEnvironment)||!revision(input.version)||input.version<1)throw new RequestError(400,'Invalid promotion request');
      const publication=repository.getPublished(input.version);if(!publication)throw Error('Publication not found');
      respond(res,200,createPromotionPackage(input.sourceEnvironment,publication));return;
    }
    if (req.method === 'POST' && req.url === '/promotion/export-signed') {
      if(!exportSigner)throw new RequestError(501,'Signed export unavailable');
      const input=await body(req);
      if(!record(input)||!exact(input,['sourceEnvironment','version','targetEnvironment','expectedVersion'])||!validEnvironment(input.sourceEnvironment)||!revision(input.version)||input.version<1||!validEnvironment(input.targetEnvironment)||input.sourceEnvironment===input.targetEnvironment||!revision(input.expectedVersion)||input.expectedVersion>=Number.MAX_SAFE_INTEGER)throw new RequestError(400,'Invalid promotion request');
      const publication=repository.getPublished(input.version);if(!publication)throw Error('Publication not found');
      const pkg=createPromotionPackage(input.sourceEnvironment,publication),signed=await exportSigner(structuredClone(pkg),input.targetEnvironment,input.expectedVersion);
      if(!signed||(signed.formatVersion!==2&&signed.formatVersion!==3)||signed.expectedVersion!==input.expectedVersion||signed.targetEnvironment!==input.targetEnvironment||typeof signed.keyId!=='string'||typeof signed.signature!=='string'||createPromotionPackage(input.sourceEnvironment,{version:input.version,definition:signed.package?.definition}).digest!==pkg.digest||signed.package?.digest!==pkg.digest||signed.package?.sourceEnvironment!==input.sourceEnvironment||signed.package?.sourceVersion!==input.version)throw Error('Invalid signed export');
      respond(res,200,signed);return;
    }
    if (req.method === 'POST' && req.url === '/promotion/import') {
      const input=await body(req);
      if(!record(input)||!exact(input,['package','targetEnvironment','expectedVersion'])||!validEnvironment(input.targetEnvironment)||!revision(input.expectedVersion))throw new RequestError(400,'Invalid promotion request');
      if(!repository.promote)throw new RequestError(501,'Promotion unavailable');
      let pkg=input.package;if(verifyWithEvidence){if(!repository.promoteVerified)throw new RequestError(501,'Verified promotion unavailable');let verified:VerifiedPromotion;try{verified=verifyWithEvidence(pkg,input.targetEnvironment,repository.getDraft().id,input.expectedVersion);}catch{throw new RequestError(403,'Promotion signature invalid');}respond(res,201,repository.promoteVerified(verified.package,input.expectedVersion,input.targetEnvironment,verified.evidence));return;}if(verifyPromotion){try{pkg=verifyPromotion(pkg,input.targetEnvironment,repository.getDraft().id,input.expectedVersion);}catch{throw new RequestError(403,'Promotion signature invalid');}}
      respond(res,201,repository.promote(pkg,input.expectedVersion,input.targetEnvironment));return;
    }
    const provenanceRoute = /^\/publications\/([1-9]\d*)\/provenance$/.exec(req.url ?? '');
    if (req.method === 'GET' && provenanceRoute) {
      const version=Number(provenanceRoute[1]);
      if (!Number.isSafeInteger(version)) throw new RequestError(400, 'Invalid version');
      if (!repository.getPublicationProvenance) throw new RequestError(501, 'Publication provenance unavailable');
      const provenance=repository.getPublicationProvenance(version);
      if (!provenance) throw Error('Publication not found');
      respond(res,200,provenance); return;
    }
    if (req.method === 'POST' && req.url === '/rollback') {
      const input = await body(req);
      if (!record(input) || !exact(input, ['sourceVersion','expectedVersion']) || !revision(input.sourceVersion) || input.sourceVersion < 1 || !revision(input.expectedVersion) || input.expectedVersion < 1) throw new RequestError(400, 'Invalid rollback request');
      if (!repository.rollback) throw new RequestError(501, 'Rollback unavailable');
      respond(res, 201, repository.rollback(input.sourceVersion, input.expectedVersion)); return;
    }
    respond(res, 404, {error:'Not found'});
  },tracing?traceHttp({tracer:tracing.tracer,trustRemoteParent:tracing.trustRemoteParent},req=>{const method=req.method==='GET'?'GET':req.method==='POST'?'POST':'_OTHER';const path=(method==='GET'&&req.url==='/publications/latest')||(method==='POST'&&(req.url==='/promotion/export'||req.url==='/promotion/export-signed'))?req.url:undefined;return {method,path};}):undefined);
}
export type DataPlaneHealthOptions={timeoutMs:number;check?:(signal:AbortSignal)=>boolean|Promise<boolean>};
export type DataPlaneRequestObservation={route:'application'|'version'|'live'|'ready'|'other';outcome:'completed'|'aborted';statusClass:'2xx'|'3xx'|'4xx'|'5xx'|'other'|'none';durationMs:number};
export type DataPlaneTracingOptions=HttpServerTracingOptions;
export type DataPlaneServer=Server & {beginDrain:()=>void};
export type DataPlaneHttpsServer=HttpsServer & {beginDrain:()=>void};
export type DataPlaneTlsOptions={cert:string|Buffer;key:string|Buffer;clientCa?:string|Buffer};
export type DataPlanePublicationAuthorization=(request:IncomingMessage,version:number|undefined,signal:AbortSignal)=>boolean|Promise<boolean>;
export type ControlPlaneTracingOptions=DataPlaneTracingOptions;
export type DataPlaneOptions={health?:DataPlaneHealthOptions;observe?:(event:DataPlaneRequestObservation)=>void;tracing?:DataPlaneTracingOptions;authorizePublication?:DataPlanePublicationAuthorization;publicationAuthorizationLimits?:{timeoutMs:number;maxPending:number};publicationReadLimits?:{timeoutMs:number;maxPending:number}};
export type DataPlanePublicationRepository={getPublished:(version?:number)=>{version:number;definition:ApplicationDefinition}|undefined|Promise<{version:number;definition:ApplicationDefinition}|undefined>;getPublishedWithSignal?:(version:number|undefined,signal:AbortSignal)=>{version:number;definition:ApplicationDefinition}|undefined|Promise<{version:number;definition:ApplicationDefinition}|undefined>};
function createDataPlaneInternal(repository:DataPlanePublicationRepository,options?:DataPlaneOptions,tls?:HttpsOptions):DataPlaneServer|DataPlaneHttpsServer {
  const health=options?.health,observe=options?.observe;if(health!==undefined&&(!health||!Number.isSafeInteger(health.timeoutMs)||health.timeoutMs<100||health.timeoutMs>30000||(health.check!==undefined&&typeof health.check!=='function')))throw Error('Invalid data plane health configuration');if(observe!==undefined&&typeof observe!=='function')throw Error('Invalid data plane observer');const authorizePublication=options?.authorizePublication;if(authorizePublication!==undefined&&typeof authorizePublication!=='function')throw Error('Invalid publication authorization');const authorizationLimits=options?.publicationAuthorizationLimits;if(authorizationLimits!==undefined&&(!authorizationLimits||typeof authorizationLimits!=='object'||Array.isArray(authorizationLimits)||Object.keys(authorizationLimits).some(key=>!['timeoutMs','maxPending'].includes(key))||!authorizePublication||!Number.isSafeInteger(authorizationLimits.timeoutMs)||!Number.isSafeInteger(authorizationLimits.maxPending)))throw Error('Invalid publication authorization limits');const runAuthorization=createBoundedOperation(authorizationLimits?.timeoutMs,authorizationLimits?.maxPending,'Invalid publication authorization limits','Publication authorization unavailable');
  const readLimits=options?.publicationReadLimits;if(!repository||typeof repository.getPublished!=='function'||(repository.getPublishedWithSignal!==undefined&&typeof repository.getPublishedWithSignal!=='function'))throw Error('Invalid publication repository');if(readLimits!==undefined&&(!readLimits||typeof readLimits!=='object'||Array.isArray(readLimits)||Object.keys(readLimits).some(key=>!['timeoutMs','maxPending'].includes(key))||!Number.isSafeInteger(readLimits.timeoutMs)||!Number.isSafeInteger(readLimits.maxPending)))throw Error('Invalid publication read limits');const runRead=createBoundedOperation(readLimits?.timeoutMs,readLimits?.maxPending,'Invalid publication read limits','Publication read unavailable'),basicRead=repository.getPublished.bind(repository),loadPublication=repository.getPublishedWithSignal?repository.getPublishedWithSignal.bind(repository):(version:number|undefined,_signal:AbortSignal)=>basicRead(version);
  const tracing=options?.tracing;if(tracing!==undefined&&(!tracing||!tracing.tracer||typeof tracing.tracer.startSpan!=='function'||(tracing.trustRemoteParent!==undefined&&typeof tracing.trustRemoteParent!=='boolean')))throw Error('Invalid data plane tracing configuration');
  const check=health?.check,timeout=health?.timeoutMs;let pending:Promise<boolean>|undefined,controller:AbortController|undefined,checkTimer:ReturnType<typeof setTimeout>|undefined,draining=false,finishDrain:()=>void;
  const drainSignal=new Promise<boolean>(resolve=>{finishDrain=()=>resolve(false);});
  const beginDrain=()=>{if(draining)return;draining=true;controller?.abort();if(checkTimer!==undefined)clearTimeout(checkTimer);finishDrain();};
  const readinessCheck=():Promise<boolean>=>{
    if(pending)return pending;
    const current=new AbortController();controller=current;let timer:ReturnType<typeof setTimeout>;
    const task=Promise.resolve().then(async()=>{if(current.signal.aborted||!await loadPublication(undefined,current.signal)||current.signal.aborted)return false;if(check&&await check(current.signal)!==true)return false;if(current.signal.aborted)return false;return !!await loadPublication(undefined,current.signal);}).then(value=>value===true,()=>false);
    const deadline=new Promise<boolean>(resolve=>{timer=setTimeout(()=>{current.abort();resolve(false);},timeout);checkTimer=timer;});
    const result=Promise.race([task,deadline]);pending=result;
    void task.finally(()=>{clearTimeout(timer);if(checkTimer===timer)checkTimer=undefined;if(controller===current)controller=undefined;if(pending===result)pending=undefined;});
    return result;
  };
  const factory=(handler:(req:IncomingMessage,res:ServerResponse)=>Promise<void>,dispatch?:(req:IncomingMessage,res:ServerResponse,run:()=>void)=>void)=>tls?createHttpsServer(tls,listener(handler,dispatch)):server(handler,dispatch);
  const instance=factory(async (req, res) => {
    if(observe){
      const started=performance.now(),route:DataPlaneRequestObservation['route']=req.method!=='GET'?'other':req.url==='/application'?'application':/^\/application\/versions\/[1-9]\d*$/.test(req.url??'')?'version':health&&req.url==='/health/live'?'live':health&&req.url==='/health/ready'?'ready':'other';let recorded=false;
      const record=(outcome:DataPlaneRequestObservation['outcome'])=>{if(recorded)return;recorded=true;const code=res.statusCode,statusClass:DataPlaneRequestObservation['statusClass']=outcome==='aborted'?'none':code>=200&&code<300?'2xx':code>=300&&code<400?'3xx':code>=400&&code<500?'4xx':code>=500&&code<600?'5xx':'other';try{const result:unknown=observe({route,outcome,statusClass,durationMs:Math.max(0,performance.now()-started)});if(result instanceof Promise)void result.catch(()=>{});}catch{}};
      res.once('finish',()=>record('completed'));res.once('close',()=>record('aborted'));
    }
    if(health&&req.method==='GET'&&req.url==='/health/live'){respond(res,200,{status:'live'});return;}
    if(health&&req.method==='GET'&&req.url==='/health/ready'){
      let ready=false;try{ready=!draining&&await Promise.race([readinessCheck(),drainSignal])&&!draining;}catch{}
      respond(res,ready?200:503,{status:ready?'ready':'unavailable'});return;
    }
    if (req.method !== 'GET' || (req.url !== '/application' && !/^\/application\/versions\/[1-9]\d*$/.test(req.url ?? ''))) {
      respond(res, 404, {error:'Not found'}); return;
    }
    const versionText = req.url === '/application' ? undefined : req.url!.split('/').at(-1);
    const version = versionText === undefined ? undefined : Number(versionText);
    if (version !== undefined && !Number.isSafeInteger(version)) throw new RequestError(400, 'Invalid version');
    if(authorizePublication){let allowed:boolean;const disconnected=new AbortController(),onClose=()=>disconnected.abort();res.once('close',onClose);try{allowed=await runAuthorization(async signal=>{const combined=AbortSignal.any([signal,disconnected.signal]);if(combined.aborted)return false;return await authorizePublication(req,version,combined)===true;});}catch{if(!res.destroyed)respond(res,503,{error:'Authorization unavailable'});return;}finally{res.off('close',onClose);}if(res.destroyed)return;if(!allowed){respond(res,403,{error:'Forbidden'});return;}}
    const disconnected=new AbortController(),onClose=()=>disconnected.abort();res.once('close',onClose);let published;
    try{published=await runRead(async signal=>{const combined=AbortSignal.any([signal,disconnected.signal]);if(combined.aborted)return undefined;return await loadPublication(version,combined);});}catch(error){if(res.destroyed)return;if(!readLimits)throw error;respond(res,503,{error:'Publication unavailable'});return;}finally{res.off('close',onClose);}
    if(res.destroyed)return;
    if (!published) { respond(res, 404, {error:'Publication not found'}); return; }
    const tag='"'+createHash('sha256').update(JSON.stringify(published)).digest('hex')+'"';
    const tags=(req.headers['if-none-match']??'').split(',').map(value=>value.trim().replace(/^W\//,''));
    if(tags.includes(tag)||tags.includes('*')){res.writeHead(304,{'etag':tag,'cache-control':'no-store'});res.end();return;}
    res.setHeader('etag',tag);
    respond(res, 200, published);
  },tracing?traceHttp({tracer:tracing.tracer,trustRemoteParent:tracing.trustRemoteParent},req=>{const method=req.method==='GET'?'GET':'_OTHER',path=method!=='GET'?undefined:req.url==='/application'?'/application':/^\/application\/versions\/[1-9]\d*$/.test(req.url??'')?'/application/versions/{version}':health&&req.url==='/health/live'?'/health/live':health&&req.url==='/health/ready'?'/health/ready':undefined;return {method,path};}):undefined);
  instance.on('close',beginDrain);return Object.assign(instance,{beginDrain});
}
/** Data plane exposes only immutable publications. It does not depend on the control plane. */
export function createDataPlane(repository:DataPlanePublicationRepository,options?:DataPlaneOptions):DataPlaneServer{return createDataPlaneInternal(repository,options) as DataPlaneServer;}
/** Direct TLS transport; client certificates are mandatory when clientCa is supplied. */
export function createDataPlaneHttps(repository:DataPlanePublicationRepository,tls:DataPlaneTlsOptions,options?:DataPlaneOptions):DataPlaneHttpsServer{
 const pem=(value:unknown):value is string|Buffer=>(typeof value==='string'&&value.trim().length>0)||(Buffer.isBuffer(value)&&value.length>0);
 if(!tls||typeof tls!=='object'||Array.isArray(tls)||Object.keys(tls).some(key=>!['cert','key','clientCa'].includes(key))||!pem(tls.cert)||!pem(tls.key)||(tls.clientCa!==undefined&&!pem(tls.clientCa)))throw Error('Invalid data plane TLS configuration');
 return createDataPlaneInternal(repository,options,{cert:tls.cert,key:tls.key,minVersion:'TLSv1.2',...(tls.clientCa!==undefined?{ca:tls.clientCa,requestCert:true,rejectUnauthorized:true}:{})}) as DataPlaneHttpsServer;
}

/** Proposal-only endpoint for an agent; it cannot apply, approve or publish. */
export function createProposalPlane(proposals: DevelopmentProposals, token: string): Server {
  if (typeof token !== 'string' || token.length < 32 || /[\r\n]/.test(token)) throw Error('Proposal token must contain at least 32 characters');
  return server(async (req,res) => {
    if (!authorized(req,token)) { respond(res,401,{error:'Unauthorized'}); return; }
    if (req.method !== 'POST' || req.url !== '/proposals') { respond(res,404,{error:'Not found'}); return; }
    const input=await body(req);
    if (!record(input) || !exact(input,['baseRevision','patches']) || !revision(input.baseRevision)) throw new RequestError(400,'Invalid proposal request');
    respond(res,201,proposals.propose(input.baseRevision,input.patches));
  });
}
/** Construct both local-development planes with distinct credentials. */
export function createDevelopmentPlanes(repository: DefinitionRepository, developerToken: string, agentToken: string, develop?: DevelopmentRunner, preview?: DevelopmentPreviewOptions, promotionPolicy?: PromotionImportPolicy) {
  if (developerToken === agentToken) throw Error('Developer and agent tokens must differ');
  const proposals = new DevelopmentProposals(repository);
  return {control:createControlPlane(repository,developerToken,proposals,develop,preview,promotionPolicy), proposal:createProposalPlane(proposals,agentToken)};
}
