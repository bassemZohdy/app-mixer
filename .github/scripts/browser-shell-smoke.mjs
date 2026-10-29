import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createProject} from '../../packages/cli/dist/index.js';

const dir=await mkdtemp(join(tmpdir(),'app-mixer-shell-browser-'));let app,browser,timer,server;
let resolveResult,rejectResult,offline=false;
const result=new Promise((resolve,reject)=>{resolveResult=resolve;rejectResult=reject;});
try{
 const target=await createProject('shell-test',dir),html=await readFile(join(target,'index.html'),'utf8');
 const driver=`<script type="module">
 try{
  if(!sessionStorage.getItem('shell-test-phase')){
   const {enableOfflineShell}=await import('/offline-shell.mjs');await enableOfflineShell('v1');await navigator.serviceWorker.ready;
   for(let i=0;i<200&&!navigator.serviceWorker.controller;i++)await new Promise(resolve=>setTimeout(resolve,25));
   if(!navigator.serviceWorker.controller)throw Error('Service worker did not claim page');
   await fetch('/cut',{method:'POST'});sessionStorage.setItem('shell-test-phase','offline');location.reload();
  }else{
   if(!navigator.serviceWorker.controller)throw Error('Reload was not controlled');
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
 if(app&&app.exitCode===null&&app.signalCode===null){const stopped=once(app,'exit');app.kill();await stopped;}await rm(dir,{recursive:true,force:true});
}
