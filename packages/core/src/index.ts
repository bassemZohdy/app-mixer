export type Component = {id:string;type:"Text"|"Card"|"Table"|"Input";props?:Record<string,string|number|boolean>};
export type Page = {id:string;title:string;route:string;components:Component[]};
export type ApplicationDefinition = {id:string;schemaVersion:1;revision:number;pages:Page[]};
export type PublicationGuard = (draft:ApplicationDefinition) => true;
export function enforcePublicationGuard(guard:PublicationGuard | undefined, draft:ApplicationDefinition):void {
 if(!guard)return;
 const result:unknown=guard(structuredClone(draft));
 if(result instanceof Promise) result.catch(()=>{});
 if(result!==true)throw Error("Publication guard must synchronously return true");
}
export type Patch = {op:"addPage";page:Page}|{op:"setPageTitle";pageId:string;title:string}|{op:"addComponent";pageId:string;component:Component};
const copy = <T>(x:T):T => structuredClone(x);
export function validate(d:ApplicationDefinition):void {
 if(!d.id.trim()||d.schemaVersion!==1||!Number.isSafeInteger(d.revision)||d.revision<0)throw Error("Invalid manifest");
 const ids=new Set<string>(),routes=new Set<string>();
 for(const p of d.pages){if(!p.id||!p.title||!p.route.startsWith("/")||ids.has(p.id)||routes.has(p.route))throw Error("Duplicate or invalid page");ids.add(p.id);routes.add(p.route);
 const components=new Set<string>();for(const c of p.components){if(!c.id||components.has(c.id)||!["Text","Card","Table","Input"].includes(c.type))throw Error("Invalid component");components.add(c.id);}
 }
}
export class ApplicationStore {
 private draft:ApplicationDefinition;private published:{version:number;definition:ApplicationDefinition}[]=[];
 constructor(initial:ApplicationDefinition, private readonly publicationGuard?:PublicationGuard){validate(initial);if(publicationGuard!==undefined && typeof publicationGuard!=="function")throw Error("Invalid publication guard");this.draft=copy(initial);}
 getDraft(){return copy(this.draft);}
 getPublished(version?:number){if(version!==undefined&&(!Number.isSafeInteger(version)||version<1))throw Error("Invalid version");const p=version===undefined?this.published.at(-1):this.published.find(x=>x.version===version);return p?copy(p):undefined;}
 apply(baseRevision:number,patches:Patch[]):ApplicationDefinition{
  if(baseRevision!==this.draft.revision)throw Error("Revision conflict");
  const candidate=copy(this.draft);
  for(const p of patches){switch(p.op){
   case "addPage":candidate.pages.push(copy(p.page));break;
   case "setPageTitle":{const page=candidate.pages.find(x=>x.id===p.pageId);if(!page)throw Error("Unknown page");page.title=p.title;break;}
   case "addComponent":{const page=candidate.pages.find(x=>x.id===p.pageId);if(!page)throw Error("Unknown page");page.components.push(copy(p.component));break;}
   default: throw Error("Unknown patch operation");
  }}
  candidate.revision++;validate(candidate);this.draft=candidate;return copy(candidate);
 }
 publish(expectedRevision:number){if(expectedRevision!==this.draft.revision)throw Error("Revision conflict");enforcePublicationGuard(this.publicationGuard,this.draft);const p={version:this.published.length+1,definition:copy(this.draft)};this.published.push(p);return copy(p);}
}

export { SqliteApplicationStore } from './sqlite.js';
export { createControlPlane, createDataPlane, createProposalPlane, createDevelopmentPlanes } from './planes.js';
export type { DefinitionRepository, DevelopmentRunner } from './planes.js';

export { DevelopmentProposals } from './proposals.js';
export type { Proposal } from './proposals.js';
export { importOpenAPI, CapabilityRegistry } from './capabilities.js';
export type { CapabilityCandidate, InvocationContext, CapabilityAuditEvent, CapabilityAuditSink } from './capabilities.js';
export { createCapabilityServer } from './capability-server.js';
export { createOpenAPIGetBinding } from './openapi-get.js';
export { PublishedDefinitionCache, CachedPublishedRepository } from './published-cache.js';
export type { CacheScope } from './published-cache.js';
export { checkExtensionCompatibility, createExtensionPublicationGuard, ExtensionRegistry } from './extensions.js';
export type { ExtensionManifest, ExtensionHost, ExtensionRequirements, ExtensionBindings, ExtensionImplementation, ExtensionConfigRule, ExtensionConfigSchema, ExtensionConfiguration } from './extensions.js';
