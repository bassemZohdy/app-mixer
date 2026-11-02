import {EncryptedPublicationCache} from './offline-publications.js';

// The host supplies authenticated fetch, offline detection, authorization and an unlocked key.
export async function createOfflinePublicationRuntime(options){
 if(!options||typeof options.fetchPublication!=='function'||typeof options.isOffline!=='function')throw Error('Invalid offline publication runtime');
 const cache=await EncryptedPublicationCache.open(options);let generation=0,closed=false;
 const check=version=>{if(closed||version!==generation)throw Error('Offline publication runtime changed');};
 return {
  async refresh(){
   const version=++generation;check(version);let response;
   try{response=await options.fetchPublication();}catch(error){
    check(version);if(await options.isOffline()!==true)throw error;check(version);
    const entry=await cache.read();check(version);if(!entry)throw Error('Offline publication unavailable');
    return {publication:entry.publication,offline:true};
   }
   check(version);
   if(!response||response.status!==200||typeof response.json!=='function'||typeof response.headers?.get!=='function')throw Error('Publication unavailable');
   const etag=response.headers.get('etag'),publication=await response.json();check(version);
   await cache.store(publication,etag);check(version);
   return {publication,offline:false};
  },
  async clear(){generation++;await cache.clear();},
  hasPendingRollbackAnchor(){check(generation);return cache.hasPendingRollbackAnchor();},
  async syncRollbackAnchor(){const version=generation;check(version);const result=await cache.syncRollbackAnchor();check(version);return result;},
  close(){closed=true;generation++;cache.close();}
 };
}
