// The host explicitly registers this worker with a deployment revision.
const applicationId=__APP_ID__;
const revision=new URL(self.location.href).searchParams.get('revision');
const prefix='app-mixer-shell:'+applicationId+':';
const cacheName=prefix+revision;
const assets=['/','/renderer.mjs','/workspace.mjs','/extensions.mjs','/chat.mjs','/capabilities.mjs','/data-editor.mjs','/staged-editor.mjs','/offline.js','/offline-worker.js','/offline-ui.js','/offline-runtime.mjs','/offline-shell.mjs'];
const valid=typeof revision==='string'&&/^[a-zA-Z0-9._-]{1,64}$/.test(revision);
self.addEventListener('install',event=>event.waitUntil((async()=>{
  if(!valid)throw Error('Invalid offline shell revision');
  const existed=(await caches.keys()).includes(cacheName),cache=await caches.open(cacheName);
  try{await cache.addAll(assets);}catch(error){if(!existed)await caches.delete(cacheName);throw error;}
})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  if(!valid)throw Error('Invalid offline shell revision');
  for(const name of await caches.keys())if(name.startsWith(prefix)&&name!==cacheName)await caches.delete(name);
  await self.clients.claim();
})()));
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  if(!valid||request.method!=='GET'||url.origin!==self.location.origin||url.search||!assets.includes(url.pathname)||request.headers.has('authorization'))return;
  event.respondWith((async()=>{const cache=await caches.open(cacheName),stored=await cache.match(url.pathname);return stored??fetch(request);})());
});
