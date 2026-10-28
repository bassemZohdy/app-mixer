import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { ApplicationDefinition, Component, Page, Patch } from './index.js';
import { DevelopmentProposals } from './proposals.js';

export interface DefinitionRepository {
  getDraft(): ApplicationDefinition;
  apply(revision: number, patches: Patch[]): ApplicationDefinition;
  publish(revision: number): { version: number; definition: ApplicationDefinition };
  getPublished(version?: number): { version: number; definition: ApplicationDefinition } | undefined;
}

class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const exact = (obj: Record<string, unknown>, keys: string[]) => Object.keys(obj).every(key => keys.includes(key));
const string = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 1024;
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
function component(value: unknown): value is Component {
  if (!record(value) || !exact(value, ['id', 'type', 'props']) || !string(value.id) ||
      !['Text','Card','Table','Input'].includes(value.type as string)) return false;
  if (value.props === undefined) return true;
  return record(value.props) && Object.keys(value.props).length <= 100 &&
    Object.entries(value.props).every(([key, prop]) => string(key) &&
      (typeof prop === 'boolean' || (typeof prop === 'number' && Number.isFinite(prop)) ||
       (typeof prop === 'string' && prop.length <= 10000)));
}
function page(value: unknown): value is Page {
  return record(value) && exact(value, ['id','title','route','components']) &&
    string(value.id) && string(value.title) && string(value.route) &&
    Array.isArray(value.components) && value.components.length <= 500 && value.components.every(component);
}
export function isValidPatch(value: unknown): value is Patch {
  if (!record(value)) return false;
  if (value.op === 'addPage') return exact(value, ['op','page']) && page(value.page);
  if (value.op === 'setPageTitle') return exact(value, ['op','pageId','title']) && string(value.pageId) && string(value.title);
  if (value.op === 'addComponent') return exact(value, ['op','pageId','component']) && string(value.pageId) && component(value.component);
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
      else if (error instanceof Error && ['Revision conflict','Proposal is not pending'].includes(error.message)) respond(res, 409, {error:error.message});
      else if (error instanceof Error && error.message === 'Proposal not found') respond(res, 404, {error:error.message});
      else if (error instanceof Error && error.message === 'Proposal limit reached') respond(res, 429, {error:error.message});
      else if (error instanceof Error && ['Duplicate or invalid page','Invalid component','Unknown page','Invalid manifest','Unknown patch operation','Invalid proposal'].includes(error.message)) respond(res, 400, {error:error.message});
      else respond(res, 500, {error:'Internal server error'});
    });
  });
}
/** Local-development control plane. Bind to loopback and protect its token. */
export function createControlPlane(repository: DefinitionRepository, token: string, proposals?: DevelopmentProposals): Server {
  if (typeof token !== 'string' || token.length < 32 || /[\r\n]/.test(token)) throw Error('Control token must contain at least 32 characters');
  return server(async (req, res) => {
    if (!authorized(req, token)) { respond(res, 401, {error:'Unauthorized'}); return; }
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
    if (req.method === 'POST' && req.url === '/publish') {
      const input = await body(req);
      if (!record(input) || !exact(input, ['expectedRevision']) || !revision(input.expectedRevision)) throw new RequestError(400, 'Invalid publish request');
      respond(res, 201, repository.publish(input.expectedRevision)); return;
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
export function createDevelopmentPlanes(repository: DefinitionRepository, developerToken: string, agentToken: string) {
  if (developerToken === agentToken) throw Error('Developer and agent tokens must differ');
  const proposals = new DevelopmentProposals(repository);
  return {control:createControlPlane(repository,developerToken,proposals), proposal:createProposalPlane(proposals,agentToken)};
}
