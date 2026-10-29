import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const script=await readFile(new URL('../../packages/web/dist/offline.js',import.meta.url));
const fixture=`<!doctype html><body data-result="pending"><script type="module">
import {EncryptedBrowserQueue} from '/offline.js';
try {
 const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
 const opts={enabled:true,databaseName:'smoke',scope:{tenantId:'t',applicationId:'a',principalId:'p'},key};
 const a=await EncryptedBrowserQueue.open(opts),b=await EncryptedBrowserQueue.open(opts);
 const item=await a.enqueue('save','request',{name:'private-value'});
 if((await b.enqueue('save','request',{name:'private-value'})).id!==item.id)throw Error('Deduplication failed');
 const result=await Promise.allSettled([a.transition(item.id,1,'claim'),b.transition(item.id,1,'claim')]);
 if(result.filter(x=>x.status==='fulfilled').length!==1)throw Error('Concurrent claim failed');
 const running=await a.get(item.id),uncertain=await a.transition(item.id,running.version,'uncertain');
 if((await b.transition(item.id,uncertain.version,'reconcileApplied')).status!=='succeeded')throw Error('Reconciliation failed');
 const open=indexedDB.open('smoke',1);const db=await new Promise((resolve,reject)=>{open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(open.error);});
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
 if(req.url==='/offline.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(script);}else{res.writeHead(200,{'content-type':'text/html'});res.end(fixture);}
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
 await rm(directory,{recursive:true,force:true});
}
