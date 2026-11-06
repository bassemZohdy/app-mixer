// Restores an older copy of a real browser profile and checks that the offline queue and the request-identity store
// both refuse to open against a floor kept by a server, outside the profile. Opt-in: APP_MIXER_TEST_BROWSER=1 with
// headless Chrome or Edge (CHROME_BIN, or found in the usual install location).
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createServer} from 'node:http';
import {existsSync,cpSync,rmSync} from 'node:fs';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join,extname} from 'node:path';
import {tmpdir} from 'node:os';
import {createProject} from '../dist/index.js';

const browserBinary=process.env.CHROME_BIN||['/usr/bin/google-chrome','/usr/bin/chromium','C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(path=>existsSync(path));
const enabled=process.env.APP_MIXER_TEST_BROWSER==='1';

// The page opens both stores with an anchor whose floor lives on the server, optionally writes one value, and reports.
const page=`<!doctype html><meta charset="utf-8"><title>Anchor</title><p id="out">loading</p>
<script type="module">
const params=new URLSearchParams(location.search),value=params.get('value'),result={};
const anchor=name=>({read:async()=>{const response=await fetch('/floor/'+name);if(!response.ok)throw Error('floor unavailable');return (await response.json()).floor;},advance:async counter=>{const response=await fetch('/floor/'+name,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({counter})});if(!response.ok)throw Error('floor not advanced');}});
try{
 const {EncryptedBrowserQueue}=await import('/offline.js'),{createPersistentOfflineRequestKeys}=await import('/offline-runtime.mjs');
 const key=await crypto.subtle.importKey('raw',new Uint8Array(32).fill(7),{name:'AES-GCM'},false,['encrypt','decrypt']),scope={tenantId:'tenant',applicationId:'app',principalId:'person'};
 try{const queue=await EncryptedBrowserQueue.open({enabled:true,databaseName:'anchored-queue',scope,key,rollbackAnchor:anchor('queue')});if(value)await queue.enqueue('items.update','request-'+value,{value});result.queue=(await queue.list()).map(item=>item.payload.value).sort();result.queuePending=queue.hasPendingRollbackAnchor?.()??null;queue.close();}catch(error){result.queue='error: '+error.message;}
 try{const keys=await createPersistentOfflineRequestKeys({databaseName:'anchored-keys',scope,rollbackAnchor:anchor('keys')});if(value)result.key=await keys.getOrCreate('slot-'+value,'items.update',{value});result.keys='open';result.keysPending=keys.hasPendingRollbackAnchor();keys.close();}catch(error){result.keys='error: '+error.message;}
}catch(error){result.fatal=error.message;}
document.getElementById('out').textContent=JSON.stringify(result);await fetch('/result',{method:'POST',body:JSON.stringify(result)});
</script><img src="/wait" alt="">`;

const types={'.js':'text/javascript','.mjs':'text/javascript'};
async function host(projectDir){
 const floors=new Map(),advances=[];let report,waiting=[];
 const server=createServer(async(request,response)=>{
  const url=new URL(request.url,'http://local');
  if(url.pathname.startsWith('/floor/')){
   const name=url.pathname.slice(7);
   if(request.method==='GET'){response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({floor:floors.get(name)??0}));return;}
   let body='';for await(const chunk of request)body+=chunk;const {counter}=JSON.parse(body);
   if(!Number.isSafeInteger(counter)||counter<0){response.writeHead(400);response.end();return;}
   // The server keeps the largest value it has received: tabs may report out of order.
   advances.push([name,counter]);floors.set(name,Math.max(floors.get(name)??0,counter));response.writeHead(204);response.end();return;
  }
  if(url.pathname==='/wait'){const done=()=>{response.writeHead(204);response.end();};if(report!==undefined)done();else waiting.push(done);return;}
  if(url.pathname==='/result'&&request.method==='POST'){let body='';for await(const chunk of request)body+=chunk;report=JSON.parse(body);response.writeHead(204);response.end();for(const done of waiting.splice(0))done();return;}
  if(url.pathname==='/anchor.html'){report=undefined;response.writeHead(200,{'content-type':'text/html'});response.end(page);return;}
  const file=url.pathname.slice(1);
  if(/^[a-z-]+\.(m?js)$/.test(file)&&existsSync(join(projectDir,file))){response.writeHead(200,{'content-type':types[extname(file)]});response.end(await readFile(join(projectDir,file)));return;}
  response.writeHead(404);response.end();
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {server,floors,advances,url:'http://127.0.0.1:'+server.address().port,result:()=>report};
}
const run=(file,args)=>new Promise((resolve,reject)=>execFile(file,args,{timeout:90000,maxBuffer:4*1024*1024},(error,stdout,stderr)=>error?reject(Object.assign(error,{stderr})):resolve(stdout)));
// One browser launch against a persistent profile; the page writes its result into #out.
async function visit(served,profile,path){
 const dom=await run(browserBinary,['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--user-data-dir='+profile,'--dump-dom',served.url+path]);
 const result=served.result();assert.ok(result,dom.slice(0,500));assert.equal(result.fatal,undefined,result.fatal);return result;
}
// A just-exited browser can hold profile files briefly on Windows.
const copy=async(from,to)=>{for(let attempt=0;;attempt++){try{rmSync(to,{recursive:true,force:true});cpSync(from,to,{recursive:true});return;}catch(error){if(attempt>20)throw error;await new Promise(resolve=>setTimeout(resolve,250));}}};

test('a restored browser profile is detected against a server-held rollback floor',{skip:!enabled?'set APP_MIXER_TEST_BROWSER=1 to run in a real browser':browserBinary?false:'no Chrome or Edge found; set CHROME_BIN',timeout:300000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'browser-anchor-')),project=await createProject('anchor-app',dir);let served;
 try{
  served=await host(project);const profile=join(dir,'profile'),snapshot=join(dir,'snapshot');
  const first=await visit(served,profile,'/anchor.html?value=A');
  assert.deepEqual({queue:first.queue,keys:first.keys,queuePending:first.queuePending,keysPending:first.keysPending},{queue:['A'],keys:'open',queuePending:false,keysPending:false},JSON.stringify(first));
  const floorsAfterFirst=Object.fromEntries(served.floors);assert.ok(floorsAfterFirst.queue>0&&floorsAfterFirst.keys>0,JSON.stringify(floorsAfterFirst));
  await copy(profile,snapshot);
  const second=await visit(served,profile,'/anchor.html?value=B');
  assert.deepEqual({queue:second.queue,keys:second.keys},{queue:['A','B'],keys:'open'},JSON.stringify(second));
  assert.ok(served.floors.get('queue')>floorsAfterFirst.queue&&served.floors.get('keys')>floorsAfterFirst.keys,'both floors advanced');
  // The current profile still opens: reads do not move the floor and match it.
  const floorsBefore=Object.fromEntries(served.floors),current=await visit(served,profile,'/anchor.html');
  assert.deepEqual({queue:current.queue,keys:current.keys},{queue:['A','B'],keys:'open'},JSON.stringify(current));assert.deepEqual(Object.fromEntries(served.floors),floorsBefore,'reads do not advance the floor');
  // Putting the older profile back is what an attacker or a backup restore would do; both stores refuse it.
  await copy(snapshot,profile);
  const restored=await visit(served,profile,'/anchor.html');
  assert.match(String(restored.queue),/^error: .*rollback detected/i,JSON.stringify(restored));
  assert.match(String(restored.keys),/^error: Offline request identity rollback detected/,JSON.stringify(restored));
  // Without the server floor the same restored profile opens: the protection comes from the floor outside the profile.
  served.floors.clear();await copy(snapshot,profile);
  const unanchored=await visit(served,profile,'/anchor.html');
  assert.deepEqual({queue:unanchored.queue,keys:unanchored.keys},{queue:['A'],keys:'open'},JSON.stringify(unanchored));
 }finally{served?.server.close();await rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:250});}
});
