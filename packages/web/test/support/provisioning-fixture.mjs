// Shared by the headless-browser test and the Android device run: the installed page, a grant signed with fresh keys
// and a small server that serves the built web modules and collects what the page reports.
import {createServer} from 'node:http';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
import {signPublicationRelease,signOfflineProvisioning} from '@app-mixer/core';

// The installed page: the pinned keys are part of the app; the grant arrives as text (here, inline as if scanned).
export const provisioningPage=(keys,carried)=>`<!doctype html><meta charset="utf-8"><title>Provisioning</title><p id="out">loading</p>
<script type="module">
const report=fetch.bind(window),result={requests:0},keys=${JSON.stringify(keys)},carried=${JSON.stringify(carried)};
// Count any network use by the app from here on; only the final report goes out.
window.fetch=(...args)=>{result.requests++;return report(...args);};
try{
 const {openOfflineProvisioning}=await import('/offline-provisioning.js'),{EncryptedPublicationCache}=await import('/offline-publications.js'),{EncryptedBrowserQueue}=await import('/offline.js');
 const key=await crypto.subtle.importKey('raw',new Uint8Array(32).fill(9),{name:'AES-GCM'},false,['encrypt','decrypt']),now=${Date.UTC(2026,10,2)};
 const options={environment:'production',applicationId:'demo',deviceId:'kiosk-1',now,...keys};
 let scope;
 if(carried){
  const grant=JSON.parse(carried),tampered=JSON.parse(carried);tampered.grant.principalId='administrator';
  try{await openOfflineProvisioning(tampered,options);result.tampered='accepted';}catch(error){result.tampered=error.message;}
  const opened=await openOfflineProvisioning(grant,options);result.principal=opened.principalId;
  localStorage.setItem('provisioned',JSON.stringify({tenantId:opened.tenantId,principalId:opened.principalId,applicationId:opened.applicationId,notAfter:opened.notAfter}));
  const etag='"'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(opened.publication)))),b=>b.toString(16).padStart(2,'0')).join('')+'"';
  scope=JSON.parse(localStorage.getItem('provisioned'));
  const cache=await EncryptedPublicationCache.open({enabled:true,databaseName:'publication',scope:{tenantId:scope.tenantId,principalId:scope.principalId,authorizationKey:'provisioned',applicationId:scope.applicationId,schemaVersion:1},key,maxAgeMs:30*86400000,authorize:()=>true,compatible:()=>true});
  await cache.store(opened.publication,etag);cache.close();
  const queue=await EncryptedBrowserQueue.open({enabled:true,databaseName:'queue',scope:{tenantId:scope.tenantId,applicationId:scope.applicationId,principalId:scope.principalId},key});
  for(const n of [1,2])await queue.enqueue('inspection.save','inspection-'+n,{site:'site-'+n});queue.close();
 }
 // On every start: everything comes from local storage.
 scope=JSON.parse(localStorage.getItem('provisioned'));
 const cache=await EncryptedPublicationCache.open({enabled:true,databaseName:'publication',scope:{tenantId:scope.tenantId,principalId:scope.principalId,authorizationKey:'provisioned',applicationId:scope.applicationId,schemaVersion:1},key,maxAgeMs:30*86400000,authorize:()=>true,compatible:()=>true});
 const cached=await cache.read();result.version=(cached.publication??cached).version;cache.close();
 const queue=await EncryptedBrowserQueue.open({enabled:true,databaseName:'queue',scope:{tenantId:scope.tenantId,applicationId:scope.applicationId,principalId:scope.principalId},key});
 result.queued=(await queue.list()).map(item=>item.payload.site).sort();queue.close();
}catch(error){result.fatal=error.message;}
const requests=result.requests;document.getElementById('out').textContent=JSON.stringify(result);await report('/result',{method:'POST',body:JSON.stringify({...result,requests})});
</script><img src="/wait" alt="">`;

export function createGrant(){
 const provisioning=generateKeyPairSync('ed25519'),release=generateKeyPairSync('ed25519'),raw=pair=>pair.publicKey.export({format:'jwk'}).x;
 const signed=signPublicationRelease({version:5,definition:{id:'demo',schemaVersion:1,revision:0,pages:[]}},'production','release-1',release.privateKey);
 const carried=JSON.stringify(signOfflineProvisioning({deviceId:'kiosk-1',tenantId:'tenant',applicationId:'demo',principalId:'field-worker',environment:'production',issuedAt:Date.UTC(2026,10,1),notAfter:Date.UTC(2026,10,15),release:signed},{keyId:'prov-1',privateKey:provisioning.privateKey,releaseKeys:[{keyId:'release-1',publicKey:release.publicKey}]}));
 const keys={keys:[{keyId:'prov-1',publicKey:raw(provisioning)}],releaseKeys:[{keyId:'release-1',publicKey:raw(release)}]};
 return {keys,carried};
}

/** Serves /app.html (with or without the grant, see `fixture.withGrant`) and the built modules; the page posts /result. */
export async function startProvisioningServer({dist,keys,carried,port=0}){
 const fixture={report:undefined,withGrant:true,modules:[],waiting:[],port:0,server:undefined};
 fixture.server=createServer(async(request,response)=>{
  const url=new URL(request.url,'http://local');
  if(url.pathname==='/wait'){const done=()=>{response.writeHead(204);response.end();};if(fixture.report!==undefined)done();else fixture.waiting.push(done);return;}
  if(url.pathname==='/result'){let body='';for await(const chunk of request)body+=chunk;fixture.report=JSON.parse(body);response.writeHead(204);response.end();for(const done of fixture.waiting.splice(0))done();return;}
  if(url.pathname==='/app.html'){fixture.report=undefined;response.writeHead(200,{'content-type':'text/html'});response.end(provisioningPage(keys,fixture.withGrant?carried:null));return;}
  const file=url.pathname.slice(1);
  if(/^[a-z-]+\.js$/.test(file)&&existsSync(join(dist,file))){fixture.modules.push(file);response.writeHead(200,{'content-type':'text/javascript'});response.end(await readFile(join(dist,file)));return;}
  response.writeHead(404);response.end();
 });
 await new Promise(resolve=>fixture.server.listen(port,'127.0.0.1',resolve));fixture.port=fixture.server.address().port;
 return fixture;
}
