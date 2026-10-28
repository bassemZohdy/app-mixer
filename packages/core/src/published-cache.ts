import { validate, type ApplicationDefinition } from './index.js';

type Published = {version:number;definition:ApplicationDefinition};
export type CacheScope = {tenantId:string; authorizationKey:string; applicationId:string; schemaVersion:number};
type Entry = {scope:CacheScope; version:number; value:Published; expires:number};
const copy=<T>(value:T):T=>structuredClone(value);
function checkScope(scope:CacheScope):void {
  if(!scope || typeof scope.tenantId!=='string'||!scope.tenantId || typeof scope.authorizationKey!=='string'||!scope.authorizationKey || typeof scope.applicationId!=='string'||!scope.applicationId || !Number.isSafeInteger(scope.schemaVersion)||scope.schemaVersion<1)throw Error('Invalid cache scope');
}
function key(scope:CacheScope,version:number):string{return JSON.stringify([scope.tenantId,scope.authorizationKey,scope.applicationId,scope.schemaVersion,version]);}
function checkValue(scope:CacheScope,version:number,value:Published):void {
  if(!value||value.version!==version||!Number.isSafeInteger(version)||version<1||!value.definition||value.definition.id!==scope.applicationId||value.definition.schemaVersion!==scope.schemaVersion)throw Error('Incompatible publication');
  validate(value.definition);
}
/** Derived in-memory cache. Authorization must be checked before using a trusted scope. */
export class PublishedDefinitionCache {
  private readonly entries=new Map<string,Entry>();
  constructor(private readonly ttlMs=30000,private readonly maxEntries=200,private readonly clock=Date.now) {
    if(!Number.isSafeInteger(ttlMs)||ttlMs<1||!Number.isSafeInteger(maxEntries)||maxEntries<1)throw Error('Invalid cache configuration');
  }
  get(scope:CacheScope,version:number,load:()=>Published|undefined):Published|undefined {
    checkScope(scope);if(!Number.isSafeInteger(version)||version<1)throw Error('Invalid version');
    const id=key(scope,version),entry=this.entries.get(id),now=this.clock();
    if(entry && entry.expires>now){this.entries.delete(id);this.entries.set(id,entry);return copy(entry.value);}
    if(entry)this.entries.delete(id);
    const value=load();if(!value)return undefined;
    checkValue(scope,version,value);
    this.entries.set(id,{scope:copy(scope),version,value:copy(value),expires:now+this.ttlMs});
    while(this.entries.size>this.maxEntries)this.entries.delete(this.entries.keys().next().value!);
    return copy(value);
  }
  invalidate(scope:CacheScope,version?:number):void {
    checkScope(scope);
    if(version!==undefined && (!Number.isSafeInteger(version)||version<1))throw Error('Invalid version');
    for(const [id,entry] of this.entries)if(entry.scope.tenantId===scope.tenantId && entry.scope.authorizationKey===scope.authorizationKey && entry.scope.applicationId===scope.applicationId && entry.scope.schemaVersion===scope.schemaVersion && (version===undefined||entry.version===version))this.entries.delete(id);
  }
  clear():void{this.entries.clear();}
}
/** Latest is always checked against the authoritative repository; immutable versions may be cached. */
export class CachedPublishedRepository {
  constructor(private readonly source:{getPublished(version?:number):Published|undefined},private readonly scope:CacheScope,private readonly cache:PublishedDefinitionCache){checkScope(scope);this.scope=copy(scope);}
  getPublished(version?:number):Published|undefined {
    if(version!==undefined)return this.cache.get(this.scope,version,()=>this.source.getPublished(version));
    const latest=this.source.getPublished();
    if(!latest)return undefined;
    checkValue(this.scope,latest.version,latest);
    return this.cache.get(this.scope,latest.version,()=>latest);
  }
}
