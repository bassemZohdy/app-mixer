// Loads the generated page in headless Chrome or Edge at two widths and measures its layout.
// Opt-in: APP_MIXER_TEST_BROWSER=1 (CHROME_BIN, or found in the usual install location).
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {existsSync} from 'node:fs';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {createProject} from '../dist/index.js';

const browserBinary=process.env.CHROME_BIN||['/usr/bin/google-chrome','/usr/bin/chromium','C:\Program Files\Google\Chrome\Application\chrome.exe','C:\Program Files (x86)\Google\Chrome\Application\chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(path=>existsSync(path));
const enabled=process.env.APP_MIXER_TEST_BROWSER==='1';
const unbroken='W'.repeat(300);

// Runs inside the page once the application has rendered, then reports.
const runner=`
const host=document.getElementById('pages');
await new Promise(resolve=>{if(host.querySelector('input'))return resolve();const observer=new MutationObserver(()=>{if(host.querySelector('input')){observer.disconnect();resolve();}});observer.observe(host,{childList:true,subtree:true});setTimeout(resolve,15000);});
const root=document.documentElement,span=host.querySelector('label span'),field=host.querySelector('label input'),card=host.querySelector('section');
const gap=span&&field?field.getBoundingClientRect().top-span.getBoundingClientRect().bottom:null;
await fetch('/layout-result',{method:'POST',body:JSON.stringify({innerWidth,scrollWidth:root.scrollWidth,clientWidth:root.clientWidth,gap,cardBorder:card?getComputedStyle(card).borderTopWidth:null,text:host.textContent.includes('${unbroken}')})});
`;

async function measure(appUrl,width,dir){
 let report,waiting=[];
 const proxy=createServer(async(req,res)=>{
  if(req.url==='/layout-run.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(runner);return;}
  if(req.url==='/wait'){const done=()=>{res.writeHead(204);res.end();};if(report!==undefined)done();else waiting.push(done);return;}
  if(req.url==='/layout-result'&&req.method==='POST'){let body='';for await(const chunk of req)body+=chunk;report=JSON.parse(body);res.writeHead(204);res.end();for(const done of waiting.splice(0))done();return;}
  if(req.method!=='GET'){res.writeHead(405);res.end();return;}
  try{
   const upstream=await fetch(appUrl+req.url,{redirect:'error'}),headers={};for(const name of ['content-type','content-security-policy','cache-control','x-content-type-options'])if(upstream.headers.has(name))headers[name]=upstream.headers.get(name);
   let body=Buffer.from(await upstream.arrayBuffer());
   if(req.url==='/'&&/text\/html/.test(headers['content-type']??''))body=Buffer.from(body.toString('utf8').replace(/<\/html>\s*$/i,'<script type="module" src="/layout-run.js"></script><img src="/wait" alt=""></html>'));
   res.writeHead(upstream.status,headers);res.end(body);
  }catch{res.writeHead(502);res.end();}
 });
 proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
 try{
  await new Promise((resolve,reject)=>execFile(browserBinary,['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--user-data-dir='+join(dir,'profile'+width),`--window-size=${width},900`,'--dump-dom',`http://127.0.0.1:${proxy.address().port}/`],{timeout:120000,maxBuffer:8*1024*1024},error=>error?reject(error):resolve()));
 }finally{proxy.closeAllConnections?.();proxy.close();}
 assert.ok(report,'the page reported no layout');
 return report;
}

test('FIX-032 long unbroken text does not widen the page and fields and cards are spaced',{skip:!enabled?'set APP_MIXER_TEST_BROWSER=1 to run in a real browser':browserBinary?false:'no Chrome or Edge found; set CHROME_BIN',timeout:240000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'app-mixer-layout-'));let app;
 try{
  const target=await createProject('layout-app',dir);
  const definition={id:'layout-app',schemaVersion:1,revision:0,pages:[{id:'home',route:'/',title:'Home',components:[
   {id:'long',type:'Text',props:{text:unbroken}},
   {id:'name',type:'Input',props:{label:'Name',path:'/name'}},
   {id:'card',type:'Card',props:{title:'Card',text:'Body'}}]}]};
  await writeFile(join(target,'application.json'),JSON.stringify(definition));
  app=spawn(process.execPath,['server.mjs'],{cwd:target,env:{...process.env,PORT:'0'},stdio:['ignore','pipe','pipe']});app.stderr.resume();
  const appUrl=await new Promise((resolve,reject)=>{let out='';const timer=setTimeout(()=>reject(Error('The generated app did not start: '+out)),20000);app.stdout.on('data',chunk=>{out+=chunk;const match=out.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});app.once('exit',code=>reject(Error('exited '+code)));});
  for(const width of [950,400]){
   const report=await measure(appUrl,width,dir);
   assert.equal(report.text,true,`the long text rendered at ${width}`);
   assert.equal(report.scrollWidth,report.clientWidth,`page scrollWidth ${report.scrollWidth} exceeds clientWidth ${report.clientWidth} at ${width} (innerWidth ${report.innerWidth})`);
   assert.ok(report.gap>=4,`label and field are ${report.gap}px apart at ${width}`);
   assert.notEqual(report.cardBorder,'0px',`card has no outline at ${width}`);
  }
 }finally{
  if(app&&app.exitCode===null){const exited=once(app,'exit');app.kill();await exited;}
  await rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:250});
 }
});
