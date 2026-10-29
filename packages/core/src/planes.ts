import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ApplicationDefinition, Component, Page, Patch, PublicationProvenance } from './index.js';
import { isValidExtensionReferences, isValidExtensionOperations } from './index.js';
import {createPromotionPackage,validEnvironment,type PromotionPackage} from './promotion.js';
import type {PromotionSignatureEvidence,VerifiedPromotion} from './signed-promotion.js';
import { DevelopmentProposals } from './proposals.js';
import { DEVELOPMENT_UI } from './development-ui.js';
import { RECORD_EDITOR_PREVIEW } from './data-editor-preview.js';
import { STAGED_EDITOR_PREVIEW } from './staged-editor-preview.js';

export interface DefinitionRepository {
  getDraft(): ApplicationDefinition;
  migrateDraft?(expectedRevision:number,targetVersion:number):ApplicationDefinition;
  apply(revision: number, patches: Patch[]): ApplicationDefinition;
  publish(revision: number): { version: number; definition: ApplicationDefinition };
  promote?(input:unknown,expectedVersion:number,targetEnvironment:string): { version: number; definition: ApplicationDefinition };
  promoteVerified?(input:unknown,expectedVersion:number,targetEnvironment:string,evidence:PromotionSignatureEvidence): { version: number; definition: ApplicationDefinition };
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
function server(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>): Server {
  return createServer((req, res) => {
    handler(req, res).catch(error => {
      if (res.headersSent || res.destroyed) return;
      if (error instanceof RequestError) respond(res, error.status, {error: error.message});
      else if (error instanceof Error && ['Revision conflict','Unsupported schema migration','Proposal is not pending','Extension compatibility failed','Publication version conflict','Rollback requires an earlier version'].includes(error.message)) respond(res, 409, {error:error.message});
      else if (error instanceof Error && ['Proposal not found','Publication not found'].includes(error.message)) respond(res, 404, {error:error.message});
      else if (error instanceof Error && error.message === 'Proposal limit reached') respond(res, 429, {error:error.message});
      else if (error instanceof Error && ['Duplicate or invalid page','Invalid component','Unknown page','Invalid manifest','Unknown patch operation','Invalid proposal','Invalid promotion package','Invalid page description','Invalid migration request'].includes(error.message)) respond(res, 400, {error:error.message});
      else respond(res, 500, {error:'Internal server error'});
    });
  });
}
/** Local-development control plane. Bind to loopback and protect its token. */
export type DevelopmentRunner = (instruction:string, draft:ApplicationDefinition) => Promise<{id:string}>;
/** Trusted host-owned browser module source. It must not contain secrets. */
export type DevelopmentPreviewOptions = {extensionModule?: string};
export type PromotionImportPolicy = {verify:(input:unknown,targetEnvironment:string,applicationId:string)=>PromotionPackage;verifyWithEvidence?:never}|{verify?:never;verifyWithEvidence:(input:unknown,targetEnvironment:string,applicationId:string)=>VerifiedPromotion};
export function createControlPlane(repository: DefinitionRepository, token: string, proposals?: DevelopmentProposals, develop?: DevelopmentRunner, preview?: DevelopmentPreviewOptions, promotionPolicy?: PromotionImportPolicy): Server {
  if (typeof token !== 'string' || token.length < 32 || /[\r\n]/.test(token)) throw Error('Control token must contain at least 32 characters');
  if (preview?.extensionModule !== undefined && (typeof preview.extensionModule !== 'string' || preview.extensionModule.length > 1024 * 1024)) throw Error('Invalid preview extension module');
  if(promotionPolicy!==undefined&&(!promotionPolicy||(typeof promotionPolicy.verify==='function')===(typeof promotionPolicy.verifyWithEvidence==='function')))throw Error('Invalid promotion policy');
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
    if (req.method === 'POST' && req.url === '/promotion/export') {
      const input=await body(req);
      if(!record(input)||!exact(input,['sourceEnvironment','version'])||!validEnvironment(input.sourceEnvironment)||!revision(input.version)||input.version<1)throw new RequestError(400,'Invalid promotion request');
      const publication=repository.getPublished(input.version);if(!publication)throw Error('Publication not found');
      respond(res,200,createPromotionPackage(input.sourceEnvironment,publication));return;
    }
    if (req.method === 'POST' && req.url === '/promotion/import') {
      const input=await body(req);
      if(!record(input)||!exact(input,['package','targetEnvironment','expectedVersion'])||!validEnvironment(input.targetEnvironment)||!revision(input.expectedVersion))throw new RequestError(400,'Invalid promotion request');
      if(!repository.promote)throw new RequestError(501,'Promotion unavailable');
      let pkg=input.package;if(verifyWithEvidence){if(!repository.promoteVerified)throw new RequestError(501,'Verified promotion unavailable');let verified:VerifiedPromotion;try{verified=verifyWithEvidence(pkg,input.targetEnvironment,repository.getDraft().id);}catch{throw new RequestError(403,'Promotion signature invalid');}respond(res,201,repository.promoteVerified(verified.package,input.expectedVersion,input.targetEnvironment,verified.evidence));return;}if(verifyPromotion){try{pkg=verifyPromotion(pkg,input.targetEnvironment,repository.getDraft().id);}catch{throw new RequestError(403,'Promotion signature invalid');}}
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
  });
}
/** Data plane exposes only immutable publications. It does not depend on the control plane. */
export function createDataPlane(repository: Pick<DefinitionRepository, 'getPublished'>): Server {
  return server(async (req, res) => {
    if (req.method !== 'GET' || (req.url !== '/application' && !/^\/application\/versions\/[1-9]\d*$/.test(req.url ?? ''))) {
      respond(res, 404, {error:'Not found'}); return;
    }
    const versionText = req.url === '/application' ? undefined : req.url!.split('/').at(-1);
    const version = versionText === undefined ? undefined : Number(versionText);
    if (version !== undefined && !Number.isSafeInteger(version)) throw new RequestError(400, 'Invalid version');
    const published = repository.getPublished(version);
    if (!published) { respond(res, 404, {error:'Publication not found'}); return; }
    const tag='"'+createHash('sha256').update(JSON.stringify(published)).digest('hex')+'"';
    const tags=(req.headers['if-none-match']??'').split(',').map(value=>value.trim().replace(/^W\//,''));
    if(tags.includes(tag)||tags.includes('*')){res.writeHead(304,{'etag':tag,'cache-control':'no-store'});res.end();return;}
    res.setHeader('etag',tag);
    respond(res, 200, published);
  });
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
