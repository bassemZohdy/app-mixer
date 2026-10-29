/** Encrypted browser storage for explicitly enabled offline intents. The host owns keys and synchronization. */
export type BrowserQueueScope={tenantId:string;applicationId:string;principalId:string};
export type BrowserQueueStatus='pending'|'running'|'conflict'|'uncertain'|'exhausted'|'succeeded'|'discarded';
export type BrowserQueueItem={id:string;version:number;operationId:string;requestKey:string;idempotencyKey:string;payload:Record<string,unknown>;status:BrowserQueueStatus;attempts:number;replacementId?:string};
export type BrowserQueueOptions={enabled:true;databaseName:string;scope:BrowserQueueScope;key:CryptoKey;indexedDB?:IDBFactory;crypto?:Crypto};
type Envelope={id:string;partition:string;version:number;iv:Uint8Array<ArrayBuffer>;ciphertext:ArrayBuffer};
const enc=new TextEncoder(),dec=new TextDecoder('utf-8',{fatal:true});
const identifier=(x:unknown):x is string=>typeof x==='string'&&x.trim().length>0&&x.length<=256&&!/[\u0000-\u001f]/.test(x);
const record=(x:unknown):x is Record<string,unknown>=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const hex=(bytes:ArrayBuffer)=>Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');
const req=<T>(request:IDBRequest<T>):Promise<T>=>new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error??Error('IndexedDB request failed'));});
const complete=(tx:IDBTransaction):Promise<void>=>new Promise((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??Error('IndexedDB transaction aborted'));tx.onerror=()=>{};});
function copy(input:unknown):Record<string,unknown>{
  let count=0;const ancestors=new Set<object>();
  const visit=(value:unknown,depth:number):unknown=>{
    if(++count>10000||depth>40)throw Error('Offline payload too large');
    if(value===null||typeof value==='string'||typeof value==='boolean'||(typeof value==='number'&&Number.isFinite(value)))return value;
    if(typeof value!=='object'||value===null||ancestors.has(value))throw Error('Invalid offline payload');
    ancestors.add(value);let result:unknown;
    if(Array.isArray(value)){
      if(value.length>10000||Object.keys(value).length!==value.length||Array.from({length:value.length},(_,i)=>Object.hasOwn(value,i)).some(p=>!p))throw Error('Invalid offline payload');
      result=value.map(item=>visit(item,depth+1));
    }else{
      if(Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null)throw Error('Invalid offline payload');
      const out:Record<string,unknown>={};for(const [key,item] of Object.entries(value)){if(['__proto__','prototype','constructor'].includes(key))throw Error('Invalid offline payload');out[key]=visit(item,depth+1);}result=out;
    }
    ancestors.delete(value);return result;
  };
  if(!record(input))throw Error('Invalid offline payload');
  const serialized=JSON.stringify(visit(input,0));if(enc.encode(serialized).length>1024*1024)throw Error('Offline payload too large');
  return JSON.parse(serialized) as Record<string,unknown>;
}
function canonical(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(record(value))return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
  return JSON.stringify(value);
}

export class EncryptedBrowserQueue {
  private constructor(private readonly db:IDBDatabase,private readonly crypt:Crypto,private readonly key:CryptoKey,private readonly partition:string,private readonly scope:BrowserQueueScope){}
  static async open(options:BrowserQueueOptions):Promise<EncryptedBrowserQueue>{
    const factory=options?.indexedDB??globalThis.indexedDB,crypt=options?.crypto??globalThis.crypto,scope=options?.scope,key=options?.key;
    if(options?.enabled!==true||!identifier(options.databaseName)||!scope||!identifier(scope.tenantId)||!identifier(scope.applicationId)||!identifier(scope.principalId)||!factory||!crypt?.subtle||typeof crypt.randomUUID!=='function'||!key||key.type!=='secret'||key.extractable||key.algorithm.name!=='AES-GCM'||!key.usages.includes('encrypt')||!key.usages.includes('decrypt'))throw Error('Invalid encrypted offline storage configuration');
    const fixedScope={tenantId:scope.tenantId,applicationId:scope.applicationId,principalId:scope.principalId},databaseName=options.databaseName;
    const partition=hex(await crypt.subtle.digest('SHA-256',enc.encode(JSON.stringify([fixedScope.tenantId,fixedScope.applicationId,fixedScope.principalId]))));
    const request=factory.open(databaseName,1);
    request.onupgradeneeded=()=>{const store=request.result.createObjectStore('offline',{keyPath:'id'});store.createIndex('partition','partition',{unique:false});};
    let blocked=false;
    const db=await new Promise<IDBDatabase>((resolve,reject)=>{
      request.onblocked=()=>{blocked=true;reject(Error('Offline database upgrade blocked'));};
      request.onerror=()=>reject(request.error??Error('IndexedDB open failed'));
      request.onsuccess=()=>{if(blocked)request.result.close();else resolve(request.result);};
    });
    db.onversionchange=()=>db.close();return new EncryptedBrowserQueue(db,crypt,key,partition,fixedScope);
  }
  close():void{this.db.close();}
  getScope():BrowserQueueScope{return {...this.scope};}
  private async itemId(requestKey:string):Promise<string>{return hex(await this.crypt.subtle.digest('SHA-256',enc.encode(JSON.stringify([this.partition,requestKey]))));}
  private aad(id:string,version:number):Uint8Array<ArrayBuffer>{return enc.encode(JSON.stringify([this.partition,id,version]));}
  private async seal(item:BrowserQueueItem):Promise<Envelope>{
    const iv=this.crypt.getRandomValues(new Uint8Array(12));
    const ciphertext=await this.crypt.subtle.encrypt({name:'AES-GCM',iv,additionalData:this.aad(item.id,item.version)},this.key,enc.encode(JSON.stringify(item)));
    return {id:item.id,partition:this.partition,version:item.version,iv,ciphertext};
  }
  private async unseal(envelope:Envelope):Promise<BrowserQueueItem>{
    if(!envelope||envelope.partition!==this.partition||!identifier(envelope.id)||!Number.isSafeInteger(envelope.version)||envelope.version<1||!(envelope.iv instanceof Uint8Array)||envelope.iv.length!==12||!(envelope.ciphertext instanceof ArrayBuffer)||envelope.ciphertext.byteLength>1024*1024+16384)throw Error('Invalid encrypted offline entry');
    try{
      const bytes=await this.crypt.subtle.decrypt({name:'AES-GCM',iv:envelope.iv,additionalData:this.aad(envelope.id,envelope.version)},this.key,envelope.ciphertext);
      const value=JSON.parse(dec.decode(bytes)) as BrowserQueueItem;
      if(!record(value)||value.id!==envelope.id||value.version!==envelope.version||!identifier(value.operationId)||!identifier(value.requestKey)||!identifier(value.idempotencyKey)||!['pending','running','conflict','uncertain','exhausted','succeeded','discarded'].includes(value.status)||!Number.isSafeInteger(value.attempts)||value.attempts<0||(Object.keys(value).length!==8&&Object.keys(value).length!==9)||(value.replacementId!==undefined&&(value.status!=='discarded'||typeof value.replacementId!=='string'||!/^[a-f0-9]{64}$/.test(value.replacementId)))||(Object.keys(value).length===9&&!Object.hasOwn(value,'replacementId'))||await this.itemId(value.requestKey)!==value.id)throw Error('Invalid entry');
      value.payload=copy(value.payload);return value;
    }catch{throw Error('Cannot authenticate offline entry');}
  }
  async get(id:string):Promise<BrowserQueueItem|undefined>{
    if(!/^[a-f0-9]{64}$/.test(id))throw Error('Invalid offline ID');
    const tx=this.db.transaction('offline','readonly'),done=complete(tx),entry=await req(tx.objectStore('offline').get(id)) as Envelope|undefined;await done;
    if(!entry||entry.partition!==this.partition)return undefined;return this.unseal(entry);
  }
  async list():Promise<BrowserQueueItem[]>{
    const tx=this.db.transaction('offline','readonly'),done=complete(tx),entries=await req(tx.objectStore('offline').index('partition').getAll(this.partition)) as Envelope[];await done;
    if(entries.length>1000)throw Error('Offline queue too large');return Promise.all(entries.map(entry=>this.unseal(entry)));
  }
  async enqueue(operationId:string,requestKey:string,payload:Record<string,unknown>):Promise<BrowserQueueItem>{
    if(!identifier(operationId)||!identifier(requestKey))throw Error('Invalid offline request');
    const normalized=copy(payload),id=await this.itemId(requestKey),item:BrowserQueueItem={id,version:1,operationId,requestKey,idempotencyKey:this.crypt.randomUUID(),payload:normalized,status:'pending',attempts:0},envelope=await this.seal(item);
    const tx=this.db.transaction('offline','readwrite'),done=complete(tx),store=tx.objectStore('offline');
    const existing=await req(store.get(id)) as Envelope|undefined;
    if(!existing){const count=await req(store.index('partition').count(this.partition));if(count>=1000){tx.abort();try{await done;}catch{}throw Error('Offline queue full');}store.add(envelope);}
    await done;
    if(existing){const previous=await this.unseal(existing);if(previous.operationId!==operationId||canonical(previous.payload)!==canonical(normalized))throw Error('Offline request conflict');return previous;}
    return structuredClone(item);
  }
  /** Atomically replace a reviewed conflict with a new, separately idempotent intent. */
  async resolveConflict(id:string,expectedVersion:number,requestKey:string,payload:Record<string,unknown>):Promise<BrowserQueueItem>{
    if(!Number.isSafeInteger(expectedVersion)||expectedVersion<1||expectedVersion>=Number.MAX_SAFE_INTEGER||!identifier(requestKey))throw Error('Invalid conflict resolution');
    const normalized=copy(payload),replacementId=await this.itemId(requestKey),current=await this.get(id);
    if(!current||replacementId===id)throw Error('Invalid conflict resolution');
    if(current.status==='discarded'&&current.version===expectedVersion+1&&current.replacementId===replacementId){
      const previous=await this.get(replacementId);
      if(!previous||previous.operationId!==current.operationId||canonical(previous.payload)!==canonical(normalized))throw Error('Offline request conflict');
      return previous;
    }
    if(current.status!=='conflict'||current.version!==expectedVersion)throw Error('Offline version conflict');
    const replacement:BrowserQueueItem={id:replacementId,version:1,operationId:current.operationId,requestKey,idempotencyKey:this.crypt.randomUUID(),payload:normalized,status:'pending',attempts:0};
    const original={...current,status:'discarded' as const,version:current.version+1,replacementId};
    const [originalEnvelope,replacementEnvelope]=await Promise.all([this.seal(original),this.seal(replacement)]);
    const tx=this.db.transaction('offline','readwrite'),done=complete(tx),store=tx.objectStore('offline');
    const latest=await req(store.get(id)) as Envelope|undefined,existing=await req(store.get(replacementId)) as Envelope|undefined,count=await req(store.index('partition').count(this.partition));
    if(!latest||latest.partition!==this.partition||latest.version!==expectedVersion||existing||count>=1000){
      tx.abort();try{await done;}catch{}
      if(existing)throw Error('Offline request conflict');if(count>=1000)throw Error('Offline queue full');throw Error('Offline version conflict');
    }
    store.put(originalEnvelope);store.add(replacementEnvelope);await done;return structuredClone(replacement);
  }
  /** Compare-and-swap transitions prevent two tabs from claiming the same entry. */
  async transition(id:string,expectedVersion:number,action:'claim'|'succeed'|'conflict'|'uncertain'|'exhaust'|'requeue'|'discard'|'reconcileApplied'|'reconcileNotApplied'|'release'|'exhaustPending'):Promise<BrowserQueueItem>{
    if(!Number.isSafeInteger(expectedVersion)||expectedVersion<1||expectedVersion>=Number.MAX_SAFE_INTEGER)throw Error('Invalid offline version');
    const current=await this.get(id);if(!current||current.version!==expectedVersion)throw Error('Offline version conflict');
    const transitions:Record<string,Partial<Record<BrowserQueueStatus,BrowserQueueStatus>>>={claim:{pending:'running'},succeed:{running:'succeeded'},conflict:{running:'conflict'},uncertain:{running:'uncertain'},exhaust:{running:'exhausted'},requeue:{running:'pending'},discard:{pending:'discarded',conflict:'discarded',exhausted:'discarded'},reconcileApplied:{uncertain:'succeeded'},reconcileNotApplied:{uncertain:'pending'},release:{running:'pending'},exhaustPending:{pending:'exhausted'}};
    const target=transitions[action]?.[current.status];if(!target)throw Error('Invalid offline transition');
    if((action==='claim'&&current.attempts>=Number.MAX_SAFE_INTEGER)||(action==='release'&&current.attempts<1))throw Error('Invalid offline attempt count');
    const updated={...current,status:target,version:current.version+1,attempts:current.attempts+(action==='claim'?1:action==='release'?-1:0)},envelope=await this.seal(updated);
    const tx=this.db.transaction('offline','readwrite'),done=complete(tx),store=tx.objectStore('offline'),latest=await req(store.get(id)) as Envelope|undefined;
    if(!latest||latest.partition!==this.partition||latest.version!==expectedVersion){tx.abort();try{await done;}catch{}throw Error('Offline version conflict');}
    store.put(envelope);await done;return structuredClone(updated);
  }
}

export { BrowserOfflineWorker } from './offline-worker.js';
export type { BrowserOfflineFailure, BrowserOfflineWorkerOptions } from './offline-worker.js';
export { mountOfflineConflictPanel } from './offline-ui.js';
export type { OfflineConflictPanel, OfflineConflictPanelOptions } from './offline-ui.js';
