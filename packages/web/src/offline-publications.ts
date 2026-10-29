/** Encrypted, scope-bound cache of host-authorized published definitions. */
export type OfflinePublicationScope={tenantId:string;principalId:string;authorizationKey:string;applicationId:string;schemaVersion:number};
export type OfflinePublication={version:number;definition:{id:string;schemaVersion:number;[key:string]:unknown}};
export type OfflinePublicationOptions={enabled:true;databaseName:string;scope:OfflinePublicationScope;key:CryptoKey;maxAgeMs:number;authorize:(scope:OfflinePublicationScope,action:'read'|'write')=>boolean|Promise<boolean>;compatible:(definition:unknown)=>boolean;indexedDB?:IDBFactory;crypto?:Crypto;clock?:()=>number};
type Envelope={id:string;revision:number;iv?:Uint8Array<ArrayBuffer>;ciphertext?:ArrayBuffer};
type KeyMarker={id:string;epoch:number;iv:Uint8Array<ArrayBuffer>;ciphertext:ArrayBuffer};
type Entry={publication:OfflinePublication;etag:string;savedAt:number};
const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
const validId=(x:unknown):x is string=>typeof x==='string'&&x.trim().length>0&&x.length<=256&&!/[\u0000-\u001f]/.test(x);
const object=(x:unknown):x is Record<string,unknown>=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const hex=(buffer:ArrayBuffer)=>Array.from(new Uint8Array(buffer),v=>v.toString(16).padStart(2,'0')).join('');
const request=<T>(r:IDBRequest<T>):Promise<T>=>new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error??Error('IndexedDB request failed'));});
const finished=(tx:IDBTransaction):Promise<void>=>new Promise((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??Error('IndexedDB transaction aborted'));tx.onerror=()=>{};});
function jsonCopy(input:unknown):Record<string,unknown>{
 let count=0;const ancestors=new Set<object>();
 const visit=(value:unknown,depth:number):unknown=>{
  if(++count>10000||depth>40)throw Error('Publication too large');
  if(value===null||typeof value==='string'||typeof value==='boolean'||(typeof value==='number'&&Number.isFinite(value)))return value;
  if(typeof value!=='object'||value===null||ancestors.has(value))throw Error('Invalid publication');
  ancestors.add(value);let result:unknown;
  if(Array.isArray(value)){
   if(value.length>10000||Object.keys(value).length!==value.length||Array.from({length:value.length},(_,i)=>Object.hasOwn(value,i)).some(p=>!p))throw Error('Invalid publication');
   result=value.map(item=>visit(item,depth+1));
  }else{
   if(Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null)throw Error('Invalid publication');
   const output:Record<string,unknown>={};for(const [key,item] of Object.entries(value)){if(['__proto__','prototype','constructor'].includes(key))throw Error('Invalid publication');output[key]=visit(item,depth+1);}result=output;
  }
  ancestors.delete(value);return result;
 };
 if(!object(input))throw Error('Invalid publication');const serialized=JSON.stringify(visit(input,0));if(encoder.encode(serialized).length>1024*1024)throw Error('Publication too large');return JSON.parse(serialized) as Record<string,unknown>;
}

export class EncryptedPublicationCache {
 private generation=0;private closed=false;private marker:KeyMarker|undefined;
 private constructor(private readonly db:IDBDatabase,private readonly crypt:Crypto,private readonly key:CryptoKey,private readonly id:string,private readonly scope:OfflinePublicationScope,private readonly maxAgeMs:number,private readonly authorize:OfflinePublicationOptions['authorize'],private readonly compatible:OfflinePublicationOptions['compatible'],private readonly clock:()=>number){}
 static async open(options:OfflinePublicationOptions):Promise<EncryptedPublicationCache>{
  const factory=options?.indexedDB??globalThis.indexedDB,crypt=options?.crypto??globalThis.crypto,s=options?.scope,key=options?.key;
  if(options?.enabled!==true||!validId(options.databaseName)||!s||!validId(s.tenantId)||!validId(s.principalId)||!validId(s.authorizationKey)||!validId(s.applicationId)||!Number.isSafeInteger(s.schemaVersion)||s.schemaVersion<1||!factory||!crypt?.subtle||!key||key.type!=='secret'||key.extractable||key.algorithm.name!=='AES-GCM'||!key.usages.includes('encrypt')||!key.usages.includes('decrypt')||!Number.isSafeInteger(options.maxAgeMs)||options.maxAgeMs<1||options.maxAgeMs>30*86400000||typeof options.authorize!=='function'||typeof options.compatible!=='function'||(options.clock!==undefined&&typeof options.clock!=='function'))throw Error('Invalid offline publication configuration');
  const scope={tenantId:s.tenantId,principalId:s.principalId,authorizationKey:s.authorizationKey,applicationId:s.applicationId,schemaVersion:s.schemaVersion},databaseName=options.databaseName,maxAgeMs=options.maxAgeMs,authorize=options.authorize,compatible=options.compatible,clock=options.clock??Date.now;
  const id=hex(await crypt.subtle.digest('SHA-256',encoder.encode(JSON.stringify([scope.tenantId,scope.principalId,scope.authorizationKey,scope.applicationId,scope.schemaVersion]))));
  const open=factory.open(databaseName,3);let blocked=false;open.onupgradeneeded=()=>{if(blocked){open.transaction?.abort();return;}if(!open.result.objectStoreNames.contains('publications'))open.result.createObjectStore('publications',{keyPath:'id'});if(!open.result.objectStoreNames.contains('offline')){const store=open.result.createObjectStore('offline',{keyPath:'id'});store.createIndex('partition','partition',{unique:false});}};
  const db=await new Promise<IDBDatabase>((resolve,reject)=>{open.onblocked=()=>{blocked=true;reject(Error('Offline publication database blocked'));};open.onerror=()=>reject(open.error??Error('IndexedDB open failed'));open.onsuccess=()=>{if(blocked)open.result.close();else resolve(open.result);};});
  const cache=new EncryptedPublicationCache(db,crypt,key,id,scope,maxAgeMs,authorize,compatible,clock);db.onversionchange=()=>cache.close();try{await cache.initializeMarker();return cache;}catch(error){cache.close();throw error;}
 }
 close():void{this.closed=true;this.generation++;this.db.close();}
 private markerId():string{return '@publication-key:'+this.id;}
 private markerAad(epoch:number):Uint8Array<ArrayBuffer>{return encoder.encode(JSON.stringify(['publication-key-v1',this.id,epoch]));}
 private sameMarker(value:unknown):boolean{
  const expected=this.marker;if(value===undefined)return expected===undefined;if(!expected||!object(value)||value.id!==expected.id||value.epoch!==expected.epoch||!(value.iv instanceof Uint8Array)||!(value.ciphertext instanceof ArrayBuffer))return false;
  const equal=(a:Uint8Array,b:Uint8Array)=>a.length===b.length&&a.every((byte,index)=>byte===b[index]);return equal(value.iv,expected.iv)&&equal(new Uint8Array(value.ciphertext),new Uint8Array(expected.ciphertext));
 }
 private async initializeMarker():Promise<void>{
  const tx=this.db.transaction('publications','readonly'),done=finished(tx),value=await request(tx.objectStore('publications').get(this.markerId())) as KeyMarker|undefined;await done;
  if(value!==undefined){if(!object(value)||value.id!==this.markerId()||!Number.isSafeInteger(value.epoch)||value.epoch<1||!(value.iv instanceof Uint8Array)||value.iv.length!==12||!(value.ciphertext instanceof ArrayBuffer)||value.ciphertext.byteLength!==34)throw Error('Invalid offline publication key marker');
   try{const clear=await this.crypt.subtle.decrypt({name:'AES-GCM',iv:value.iv,additionalData:this.markerAad(value.epoch)},this.key,value.ciphertext);if(decoder.decode(clear)!=='publication-key-v1')throw Error('Invalid marker');}catch{throw Error('Cannot authenticate offline publication key');}this.marker=value;
  }
  await this.ensureCurrent();
 }
 private async guard(store:IDBObjectStore,tx:IDBTransaction,done:Promise<void>):Promise<void>{const value=await request(store.get(this.markerId()));if(this.closed||!this.sameMarker(value)){tx.abort();try{await done;}catch{}throw Error('Offline publication cache changed');}}
 private async ensureCurrent():Promise<void>{if(this.closed)throw Error('Offline publication cache changed');const tx=this.db.transaction('publications','readonly'),done=finished(tx),store=tx.objectStore('publications');await this.guard(store,tx,done);await done;if(this.closed)throw Error('Offline publication cache changed');}
 private async newMarker(key:CryptoKey):Promise<KeyMarker>{const epoch=(this.marker?.epoch??0)+1;if(!Number.isSafeInteger(epoch))throw Error('Invalid offline publication key epoch');const iv=this.crypt.getRandomValues(new Uint8Array(12)),ciphertext=await this.crypt.subtle.encrypt({name:'AES-GCM',iv,additionalData:this.markerAad(epoch)},key,encoder.encode('publication-key-v1'));return {id:this.markerId(),epoch,iv,ciphertext};}
 private checkGeneration(generation:number):void{if(this.closed||generation!==this.generation)throw Error('Offline publication cache changed');}
 private async permitted(action:'read'|'write',generation:number):Promise<void>{if(await this.authorize({...this.scope},action)!==true)throw Error('Offline publication access denied');this.checkGeneration(generation);}
 private now():number{const n=this.clock();if(!Number.isSafeInteger(n)||n<0)throw Error('Invalid clock');return n;}
 private aad(revision:number):Uint8Array<ArrayBuffer>{return encoder.encode(JSON.stringify([this.id,revision]));}
 private async raw():Promise<Envelope|undefined>{if(this.closed)throw Error('Offline publication cache changed');const tx=this.db.transaction('publications','readonly'),done=finished(tx),store=tx.objectStore('publications');await this.guard(store,tx,done);const value=await request(store.get(this.id)) as Envelope|undefined;await done;if(value&&(!Number.isSafeInteger(value.revision)||value.revision<1||value.id!==this.id))throw Error('Invalid offline publication entry');return value;}
 private async verify(publication:unknown,etag:unknown,checkCompatibility=true):Promise<OfflinePublication>{
  const normalized=jsonCopy(publication),definition=normalized.definition;
  if(!Number.isSafeInteger(normalized.version)||(normalized.version as number)<1||!object(definition)||definition.id!==this.scope.applicationId||definition.schemaVersion!==this.scope.schemaVersion||typeof etag!=='string'||!/^"[a-f0-9]{64}"$/.test(etag)||(checkCompatibility&&this.compatible(structuredClone(definition))!==true))throw Error('Incompatible offline publication');
  const hash='"'+hex(await this.crypt.subtle.digest('SHA-256',encoder.encode(JSON.stringify(normalized))))+'"';if(hash!==etag)throw Error('Offline publication ETag mismatch');return normalized as OfflinePublication;
 }
 private async decode(envelope:Envelope,checkCompatibility=true):Promise<Entry|undefined>{
  if(envelope.iv===undefined&&envelope.ciphertext===undefined)return undefined;
  if(!(envelope.iv instanceof Uint8Array)||envelope.iv.length!==12||!(envelope.ciphertext instanceof ArrayBuffer)||envelope.ciphertext.byteLength>1024*1024+16384)throw Error('Invalid offline publication entry');
  try{
   const bytes=await this.crypt.subtle.decrypt({name:'AES-GCM',iv:envelope.iv,additionalData:this.aad(envelope.revision)},this.key,envelope.ciphertext);
   const entry=JSON.parse(decoder.decode(bytes)) as Entry;
   if(!object(entry)||Object.keys(entry).length!==3||!Number.isSafeInteger(entry.savedAt)||entry.savedAt<0)throw Error('Invalid entry');
   entry.publication=await this.verify(entry.publication,entry.etag,checkCompatibility);return entry;
  }catch{throw Error('Cannot authenticate offline publication');}
 }
 async read():Promise<Entry|undefined>{
  const generation=this.generation;this.checkGeneration(generation);await this.permitted('read',generation);
  const raw=await this.raw();if(!raw){this.checkGeneration(generation);return undefined;}const entry=await this.decode(raw);
  const latest=await this.raw();if(!latest||latest.revision!==raw.revision)throw Error('Offline publication cache changed');
  await this.permitted('read',generation);const confirmed=await this.raw();this.checkGeneration(generation);if(!confirmed||confirmed.revision!==raw.revision)throw Error('Offline publication cache changed');if(!entry)return undefined;
  const now=this.now();if(entry.savedAt>now||now-entry.savedAt>this.maxAgeMs)return undefined;return structuredClone(entry);
 }
 async store(publication:unknown,etag:string):Promise<void>{
  const generation=this.generation;this.checkGeneration(generation);await this.permitted('write',generation);
  const normalized=await this.verify(publication,etag),previous=await this.raw(),old=previous?await this.decode(previous,false):undefined;
  if(old&&(normalized.version<old.publication.version||(normalized.version===old.publication.version&&etag!==old.etag)))throw Error('Offline publication version conflict');
  const revision=(previous?.revision??0)+1;if(!Number.isSafeInteger(revision))throw Error('Invalid offline publication revision');
  const entry={publication:normalized,etag,savedAt:this.now()},iv=this.crypt.getRandomValues(new Uint8Array(12));
  const ciphertext=await this.crypt.subtle.encrypt({name:'AES-GCM',iv,additionalData:this.aad(revision)},this.key,encoder.encode(JSON.stringify(entry)));
  await this.permitted('write',generation);
  const tx=this.db.transaction('publications','readwrite'),done=finished(tx),store=tx.objectStore('publications');await this.guard(store,tx,done);const latest=await request(store.get(this.id)) as Envelope|undefined;
  if((latest?.revision??0)!==(previous?.revision??0)||this.closed||generation!==this.generation){tx.abort();try{await done;}catch{}throw Error('Offline publication cache changed');}
  store.put({id:this.id,revision,iv,ciphertext});await done;
 }
 /** Switch the scope to a host-supplied key, preserving any existing entry. */
 async rotateKey(nextKey:CryptoKey):Promise<boolean>{
  if(!nextKey||nextKey.type!=='secret'||nextKey.extractable||nextKey.algorithm.name!=='AES-GCM'||!nextKey.usages.includes('encrypt')||!nextKey.usages.includes('decrypt'))throw Error('Invalid offline publication key');
  const generation=this.generation;this.checkGeneration(generation);await this.permitted('read',generation);await this.permitted('write',generation);
  const previous=await this.raw(),entry=previous?await this.decode(previous,false):undefined;
  const revision=(previous?.revision??0)+1;if(!Number.isSafeInteger(revision))throw Error('Invalid offline publication revision');
  let replacement:Envelope={id:this.id,revision};if(entry){const iv=this.crypt.getRandomValues(new Uint8Array(12)),ciphertext=await this.crypt.subtle.encrypt({name:'AES-GCM',iv,additionalData:this.aad(revision)},nextKey,encoder.encode(JSON.stringify(entry)));replacement={id:this.id,revision,iv,ciphertext};}const marker=await this.newMarker(nextKey);
  await this.permitted('read',generation);await this.permitted('write',generation);
  const tx=this.db.transaction('publications','readwrite'),done=finished(tx),store=tx.objectStore('publications');await this.guard(store,tx,done);const latest=await request(store.get(this.id)) as Envelope|undefined;
  if((latest?.revision??0)!==(previous?.revision??0)||this.closed||generation!==this.generation){tx.abort();try{await done;}catch{}throw Error('Offline publication cache changed');}
  store.put(replacement);store.put(marker);await done;this.close();return !!entry;
 }
 async clear():Promise<void>{
  if(this.closed)throw Error('Offline publication cache changed');this.generation++;
  const tx=this.db.transaction('publications','readwrite'),done=finished(tx),store=tx.objectStore('publications');await this.guard(store,tx,done);const current=await request(store.get(this.id)) as Envelope|undefined;
  const revision=(current?.revision??0)+1;if(!Number.isSafeInteger(revision)||revision<1){tx.abort();try{await done;}catch{}throw Error('Invalid offline publication revision');}
  store.put({id:this.id,revision});await done;
 }
}
