import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createProject} from '../../packages/cli/dist/index.js';

const dir=await mkdtemp(join(tmpdir(),'app-mixer-shell-browser-'));let app,browser,timer,server;
let resolveResult,rejectResult,offline=false;
const result=new Promise((resolve,reject)=>{resolveResult=resolve;rejectResult=reject;});
try{
 const target=await createProject('shell-test',dir),html=await readFile(join(target,'index.html'),'utf8');
 await writeFile(join(target,'offline-publication-host.mjs'),`export async function initializeOfflinePublication(){
 const open=indexedDB.open('test-key',1);open.onupgradeneeded=()=>open.result.createObjectStore('keys');
 const db=await new Promise((resolve,reject)=>{open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(open.error);});
 const get=db.transaction('keys').objectStore('keys').get('key');let key=await new Promise((resolve,reject)=>{get.onsuccess=()=>resolve(get.result);get.onerror=()=>reject(get.error);});
 if(!key){key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);const tx=db.transaction('keys','readwrite');tx.objectStore('keys').put(key,'key');await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});}db.close();
 return {enabled:true,databaseName:'published-test',scope:{tenantId:'tenant',principalId:'user',authorizationKey:'v1',applicationId:'shell-test',schemaVersion:1},key,maxAgeMs:60000,authorize:()=>true,onReady:api=>window.offlinePublication=api,isOffline:()=>sessionStorage.getItem('shell-test-phase')==='offline',fetchPublication:async()=>{
 if(sessionStorage.getItem('shell-test-phase')==='offline')throw Error('network unavailable');
 if(sessionStorage.getItem('shell-test-phase')==='denied')return new Response('',{status:403});
 const p={version:1,definition:{id:'shell-test',schemaVersion:1,pages:[{title:'Saved page',components:[]}]}};const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(p)));const tag='\"'+Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('')+'\"';return new Response(JSON.stringify(p),{status:200,headers:{etag:tag}});
 }};}`);
 const driver=`<script type="module">
 try{
  if(!sessionStorage.getItem('shell-test-phase')){
   for(let i=0;i<200&&!document.getElementById('pages').textContent.includes('Saved page');i++)await new Promise(resolve=>setTimeout(resolve,25));
   if(!document.getElementById('pages').textContent.includes('Saved page'))throw Error('Online publication not rendered');
   const {enableOfflineShell}=await import('/offline-shell.mjs');await enableOfflineShell('v1');await navigator.serviceWorker.ready;
   for(let i=0;i<200&&!navigator.serviceWorker.controller;i++)await new Promise(resolve=>setTimeout(resolve,25));
   if(!navigator.serviceWorker.controller)throw Error('Service worker did not claim page');
   await fetch('/cut',{method:'POST'});sessionStorage.setItem('shell-test-phase','offline');location.reload();
  }else{
   if(!navigator.serviceWorker.controller)throw Error('Reload was not controlled');
   for(let i=0;i<200&&!document.getElementById('publication-status').textContent.includes('offline');i++)await new Promise(resolve=>setTimeout(resolve,25));
   if(!document.getElementById('pages').textContent.includes('Saved page')||!document.getElementById('publication-status').textContent.includes('offline'))throw Error('Offline publication not rendered');
   sessionStorage.setItem('shell-test-phase','denied');document.getElementById('refresh-publication').click();
   for(let i=0;i<200&&!document.getElementById('pages').textContent.includes('Unable to render');i++)await new Promise(resolve=>setTimeout(resolve,25));
   if(document.getElementById('pages').textContent.includes('Saved page'))throw Error('Access denial fell back to saved publication');
   window.offlinePublication.lock();if(document.getElementById('pages').textContent||!document.getElementById('refresh-publication').hidden)throw Error('Lock did not clear the workspace');
   const staticResult=await fetch('/offline-runtime.mjs'),dynamicResult=await fetch('/api/application');
   if(!staticResult.ok||dynamicResult.status!==503)throw Error('Unexpected offline responses');
   const names=await caches.keys(),name=names.find(value=>value==='app-mixer-shell:shell-test:v1');if(!name)throw Error('Missing shell cache');
   const cache=await caches.open(name);if(await cache.match('/api/application')||await cache.match('/api/publication'))throw Error('Private data was cached');
   await fetch('/result',{method:'POST',body:'pass'});
  }
 }catch(error){await fetch('/result',{method:'POST',body:'fail:'+String(error)});}
 </script>`;
 const fixture=html.replace('</html>',driver+'</html>');
 app=spawn(process.execPath,['server.mjs'],{cwd:target,env:{...process.env,PORT:'0'},stdio:['ignore','pipe','pipe']});
 const appURL=await new Promise((resolve,reject)=>{let output='';app.stdout.on('data',part=>{output+=part;const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match)resolve(match[0]);});app.once('error',reject);app.once('exit',code=>reject(Error(`App exited: ${code}`)));});
 app.stderr.resume();
 server=createServer(async(req,res)=>{
  if(req.url==='/result'&&req.method==='POST'){const parts=[];for await(const part of req)parts.push(part);res.writeHead(204);res.end();resolveResult(Buffer.concat(parts).toString('utf8'));return;}
  if(req.url==='/cut'&&req.method==='POST'){offline=true;res.writeHead(204);res.end();return;}
  if(offline){res.writeHead(503);res.end('offline');return;}
  if(req.url==='/'){res.writeHead(200,{'content-type':'text/html'});res.end(fixture);return;}
  try{const upstream=await fetch(new URL(req.url,appURL));res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')||'text/plain'});res.end(Buffer.from(await upstream.arrayBuffer()));}
  catch{res.writeHead(502);res.end();}
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const testURL=`http://127.0.0.1:${server.address().port}/`;
 if(process.env.OFFLINE_SHELL_MANUAL==='1')console.log(testURL);
 else {browser=spawn(process.env.CHROME_BIN||'google-chrome',['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',`--user-data-dir=${join(dir,'profile')}`,testURL],{stdio:['ignore','ignore','pipe']});browser.stderr.resume();browser.once('error',rejectResult);browser.once('exit',code=>rejectResult(Error(`Browser exited: ${code}`)));}
 timer=setTimeout(()=>rejectResult(Error('Offline shell test timed out')),30000);
 assert.equal(await result,'pass');
}finally{
 clearTimeout(timer);if(browser&&browser.exitCode===null&&browser.signalCode===null){const stopped=once(browser,'exit');browser.kill();await stopped;}
 if(server?.listening)await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
 if(app&&app.exitCode===null&&app.signalCode===null){const stopped=once(app,'exit');app.kill();await stopped;}await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200});
}
