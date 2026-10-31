/** Encrypted browser storage for explicitly enabled offline intents. The host owns keys and synchronization. */
export type BrowserQueueScope={tenantId:string;applicationId:string;principalId:string};
export type BrowserQueueStatus='pending'|'running'|'conflict'|'uncertain'|'exhausted'|'succeeded'|'discarded';
export type BrowserQueueItem={id:string;version:number;operationId:string;requestKey:string;idempotencyKey:string;payload:Record<string,unknown>;status:BrowserQueueStatus;attempts:number;replacementId?:string};
/** Host-held floor for the queue's monotonic change counter, stored outside browser storage. `advance` must keep the maximum value it has seen. */
export type BrowserQueueRollbackAnchor={read():Promise<number>;advance(counter:number):Promise<void>};
export type BrowserQueueOptions={enabled:true;databaseName:string;scope:BrowserQueueScope;key:CryptoKey;indexedDB?:IDBFactory;crypto?:Crypto;rollbackAnchor?:BrowserQueueRollbackAnchor};
export type BrowserQueueAction='claim'|'succeed'|'conflict'|'uncertain'|'exhaust'|'requeue'|'discard'|'reconcileApplied'|'reconcileNotApplied'|'release'|'exhaustPending';
type Envelope={id:string;partition:string;version:number;iv:Uint8Array<ArrayBuffer>;ciphertext:ArrayBuffer};
type KeyMarker={id:string;partition:string;epoch:number;iv:Uint8Array<ArrayBuffer>;ciphertext:ArrayBuffer};
type CounterRecord={id:string;partition:string;counter:number;iv:Uint8Array<ArrayBuffer>;ciphertext:ArrayBuffer};
type PreparedCounter={current:CounterRecord|undefined;next:CounterRecord};
const COUNTER_CHANGED='Offline queue counter changed';
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
  private closed=false;private marker:KeyMarker|undefined;private anchorPending:number|undefined;
  private constructor(private readonly db:IDBDatabase,private readonly crypt:Crypto,private readonly key:CryptoKey,private readonly partition:string,private readonly scope:BrowserQueueScope,private readonly anchor?:BrowserQueueRollbackAnchor){}
  static async open(options:BrowserQueueOptions):Promise<EncryptedBrowserQueue>{
    const factory=options?.indexedDB??globalThis.indexedDB,crypt=options?.crypto??globalThis.crypto,scope=options?.scope,key=options?.key;
    if(options?.enabled!==true||!identifier(options.databaseName)||!scope||!identifier(scope.tenantId)||!identifier(scope.applicationId)||!identifier(scope.principalId)||!factory||!crypt?.subtle||typeof crypt.randomUUID!=='function'||!key||key.type!=='secret'||key.extractable||key.algorithm.name!=='AES-GCM'||!key.usages.includes('encrypt')||!key.usages.includes('decrypt')||(options.rollbackAnchor!==undefined&&(!record(options.rollbackAnchor)||typeof options.rollbackAnchor.read!=='function'||typeof options.rollbackAnchor.advance!=='function')))throw Error('Invalid encrypted offline storage configuration');
    const fixedScope={tenantId:scope.tenantId,applicationId:scope.applicationId,principalId:scope.principalId},databaseName=options.databaseName;
    const partition=hex(await crypt.subtle.digest('SHA-256',enc.encode(JSON.stringify([fixedScope.tenantId,fixedScope.applicationId,fixedScope.principalId]))));
    const request=factory.open(databaseName,3);let blocked=false;
    request.onupgradeneeded=()=>{if(blocked){request.transaction?.abort();return;}if(!request.result.objectStoreNames.contains('offline')){const store=request.result.createObjectStore('offline',{keyPath:'id'});store.createIndex('partition','partition',{unique:false});}if(!request.result.objectStoreNames.contains('publications'))request.result.createObjectStore('publications',{keyPath:'id'});};
    const db=await new Promise<IDBDatabase>((resolve,reject)=>{
      request.onblocked=()=>{blocked=true;reject(Error('Offline database upgrade blocked'));};
      request.onerror=()=>reject(request.error??Error('IndexedDB open failed'));
      request.onsuccess=()=>{if(blocked)request.result.close();else resolve(request.result);};
    });
    const queue=new EncryptedBrowserQueue(db,crypt,key,partition,fixedScope,options.rollbackAnchor);db.onversionchange=()=>queue.close();try{await queue.initializeMarker();await queue.checkRollback();return queue;}catch(error){queue.close();throw error;}
  }
  close():void{this.closed=true;this.db.close();}
  private markerId():string{return '@queue-key:'+this.partition;}
  private markerAad(epoch:number):Uint8Array<ArrayBuffer>{return enc.encode(JSON.stringify(['queue-key-v1',this.partition,epoch]));}
  private sameMarker(value:unknown):boolean{
    const expected=this.marker;if(value===undefined)return expected===undefined;if(!expected||!record(value)||value.id!==expected.id||value.partition!==expected.partition||value.epoch!==expected.epoch||!(value.iv instanceof Uint8Array)||!(value.ciphertext instanceof ArrayBuffer))return false;
    const equal=(a:Uint8Array,b:Uint8Array)=>a.length===b.length&&a.every((byte,index)=>byte===b[index]);return equal(value.iv,expected.iv)&&equal(new Uint8Array(value.ciphertext),new Uint8Array(expected.ciphertext));
  }
  private async initializeMarker():Promise<void>{
    const tx=this.db.transaction('offline','readonly'),done=complete(tx),value=await req(tx.objectStore('offline').get(this.markerId())) as KeyMarker|undefined;await done;
    if(value!==undefined){if(!record(value)||value.id!==this.markerId()||value.partition!=='@meta:'+this.partition||!Number.isSafeInteger(value.epoch)||value.epoch<1||!(value.iv instanceof Uint8Array)||value.iv.length!==12||!(value.ciphertext instanceof ArrayBuffer)||value.ciphertext.byteLength!==28)throw Error('Invalid offline queue key marker');
      try{const clear=await this.crypt.subtle.decrypt({name:'AES-GCM',iv:value.iv,additionalData:this.markerAad(value.epoch)},this.key,value.ciphertext);if(dec.decode(clear)!=='queue-key-v1')throw Error('Invalid marker');}catch{throw Error('Cannot authenticate offline queue key');}this.marker=value;
    }
    await this.ensureCurrent();
  }
  private async guard(store:IDBObjectStore,tx:IDBTransaction,done:Promise<void>):Promise<void>{const value=await req(store.get(this.markerId()));if(this.closed||!this.sameMarker(value)){tx.abort();try{await done;}catch{}throw Error('Offline queue key changed');}}
  private async ensureCurrent():Promise<void>{if(this.closed)throw Error('Offline queue key changed');const tx=this.db.transaction('offline','readonly'),done=complete(tx),store=tx.objectStore('offline');await this.guard(store,tx,done);await done;if(this.closed)throw Error('Offline queue key changed');}
  private async newMarker(key:CryptoKey):Promise<KeyMarker>{const epoch=(this.marker?.epoch??0)+1;if(!Number.isSafeInteger(epoch))throw Error('Invalid offline queue key epoch');const iv=this.crypt.getRandomValues(new Uint8Array(12)),ciphertext=await this.crypt.subtle.encrypt({name:'AES-GCM',iv,additionalData:this.markerAad(epoch)},key,enc.encode('queue-key-v1'));return {id:this.markerId(),partition:'@meta:'+this.partition,epoch,iv,ciphertext};}
  private counterId():string{return '@queue-counter:'+this.partition;}
  private counterAad(counter:number):Uint8Array<ArrayBuffer>{return enc.encode(JSON.stringify(['queue-counter-v1',this.partition,counter]));}
  private async sealCounter(counter:number,key:CryptoKey):Promise<CounterRecord>{if(!Number.isSafeInteger(counter)||counter<1)throw Error('Invalid offline queue counter');const iv=this.crypt.getRandomValues(new Uint8Array(12)),ciphertext=await this.crypt.subtle.encrypt({name:'AES-GCM',iv,additionalData:this.counterAad(counter)},key,enc.encode('queue-counter-v1'));return {id:this.counterId(),partition:'@meta:'+this.partition,counter,iv,ciphertext};}
  private async readCounter():Promise<CounterRecord|undefined>{
    const tx=this.db.transaction('offline','readonly'),done=complete(tx),store=tx.objectStore('offline');await this.guard(store,tx,done);const value=await req(store.get(this.counterId())) as CounterRecord|undefined;await done;
    if(value===undefined)return undefined;
    if(!record(value)||value.id!==this.counterId()||value.partition!=='@meta:'+this.partition||!Number.isSafeInteger(value.counter)||value.counter<1||!(value.iv instanceof Uint8Array)||value.iv.length!==12||!(value.ciphertext instanceof ArrayBuffer)||value.ciphertext.byteLength!==32)throw Error('Invalid offline queue counter');
    try{const clear=await this.crypt.subtle.decrypt({name:'AES-GCM',iv:value.iv,additionalData:this.counterAad(value.counter)},this.key,value.ciphertext);if(dec.decode(clear)!=='queue-counter-v1')throw Error('Invalid counter');}catch{throw Error('Invalid offline queue counter');}
    return value;
  }
  private async checkRollback():Promise<void>{
    if(!this.anchor)return;const floor=await this.anchor.read();if(!Number.isSafeInteger(floor)||floor<0)throw Error('Invalid offline rollback anchor');
    const local=(await this.readCounter())?.counter??0;if(local<floor)throw Error('Offline queue rollback detected');if(local>floor)await this.anchor.advance(local);
  }
  /** Read and seal the next counter before a write transaction; returns undefined when no anchor is configured. */
  private async prepareCounter(key:CryptoKey=this.key):Promise<PreparedCounter|undefined>{
    if(!this.anchor)return undefined;const current=await this.readCounter(),value=(current?.counter??0)+1;if(!Number.isSafeInteger(value))throw Error('Invalid offline queue counter');return {current,next:await this.sealCounter(value,key)};
  }
  /** Inside a write transaction: require the counter observed during preparation, then advance it with the write. */
  private async applyCounter(store:IDBObjectStore,tx:IDBTransaction,done:Promise<void>,prepared:PreparedCounter|undefined):Promise<void>{
    if(!prepared)return;const stored=await req(store.get(this.counterId())) as CounterRecord|undefined,expected=prepared.current;
    const equal=(a:Uint8Array,b:Uint8Array)=>a.length===b.length&&a.every((byte,index)=>byte===b[index]);
    const same=stored===undefined?expected===undefined:!!expected&&record(stored)&&stored.counter===expected.counter&&stored.iv instanceof Uint8Array&&stored.ciphertext instanceof ArrayBuffer&&equal(stored.iv,expected.iv)&&equal(new Uint8Array(stored.ciphertext),new Uint8Array(expected.ciphertext));
    if(!same){tx.abort();try{await done;}catch{}throw Error(COUNTER_CHANGED);}store.put(prepared.next);
  }
  /** After commit, raise the host floor. A failure leaves the local change committed and is retried by later writes or `syncRollbackAnchor`. */
  private async advanceAnchor(prepared:PreparedCounter|undefined):Promise<void>{
    if(!prepared||!this.anchor)return;const target=Math.max(prepared.next.counter,this.anchorPending??0);
    try{await this.anchor.advance(target);if(this.anchorPending!==undefined&&this.anchorPending<=target)this.anchorPending=undefined;}catch{this.anchorPending=target;}
  }
  /** Push the latest committed counter to the host anchor; throws if the anchor is still unavailable. */
  async syncRollbackAnchor():Promise<number>{
    if(!this.anchor)throw Error('Offline rollback anchor not configured');const local=(await this.readCounter())?.counter??0;await this.anchor.advance(local);if(this.anchorPending!==undefined&&this.anchorPending<=local)this.anchorPending=undefined;return local;
  }
  /** True when a committed change has not yet been recorded by the host anchor. */
  hasPendingRollbackAnchor():boolean{return this.anchorPending!==undefined;}
  private async retry<T>(operation:()=>Promise<T>):Promise<T>{
    for(let attempt=0;;attempt++){try{return await operation();}catch(error){if(!(error instanceof Error)||error.message!==COUNTER_CHANGED||attempt>=31)throw error;}
      // Another tab advanced the counter; back off with jitter so contending writers do not retry in lockstep.
      const delay=Math.min(200,2**Math.min(attempt,7))*(this.crypt.getRandomValues(new Uint8Array(1))[0]/255);await new Promise(resolve=>setTimeout(resolve,delay));}
  }
  getScope():BrowserQueueScope{return {...this.scope};}
  private async itemId(requestKey:string):Promise<string>{return hex(await this.crypt.subtle.digest('SHA-256',enc.encode(JSON.stringify([this.partition,requestKey]))));}
  private aad(id:string,version:number):Uint8Array<ArrayBuffer>{return enc.encode(JSON.stringify([this.partition,id,version]));}
  private async seal(item:BrowserQueueItem,key:CryptoKey=this.key):Promise<Envelope>{
    const iv=this.crypt.getRandomValues(new Uint8Array(12));
    const ciphertext=await this.crypt.subtle.encrypt({name:'AES-GCM',iv,additionalData:this.aad(item.id,item.version)},key,enc.encode(JSON.stringify(item)));
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
    const tx=this.db.transaction('offline','readonly'),done=complete(tx),store=tx.objectStore('offline');await this.guard(store,tx,done);const entry=await req(store.get(id)) as Envelope|undefined;await done;
    const result=!entry||entry.partition!==this.partition?undefined:await this.unseal(entry);await this.ensureCurrent();return result;
  }
  async list():Promise<BrowserQueueItem[]>{
    const tx=this.db.transaction('offline','readonly'),done=complete(tx),store=tx.objectStore('offline');await this.guard(store,tx,done);const entries=await req(store.index('partition').getAll(this.partition)) as Envelope[];await done;
    if(entries.length>1000)throw Error('Offline queue too large');const items=await Promise.all(entries.map(entry=>this.unseal(entry)));await this.ensureCurrent();return items;
  }
  /** Re-encrypt a quiescent partition atomically; callers must coordinate all other queue instances. */
  async rotateKey(nextKey:CryptoKey):Promise<number>{
    if(!nextKey||nextKey.type!=='secret'||nextKey.extractable||nextKey.algorithm.name!=='AES-GCM'||!nextKey.usages.includes('encrypt')||!nextKey.usages.includes('decrypt'))throw Error('Invalid offline queue key');
    const read=this.db.transaction('offline','readonly'),readDone=complete(read),readStore=read.objectStore('offline');await this.guard(readStore,read,readDone);const cursorRequest=readStore.index('partition').openCursor(this.partition),entries:Envelope[]=[];let bytes=0;
    for(let cursor=await req(cursorRequest);cursor;cursor=await req(cursorRequest)){const entry=cursor.value as Envelope;if(!(entry.ciphertext instanceof ArrayBuffer)){read.abort();try{await readDone;}catch{}throw Error('Invalid encrypted offline entry');}bytes+=entry.ciphertext.byteLength;if(entries.length>=1000||bytes>64*1024*1024){read.abort();try{await readDone;}catch{}throw Error('Offline queue too large to rotate');}entries.push(entry);cursor.continue();}
    await readDone;
    const items=await Promise.all(entries.map(entry=>this.unseal(entry)));if(items.some(item=>item.status==='running'))throw Error('Offline queue has running operations');if(items.some(item=>item.version>=Number.MAX_SAFE_INTEGER))throw Error('Invalid offline version');
    const [replacements,marker,prepared]=await Promise.all([Promise.all(items.map(item=>this.seal({...item,version:item.version+1},nextKey))),this.newMarker(nextKey),this.prepareCounter(nextKey)]);
    const tx=this.db.transaction('offline','readwrite'),done=complete(tx),store=tx.objectStore('offline');await this.guard(store,tx,done);const check=store.index('partition').openCursor(this.partition),versions=new Map(entries.map(entry=>[entry.id,entry.version]));let count=0;
    for(let cursor=await req(check);cursor;cursor=await req(check)){const entry=cursor.value as Envelope;count++;if(count>entries.length||entry.partition!==this.partition||!versions.has(entry.id)||versions.get(entry.id)!==entry.version){tx.abort();try{await done;}catch{}throw Error('Offline queue changed during rotation');}cursor.continue();}
    if(count!==entries.length){tx.abort();try{await done;}catch{}throw Error('Offline queue changed during rotation');}
    await this.applyCounter(store,tx,done,prepared);for(const entry of replacements)store.put(entry);store.put(marker);await done;await this.advanceAnchor(prepared);this.close();return replacements.length;
  }
  async enqueue(operationId:string,requestKey:string,payload:Record<string,unknown>,options?:{idempotencyKey:string}):Promise<BrowserQueueItem>{return this.retry(()=>this.enqueueOnce(operationId,requestKey,payload,options));}
  private async enqueueOnce(operationId:string,requestKey:string,payload:Record<string,unknown>,options?:{idempotencyKey:string}):Promise<BrowserQueueItem>{
    if(!identifier(operationId)||!identifier(requestKey))throw Error('Invalid offline request');
    if(options!==undefined&&(!record(options)||Object.keys(options).length!==1||!identifier(options.idempotencyKey)))throw Error('Invalid shared offline key');const sharedKey=options?.idempotencyKey;
    const normalized=copy(payload),id=await this.itemId(requestKey),item:BrowserQueueItem={id,version:1,operationId,requestKey,idempotencyKey:sharedKey??this.crypt.randomUUID(),payload:normalized,status:'pending',attempts:0},envelope=await this.seal(item),prepared=await this.prepareCounter();
    const tx=this.db.transaction('offline','readwrite'),done=complete(tx),store=tx.objectStore('offline');
    await this.guard(store,tx,done);const existing=await req(store.get(id)) as Envelope|undefined;
    if(!existing){const count=await req(store.index('partition').count(this.partition));if(count>=1000){tx.abort();try{await done;}catch{}throw Error('Offline queue full');}await this.applyCounter(store,tx,done,prepared);store.add(envelope);}
    await done;if(!existing)await this.advanceAnchor(prepared);
    if(existing){const previous=await this.unseal(existing);await this.ensureCurrent();if(previous.operationId!==operationId||canonical(previous.payload)!==canonical(normalized)||(sharedKey!==undefined&&previous.idempotencyKey!==sharedKey))throw Error('Offline request conflict');return previous;}
    return structuredClone(item);
  }
  /** Atomically replace a reviewed conflict with a new, separately idempotent intent. */
  async resolveConflict(id:string,expectedVersion:number,requestKey:string,payload:Record<string,unknown>):Promise<BrowserQueueItem>{return this.retry(()=>this.resolveConflictOnce(id,expectedVersion,requestKey,payload));}
  private async resolveConflictOnce(id:string,expectedVersion:number,requestKey:string,payload:Record<string,unknown>):Promise<BrowserQueueItem>{
    if(!Number.isSafeInteger(expectedVersion)||expectedVersion<1||expectedVersion>=Number.MAX_SAFE_INTEGER||!identifier(requestKey))throw Error('Invalid conflict resolution');
    const normalized=copy(payload),replacementId=await this.itemId(requestKey),current=await this.get(id);
    if(!current||replacementId===id)throw Error('Invalid conflict resolution');
    if(current.status==='discarded'&&current.version>expectedVersion&&current.replacementId===replacementId){
      const previous=await this.get(replacementId);
      if(!previous||previous.operationId!==current.operationId||canonical(previous.payload)!==canonical(normalized))throw Error('Offline request conflict');
      return previous;
    }
    if(current.status!=='conflict'||current.version!==expectedVersion)throw Error('Offline version conflict');
    const replacement:BrowserQueueItem={id:replacementId,version:1,operationId:current.operationId,requestKey,idempotencyKey:this.crypt.randomUUID(),payload:normalized,status:'pending',attempts:0};
    const original={...current,status:'discarded' as const,version:current.version+1,replacementId};
    const [originalEnvelope,replacementEnvelope,prepared]=await Promise.all([this.seal(original),this.seal(replacement),this.prepareCounter()]);
    const tx=this.db.transaction('offline','readwrite'),done=complete(tx),store=tx.objectStore('offline');
    await this.guard(store,tx,done);const latest=await req(store.get(id)) as Envelope|undefined,existing=await req(store.get(replacementId)) as Envelope|undefined,count=await req(store.index('partition').count(this.partition));
    if(!latest||latest.partition!==this.partition||latest.version!==expectedVersion||existing||count>=1000){
      tx.abort();try{await done;}catch{}
      if(existing)throw Error('Offline request conflict');if(count>=1000)throw Error('Offline queue full');throw Error('Offline version conflict');
    }
    await this.applyCounter(store,tx,done,prepared);store.put(originalEnvelope);store.add(replacementEnvelope);await done;await this.advanceAnchor(prepared);return structuredClone(replacement);
  }
  /** Compare-and-swap transitions prevent two tabs from claiming the same entry. */
  async transition(id:string,expectedVersion:number,action:BrowserQueueAction):Promise<BrowserQueueItem>{return this.retry(()=>this.transitionOnce(id,expectedVersion,action));}
  private async transitionOnce(id:string,expectedVersion:number,action:BrowserQueueAction):Promise<BrowserQueueItem>{
    if(!Number.isSafeInteger(expectedVersion)||expectedVersion<1||expectedVersion>=Number.MAX_SAFE_INTEGER)throw Error('Invalid offline version');
    const current=await this.get(id);if(!current||current.version!==expectedVersion)throw Error('Offline version conflict');
    const transitions:Record<string,Partial<Record<BrowserQueueStatus,BrowserQueueStatus>>>={claim:{pending:'running'},succeed:{running:'succeeded'},conflict:{running:'conflict'},uncertain:{running:'uncertain'},exhaust:{running:'exhausted'},requeue:{running:'pending'},discard:{pending:'discarded',conflict:'discarded',exhausted:'discarded'},reconcileApplied:{uncertain:'succeeded'},reconcileNotApplied:{uncertain:'pending'},release:{running:'pending'},exhaustPending:{pending:'exhausted'}};
    const target=transitions[action]?.[current.status];if(!target)throw Error('Invalid offline transition');
    if((action==='claim'&&current.attempts>=Number.MAX_SAFE_INTEGER)||(action==='release'&&current.attempts<1))throw Error('Invalid offline attempt count');
    const updated={...current,status:target,version:current.version+1,attempts:current.attempts+(action==='claim'?1:action==='release'?-1:0)},envelope=await this.seal(updated),prepared=await this.prepareCounter();
    const tx=this.db.transaction('offline','readwrite'),done=complete(tx),store=tx.objectStore('offline');await this.guard(store,tx,done);const latest=await req(store.get(id)) as Envelope|undefined;
    if(!latest||latest.partition!==this.partition||latest.version!==expectedVersion){tx.abort();try{await done;}catch{}throw Error('Offline version conflict');}
    await this.applyCounter(store,tx,done,prepared);store.put(envelope);await done;await this.advanceAnchor(prepared);return structuredClone(updated);
  }
}

export { BrowserOfflineWorker } from './offline-worker.js';
export type { BrowserOfflineFailure, BrowserOfflineWorkerOptions } from './offline-worker.js';
export { mountOfflineConflictPanel } from './offline-ui.js';
export type { OfflineConflictPanel, OfflineConflictPanelOptions } from './offline-ui.js';
