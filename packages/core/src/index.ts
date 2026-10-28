export type Component = {id:string;type:"Text"|"Card"|"Table"|"Input";props?:Record<string,string|number|boolean>};
export type Page = {id:string;title:string;route:string;components:Component[]};
export type ApplicationDefinition = {id:string;schemaVersion:1;revision:number;pages:Page[]};
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
 constructor(initial:ApplicationDefinition){validate(initial);this.draft=copy(initial);}
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
 publish(expectedRevision:number){if(expectedRevision!==this.draft.revision)throw Error("Revision conflict");const p={version:this.published.length+1,definition:copy(this.draft)};this.published.push(p);return copy(p);}
}

export { SqliteApplicationStore } from './sqlite.js';
export { createControlPlane, createDataPlane, createProposalPlane, createDevelopmentPlanes } from './planes.js';
export type { DefinitionRepository, DevelopmentRunner } from './planes.js';

export { DevelopmentProposals } from './proposals.js';
export type { Proposal } from './proposals.js';
