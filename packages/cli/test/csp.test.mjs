// The pages the project serves allow their own inline script and style by hash instead of 'unsafe-inline'.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {mkdtempSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {ApplicationStore,createDevelopmentPlanes} from '../../core/dist/index.js';
import {createAgentApprovalServer} from '../../agent/dist/index.js';
import {createProject} from '../dist/index.js';

// Independent of the implementation: hash every inline block of the served page.
const hashes=(html,tag)=>[...html.matchAll(new RegExp('<'+tag+'( [^>]*)?>([^]*?)</'+tag+'>','g'))].filter(match=>!/\ssrc=/.test(match[1]??'')).map(match=>"'sha256-"+createHash('sha256').update(match[2]).digest('base64')+"'");
function directive(policy,name){return policy.split(';').map(part=>part.trim()).find(part=>part.startsWith(name+' '))?.split(/\s+/).slice(1)??[];}
function assertPolicy(response,html,label){
 const policy=response.headers.get('content-security-policy');assert.ok(policy,label+' has a policy');
 assert.doesNotMatch(policy,/unsafe-inline|unsafe-eval/,label);assert.match(policy,/default-src 'none'/,label);assert.match(policy,/frame-ancestors 'none'/,label);assert.match(policy,/base-uri 'none'/,label);
 const scripts=hashes(html,'script'),styles=hashes(html,'style');assert.ok(scripts.length>0&&styles.length>0,label+' has inline blocks to protect');
 for(const hash of scripts)assert.ok(directive(policy,'script-src').includes(hash),label+' allows its inline script by hash');
 for(const hash of styles)assert.ok(directive(policy,'style-src').includes(hash),label+' allows its inline style by hash');
 assert.equal(response.headers.get('referrer-policy'),'no-referrer',label);
}

test('the development review page and the approval review page need no unsafe-inline',async()=>{
 const control=createDevelopmentPlanes(new ApplicationStore({id:'demo',schemaVersion:1,revision:0,pages:[]}),'d'.repeat(32),'a'.repeat(32)).control;control.listen(0,'127.0.0.1');await once(control,'listening');
 const approval=createAgentApprovalServer({authenticate:()=>undefined,resolve:()=>undefined});approval.listen(0,'127.0.0.1');await once(approval,'listening');
 try{
  const development=await fetch(`http://127.0.0.1:${control.address().port}/development`);assert.equal(development.status,200);assertPolicy(development,await development.clone().text(),'development page');
  const review=await fetch(`http://127.0.0.1:${approval.address().port}/review`);assert.equal(review.status,200);assertPolicy(review,await review.clone().text(),'approval page');
 }finally{control.close();approval.close();}
});

test('the generated app serves its page with a strict policy and referrer policy',{timeout:20000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'app-mixer-csp-'));let server;
 try{
  const target=await createProject('csp-app',dir);
  server=spawn(process.execPath,['server.mjs'],{cwd:target,env:{...process.env,PORT:'0'},stdio:['ignore','pipe','pipe']});
  const url=await new Promise((resolve,reject)=>{let output='';server.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match)resolve(match[0]);});server.once('error',reject);server.once('exit',code=>reject(new Error('Server exited before startup: '+code)));});
  const page=await fetch(url);assert.equal(page.status,200);assertPolicy(page,await page.clone().text(),'generated page');
  const policy=page.headers.get('content-security-policy');assert.match(policy,/connect-src 'self'/);assert.match(policy,/worker-src 'self'/);
  const script=await fetch(url+'/renderer.mjs');assert.equal(script.status,200);assert.equal(script.headers.get('content-security-policy'),null,'only the page carries the policy');
 }finally{if(server){server.kill();await once(server,'exit').catch(()=>{});}await rm(dir,{recursive:true,force:true});}
});

// Real browser (opt-in, APP_MIXER_TEST_BROWSER=1): the policy must not block the pages' own scripts.
const browserBinary=process.env.CHROME_BIN||['/usr/bin/google-chrome','/usr/bin/chromium','C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(path=>existsSync(path));
async function devtools(url){const socket=new WebSocket(url);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});let next=0;const pending=new Map();socket.onmessage=event=>{const message=JSON.parse(event.data);if(message.id&&pending.has(message.id)){const {resolve,reject}=pending.get(message.id);pending.delete(message.id);if(message.error)reject(Error(message.error.message));else resolve(message.result);}};return {send:(method,params={})=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));}),close:()=>socket.close()};}
test('the review pages run their inline scripts under the policy without violations',{skip:process.env.APP_MIXER_TEST_BROWSER!=='1'?'set APP_MIXER_TEST_BROWSER=1 to run in a real browser':browserBinary?false:'no Chrome or Edge found; set CHROME_BIN'},async()=>{
 const control=createDevelopmentPlanes(new ApplicationStore({id:'demo',schemaVersion:1,revision:0,pages:[]}),'d'.repeat(32),'a'.repeat(32)).control;control.listen(0,'127.0.0.1');await once(control,'listening');
 const approval=createAgentApprovalServer({authenticate:()=>undefined,resolve:()=>undefined});approval.listen(0,'127.0.0.1');await once(approval,'listening');
 const profile=mkdtempSync(join(tmpdir(),'app-mixer-csp-browser-'));
 const pages=[[`http://127.0.0.1:${control.address().port}/development`,'load','status'],[`http://127.0.0.1:${approval.address().port}/review`,'load','message']];
 const browser=spawn(browserBinary,['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});
 let client;
 try{
  let port;for(let i=0;i<100&&!port;i++){try{port=readFileSync(join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];}catch{await new Promise(resolve=>setTimeout(resolve,100));}}
  // The port file can appear before the DevTools server accepts connections: retry until a page target is listed.
  let target;for(let i=0;i<100&&!target;i++){try{target=(await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item=>item.type==='page');}catch{}if(!target)await new Promise(resolve=>setTimeout(resolve,100));}
  assert.ok(target,'the browser listed a page target');
  client=await devtools(target.webSocketDebuggerUrl);await client.send('Page.enable');await client.send('Runtime.enable');await client.send('Log.enable');
  const problems=[];client.on?.('Log.entryAdded',()=>{});
  for(const [url,button,output] of pages){
   await client.send('Page.navigate',{url});await new Promise(resolve=>setTimeout(resolve,1500));
   // Clicking Load runs the page's own script: it writes a status message, which only happens if the inline script was allowed to run.
   const {result}=await client.send('Runtime.evaluate',{awaitPromise:true,returnByValue:true,expression:`(async()=>{document.getElementById('${button}').click();for(let i=0;i<40&&!document.getElementById('${output}').textContent;i++)await new Promise(r=>setTimeout(r,50));return document.getElementById('${output}').textContent;})()`});
   assert.ok(result.value&&result.value.length>0,url+' ran its script and reported a status: '+JSON.stringify(result.value));
  }
 }finally{
  const exited=browser.exitCode!==null||browser.signalCode!==null?Promise.resolve():once(browser,'exit');
  await client?.send('Browser.close').catch(()=>{});client?.close();
  await Promise.race([exited,new Promise(resolve=>setTimeout(resolve,5000))]);if(browser.exitCode===null&&browser.signalCode===null){browser.kill();await exited;}
  control.close();approval.close();
  try{rmSync(profile,{recursive:true,force:true,maxRetries:10,retryDelay:200});}catch{}
 }
});
