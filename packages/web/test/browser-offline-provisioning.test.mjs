// A real browser provisions itself from a grant carried to it out of band: it verifies the grant and the signed
// release with its own WebCrypto Ed25519, seeds the encrypted publication cache and queue, and after a browser
// restart still has both, without the grant or any server call. Opt-in: APP_MIXER_TEST_BROWSER=1 with headless
// Chrome or Edge (CHROME_BIN, or found in the usual install location).
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createServer} from 'node:http';
import {existsSync} from 'node:fs';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {generateKeyPairSync} from 'node:crypto';
import {signPublicationRelease,signOfflineProvisioning} from '@app-mixer/core';

const browserBinary=process.env.CHROME_BIN||['/usr/bin/google-chrome','/usr/bin/chromium','C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(path=>existsSync(path));
const enabled=process.env.APP_MIXER_TEST_BROWSER==='1',dist=fileURLToPath(new URL('../dist/',import.meta.url));

// The installed page: the pinned keys are part of the app; the grant arrives as text (here, inline as if scanned).
const page=(keys,carried)=>`<!doctype html><meta charset="utf-8"><title>Provisioning</title><p id="out">loading</p>
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

test('a real browser provisions itself offline and keeps its publication and queue across a restart',{skip:!enabled?'set APP_MIXER_TEST_BROWSER=1 to run in a real browser':browserBinary?false:'no Chrome or Edge found; set CHROME_BIN',timeout:300000},async t=>{
 const provisioning=generateKeyPairSync('ed25519'),release=generateKeyPairSync('ed25519'),raw=pair=>pair.publicKey.export({format:'jwk'}).x;
 const signed=signPublicationRelease({version:5,definition:{id:'demo',schemaVersion:1,revision:0,pages:[]}},'production','release-1',release.privateKey);
 const carried=JSON.stringify(signOfflineProvisioning({deviceId:'kiosk-1',tenantId:'tenant',applicationId:'demo',principalId:'field-worker',environment:'production',issuedAt:Date.UTC(2026,10,1),notAfter:Date.UTC(2026,10,15),release:signed},{keyId:'prov-1',privateKey:provisioning.privateKey,releaseKeys:[{keyId:'release-1',publicKey:release.publicKey}]}));
 const keys={keys:[{keyId:'prov-1',publicKey:raw(provisioning)}],releaseKeys:[{keyId:'release-1',publicKey:raw(release)}]};
 let report,waiting=[],withGrant=true;const modules=[];
 const server=createServer(async(request,response)=>{
  const url=new URL(request.url,'http://local');
  if(url.pathname==='/wait'){const done=()=>{response.writeHead(204);response.end();};if(report!==undefined)done();else waiting.push(done);return;}
  if(url.pathname==='/result'){let body='';for await(const chunk of request)body+=chunk;report=JSON.parse(body);response.writeHead(204);response.end();for(const done of waiting.splice(0))done();return;}
  if(url.pathname==='/app.html'){report=undefined;response.writeHead(200,{'content-type':'text/html'});response.end(page(keys,withGrant?carried:null));return;}
  const file=url.pathname.slice(1);
  if(/^[a-z-]+\.js$/.test(file)&&existsSync(join(dist,file))){modules.push(file);response.writeHead(200,{'content-type':'text/javascript'});response.end(await readFile(join(dist,file)));return;}
  response.writeHead(404);response.end();
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const dir=await mkdtemp(join(tmpdir(),'browser-provisioning-')),profile=join(dir,'profile');
 const visit=()=>new Promise((resolve,reject)=>execFile(browserBinary,['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--user-data-dir='+profile,'--dump-dom',`http://127.0.0.1:${server.address().port}/app.html`],{timeout:90000,maxBuffer:4*1024*1024},(error,stdout)=>error?reject(error):resolve(stdout)));
 try{
  let dom=await visit();assert.ok(report,dom.slice(0,500));assert.equal(report.fatal,undefined,report.fatal);
  assert.equal(report.tampered,'Invalid offline provisioning','the browser rejects an altered grant');
  assert.deepEqual([report.principal,report.version,report.queued,report.requests],['field-worker',5,['site-1','site-2'],0],JSON.stringify(report));
  // Restart the browser with the same profile and without the grant: everything comes from local storage.
  withGrant=false;dom=await visit();assert.ok(report,dom.slice(0,500));assert.equal(report.fatal,undefined,report.fatal);
  assert.deepEqual([report.version,report.queued,report.requests],[5,['site-1','site-2'],0],JSON.stringify(report));
  t.diagnostic(`browser verified the grant with WebCrypto Ed25519 and kept ${report.queued.length} queued operations across a restart; modules served: ${[...new Set(modules)].join(', ')}`);
 }finally{server.close();await rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:250});}
});
