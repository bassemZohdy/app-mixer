const applicationId=__APP_ID__;
const prefix='app-mixer-shell:'+applicationId+':';
const valid=revision=>typeof revision==='string'&&/^[a-zA-Z0-9._-]{1,64}$/.test(revision);
// Static shell caching is opt-in; published definitions and business data are never cached here.
export async function enableOfflineShell(revision){
  if(!valid(revision)||!globalThis.isSecureContext||!navigator.serviceWorker)throw Error('Offline shell unavailable');
  const path='/offline-shell-sw.js?revision='+encodeURIComponent(revision);
  return navigator.serviceWorker.register(path,{scope:'/'});
}
export async function disableOfflineShell(){
  if(!globalThis.isSecureContext||!navigator.serviceWorker||!globalThis.caches)throw Error('Offline shell unavailable');
  const registration=await navigator.serviceWorker.getRegistration('/');
  const scripts=[registration?.active,registration?.waiting,registration?.installing].filter(Boolean);
  if(registration&&scripts.length&&scripts.every(worker=>new URL(worker.scriptURL).origin===location.origin&&new URL(worker.scriptURL).pathname==='/offline-shell-sw.js'))await registration.unregister();
  for(const name of await caches.keys())if(name.startsWith(prefix))await caches.delete(name);
}
