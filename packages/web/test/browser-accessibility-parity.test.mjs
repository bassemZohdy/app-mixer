// The shared accessibility and typography reference (adapters/flutter/test/fixtures/accessibility.json), checked
// on the web renderer in a real headless Chrome or Edge: roles, names, heading levels, values, multiline and
// enabled state come from the browser's own accessibility tree (DevTools protocol), and font sizes and weights
// from computed styles. The Flutter widgets are checked against the same file.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const browserBinary=process.env.CHROME_BIN||['/usr/bin/google-chrome','/usr/bin/chromium','C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(path=>existsSync(path));
const enabled=process.env.APP_MIXER_TEST_BROWSER==='1',fixture=JSON.parse(readFileSync(new URL('../../../adapters/flutter/test/fixtures/accessibility.json',import.meta.url),'utf8'));
const renderer=readFileSync(new URL('../dist/index.js',import.meta.url));
const page=`<!doctype html><html lang="en"><meta charset="utf-8"><title>Accessibility parity</title><main id="app"></main>
<script type="module">
import {A2UIRenderer,basicRegistry} from '/renderer.js';
const result={};
try{
 const renderer=new A2UIRenderer(document.getElementById('app'),basicRegistry(),()=>{});
 for(const message of ${JSON.stringify(fixture.messages)})renderer.apply(message);
 result.typography=[...document.querySelectorAll('#app *')].filter(element=>element.children.length===0&&element.textContent.trim()).map(element=>{const style=getComputedStyle(element);return {text:element.textContent,fontSize:parseFloat(style.fontSize),weight:Number(style.fontWeight)};});
}catch(error){result.fatal=error.message;}
await fetch('/result',{method:'POST',body:JSON.stringify(result)});
</script>`;

/** Minimal DevTools protocol client over the browser's page WebSocket. */
async function devtools(url){const socket=new WebSocket(url);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});let next=0;const pending=new Map();socket.onmessage=event=>{const message=JSON.parse(event.data);if(message.id&&pending.has(message.id)){const {resolve,reject}=pending.get(message.id);pending.delete(message.id);if(message.error)reject(Error(message.error.message));else resolve(message.result);}};return {send:(method,params={})=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));}),close:()=>socket.close()};}
const property=(node,name)=>node.properties?.find(item=>item.name===name)?.value?.value;

test('the web renderer matches the shared accessibility and typography reference in a real browser',{skip:!enabled?'set APP_MIXER_TEST_BROWSER=1 to run in a real browser':browserBinary?false:'no Chrome or Edge found; set CHROME_BIN',timeout:120000},async t=>{
 let resolveResult;const posted=new Promise(resolve=>resolveResult=resolve);
 const server=createServer((req,res)=>{if(req.url==='/renderer.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(renderer);}else if(req.url==='/result'&&req.method==='POST'){let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{res.end();resolveResult(JSON.parse(body));});}else{res.writeHead(200,{'content-type':'text/html'});res.end(page);}});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const profile=mkdtempSync(join(tmpdir(),'app-mixer-a11y-')),url=`http://127.0.0.1:${server.address().port}/`;
 const browser=spawn(browserBinary,['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--force-device-scale-factor=1','--remote-debugging-port=0',`--user-data-dir=${profile}`,url],{stdio:'ignore'});
 let client;
 try{
  const result=await posted;assert.equal(result.fatal,undefined,result.fatal);
  for(const expected of fixture.typography){const actual=result.typography.find(item=>item.text===expected.text);assert.ok(actual,expected.text);assert.ok(Math.abs(actual.fontSize-expected.fontSize)<0.01,`${expected.text} font size ${actual.fontSize}`);assert.equal(actual.weight>=600,expected.bold,`${expected.text} weight ${actual.weight}`);}
  let port;for(let i=0;i<100&&!port;i++){try{port=readFileSync(join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];}catch{await new Promise(resolve=>setTimeout(resolve,100));}}
  const targets=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(),target=targets.find(item=>item.type==='page'&&item.url===url);
  client=await devtools(target.webSocketDebuggerUrl);await client.send('Accessibility.enable');
  const {nodes}=await client.send('Accessibility.getFullAXTree'),named=nodes.filter(node=>!node.ignored&&node.name?.value);
  const summary=[];
  for(const expected of fixture.semantics){
   const matches=named.filter(node=>node.name.value===expected.name),interactive=matches.find(node=>['heading','button','textbox'].includes(node.role?.value));
   if(expected.role==='text'){assert.equal(interactive,undefined,`${expected.name} is plain text`);assert.ok(matches.some(node=>node.role?.value==='StaticText'),`${expected.name} is exposed as text`);summary.push(`${expected.name}: text`);continue;}
   assert.ok(interactive,`${expected.name} has role ${expected.role}`);assert.equal(interactive.role.value,expected.role,expected.name);
   if(expected.level!==undefined)assert.equal(property(interactive,'level'),expected.level,`${expected.name} level`);
   if(expected.value!==undefined)assert.equal(interactive.value?.value,expected.value,`${expected.name} value`);
   if(expected.multiline!==undefined)assert.equal(property(interactive,'multiline')===true,expected.multiline,`${expected.name} multiline`);
   if(expected.enabled!==undefined)assert.equal(property(interactive,'disabled')===true,!expected.enabled,`${expected.name} enabled`);
   summary.push(`${expected.name}: ${interactive.role.value}${expected.level?' '+property(interactive,'level'):''}`);
  }
  t.diagnostic(summary.join(', '));
 }finally{client?.close();browser.kill();await once(browser,'exit').catch(()=>{});await new Promise(resolve=>server.close(resolve));rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
});
