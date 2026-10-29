import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const publicationScript=await readFile(new URL('../../packages/web/dist/offline-publications.js',import.meta.url));
const script=await readFile(new URL('../../packages/web/dist/offline.js',import.meta.url));
const workerScript=await readFile(new URL('../../packages/web/dist/offline-worker.js',import.meta.url));
const uiScript=await readFile(new URL('../../packages/web/dist/offline-ui.js',import.meta.url));
const runtimeScript=await readFile(new URL('../../packages/cli/templates/offline-runtime.mjs',import.meta.url));
const fixture=`<!doctype html><body data-result="pending"><script type="module">
import {EncryptedBrowserQueue,BrowserOfflineWorker,mountOfflineConflictPanel} from '/offline.js';
import {EncryptedPublicationCache} from '/offline-publications.js';
import {createGeneratedOfflineRuntime,mountGeneratedOfflineForm} from '/offline-runtime.mjs';
try {
 const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
 const publication={version:1,definition:{id:'a',schemaVersion:1,title:'publication-secret'}};
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(publication)));const etag='"'+Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('')+'"';
 const publications=await EncryptedPublicationCache.open({enabled:true,databaseName:'publication-smoke',scope:{tenantId:'t',principalId:'p',authorizationKey:'v1',applicationId:'a',schemaVersion:1},key,maxAgeMs:60000,authorize:()=>true,compatible:()=>true});await publications.store(publication,etag);if((await publications.read()).publication.definition.title!=='publication-secret')throw Error('Publication round trip failed');await publications.clear();if(await publications.read())throw Error('Publication clear failed');publications.close();
 const legacyRequest=indexedDB.open('legacy-smoke',1);legacyRequest.onupgradeneeded=()=>{const store=legacyRequest.result.createObjectStore('offline',{keyPath:'id'});store.createIndex('partition','partition');};const legacy=await new Promise((resolve,reject)=>{legacyRequest.onsuccess=()=>resolve(legacyRequest.result);legacyRequest.onerror=()=>reject(legacyRequest.error);});let upgraded=false;legacy.onversionchange=()=>{upgraded=true;legacy.close();};const migrated=await EncryptedBrowserQueue.open({enabled:true,databaseName:'legacy-smoke',scope:{tenantId:'t',applicationId:'a',principalId:'p'},key});if(!upgraded)throw Error('Legacy connection not closed');const rejected=await new Promise(resolve=>{const old=indexedDB.open('legacy-smoke',1);old.onsuccess=()=>{old.result.close();resolve(false);};old.onerror=()=>resolve(old.error.name==='VersionError');});if(!rejected)throw Error('Legacy client was not fenced');migrated.close();
 const opts={enabled:true,databaseName:'smoke',scope:{tenantId:'t',applicationId:'a',principalId:'p'},key};
 const a=await EncryptedBrowserQueue.open(opts),b=await EncryptedBrowserQueue.open(opts);
 const sharedPublication=await EncryptedPublicationCache.open({enabled:true,databaseName:'smoke',scope:{tenantId:'t',principalId:'p',authorizationKey:'v1',applicationId:'a',schemaVersion:1},key,maxAgeMs:60000,authorize:()=>true,compatible:()=>true});await sharedPublication.store(publication,etag);if((await sharedPublication.read()).publication.version!==1)throw Error('Shared publication database failed');sharedPublication.close();
 const item=await a.enqueue('save','request',{name:'private-value'});
 if((await b.enqueue('save','request',{name:'private-value'})).id!==item.id)throw Error('Deduplication failed');
 const result=await Promise.allSettled([a.transition(item.id,1,'claim'),b.transition(item.id,1,'claim')]);
 if(result.filter(x=>x.status==='fulfilled').length!==1)throw Error('Concurrent claim failed');
 const running=await a.get(item.id),uncertain=await a.transition(item.id,running.version,'uncertain');
 if((await b.transition(item.id,uncertain.version,'reconcileApplied')).status!=='succeeded')throw Error('Reconciliation failed');
 const next=await a.enqueue('save','second',{name:'worker'});let dispatched=0;
 const worker=new BrowserOfflineWorker(a,{intervalMs:100,maxPerPass:2,maxAttempts:2,isOnline:()=>true,resolveActor:()=>opts.scope,dispatch:()=>{dispatched++;},classify:()=> 'uncertain',onError:error=>{throw error;}});
 worker.start();const limit=Date.now()+10000;while((await a.get(next.id)).status!=='succeeded'&&Date.now()<limit)await new Promise(resolve=>setTimeout(resolve,25));
 await worker.stop();if(dispatched!==1||(await a.get(next.id)).status!=='succeeded')throw Error('Worker dispatch failed');
 const conflictItem=await a.enqueue('save','conflict',{name:'queued'}),claim=await a.transition(conflictItem.id,1,'claim'),conflict=await a.transition(conflictItem.id,claim.version,'conflict');
 const root=document.createElement('main');document.body.append(root);const panel=mountOfflineConflictPanel(root,a,{loadCurrent:()=>({name:'server'})});await panel.refresh();
 const [review,,resolve]=root.querySelectorAll('button');review.click();
 for(let i=0;i<100&&resolve.disabled;i++)await new Promise(done=>setTimeout(done,20));
 if(resolve.disabled||!root.textContent.includes('server'))throw Error('Conflict review failed');
 root.querySelector('textarea').value=JSON.stringify({name:'merged'});resolve.click();
 for(let i=0;i<100&&(await a.get(conflict.id)).status!=='discarded';i++)await new Promise(done=>setTimeout(done,20));
 const archived=await a.get(conflict.id);if(archived.status!=='discarded'||(await a.get(archived.replacementId)).payload.name!=='merged')throw Error('Conflict resolution failed');
 panel.dispose();root.remove();
 const formRoot=document.createElement('main');document.body.append(formRoot);let online=false,generatedCalls=0;
 const runtime=await createGeneratedOfflineRuntime({enabled:true,databaseName:'generated-smoke',scope:opts.scope,key,operations:[{id:'save',label:'Save'}],intervalMs:100,maxPerPass:2,maxAttempts:2,isOnline:()=>online,resolveActor:()=>opts.scope,canEnqueue:()=>true,canDiscard:()=>true,dispatch:()=>{generatedCalls++;},classify:()=> 'uncertain',onError:()=>{},loadCurrent:()=>({})});
 const form=mountGeneratedOfflineForm(formRoot,runtime);runtime.start();formRoot.querySelector('textarea').value=JSON.stringify({name:'local'});formRoot.querySelector('form').requestSubmit();
 for(let i=0;i<100&&(await runtime.list()).length===0;i++)await new Promise(done=>setTimeout(done,20));
 if((await runtime.list()).length!==1||generatedCalls!==0)throw Error('Offline enqueue failed');online=true;
 for(let i=0;i<100&&!(await runtime.list()).some(item=>item.status==='succeeded');i++)await new Promise(done=>setTimeout(done,20));
 if(generatedCalls!==1||!(await runtime.list()).some(item=>item.status==='succeeded'))throw Error('Generated offline sync failed');form.dispose();await runtime.close();formRoot.remove();
 const open=indexedDB.open('smoke',3);const db=await new Promise((resolve,reject)=>{open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(open.error);});
 const tx=db.transaction('offline','readonly'),get=tx.objectStore('offline').getAll(),rows=await new Promise((resolve,reject)=>{get.onsuccess=()=>resolve(get.result);get.onerror=()=>reject(get.error);});
 if(JSON.stringify(rows).includes('private-value'))throw Error('Plaintext persisted');
 db.close();a.close();b.close();document.body.dataset.result='pass';
}catch(error){document.body.dataset.result='fail';document.body.append(String(error));}
await fetch('/result',{method:'POST',headers:{'content-type':'text/plain'},body:document.body.dataset.result+':'+document.body.textContent});
</script></body>`;
let resolveResult,rejectResult;
const browserResult=new Promise((resolve,reject)=>{resolveResult=resolve;rejectResult=reject;});
const server=createServer(async(req,res)=>{
 if(req.url==='/result'&&req.method==='POST'){
  const parts=[];for await(const part of req)parts.push(part);res.writeHead(204);res.end();resolveResult(Buffer.concat(parts).toString('utf8'));return;
 }
 if(req.url==='/offline-publications.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(publicationScript);return;}
 if(req.url==='/offline.js'||req.url==='/offline-worker.js'||req.url==='/offline-ui.js'||req.url==='/offline-runtime.mjs'){res.writeHead(200,{'content-type':'text/javascript'});res.end(req.url==='/offline.js'?script:req.url==='/offline-worker.js'?workerScript:req.url==='/offline-ui.js'?uiScript:runtimeScript);}else{res.writeHead(200,{'content-type':'text/html'});res.end(fixture);}
});
const directory=await mkdtemp(join(tmpdir(),'app-mixer-offline-browser-'));let browser,timer;
try{
 server.listen(0,'127.0.0.1');await once(server,'listening');
 browser=spawn(process.env.CHROME_BIN||'google-chrome',['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',`--user-data-dir=${join(directory,'profile')}`,`http://127.0.0.1:${server.address().port}/`],{stdio:['ignore','ignore','pipe']});
 browser.stderr.resume();browser.once('error',rejectResult);browser.once('exit',code=>rejectResult(Error(`Browser exited before reporting: ${code}`)));
 timer=setTimeout(()=>rejectResult(Error('Browser offline test timed out')),30000);
 const result=await browserResult;assert.match(result,/^pass:/);
}finally{
 clearTimeout(timer);
 if(browser&&browser.exitCode===null&&browser.signalCode===null){const stopped=once(browser,'exit');browser.kill();await stopped;}
 if(server.listening)await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
 await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:200});
}

