// Runs the axe-core accessibility rules (WCAG 2.0 to 2.2 A and AA, plus axe's best practices) against what the web renderer
// produces for the shared accessibility fixture (every text variant, labelled single-line and multiline fields, an enabled
// button, bound texts) in a real browser. Opt-in: APP_MIXER_TEST_BROWSER=1 with headless Chrome or Edge (CHROME_BIN, or
// found in the usual install location). Automated rules find a class of problem; they do not replace a screen reader test.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createServer} from 'node:http';
import {existsSync,readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const browserBinary=process.env.CHROME_BIN||['/usr/bin/google-chrome','/usr/bin/chromium','C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(path=>existsSync(path));
const enabled=process.env.APP_MIXER_TEST_BROWSER==='1',fixture=JSON.parse(readFileSync(new URL('../../../adapters/flutter/test/fixtures/accessibility.json',import.meta.url),'utf8'));
const renderer=readFileSync(new URL('../dist/index.js',import.meta.url)),axeSource=readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'));
const page=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Renderer accessibility</title><main id="app"></main>
<script src="/axe.min.js"></script>
<script type="module">
import {A2UIRenderer,basicRegistry} from '/renderer.js';
const result={};
try{
 const renderer=new A2UIRenderer(document.getElementById('app'),basicRegistry(),()=>{});
 for(const message of ${JSON.stringify(fixture.messages)})renderer.apply(message);
 const results=await axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa','best-practice']}});
 result.version=axe.version;result.passes=results.passes.length;result.incomplete=results.incomplete.map(item=>item.id);
 result.violations=results.violations.map(item=>({id:item.id,impact:item.impact,help:item.help,nodes:item.nodes.map(node=>({target:node.target.join(' '),html:node.html.slice(0,160),summary:(node.failureSummary??'').slice(0,300)}))}));
}catch(error){result.fatal=error.message;}
await fetch('/result',{method:'POST',body:JSON.stringify(result)});
</script><img src="/wait" alt="">`;

test('the web renderer output for the shared fixture has no axe-core accessibility violations in a real browser',{skip:!enabled?'set APP_MIXER_TEST_BROWSER=1 to run in a real browser':browserBinary?false:'no Chrome or Edge found; set CHROME_BIN',timeout:120000},async t=>{
 let report;const waiting=[];
 const server=createServer((req,res)=>{
  if(req.url==='/renderer.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(renderer);}
  else if(req.url==='/axe.min.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(axeSource);}
  else if(req.url==='/wait'){const done=()=>{res.writeHead(204);res.end();};if(report!==undefined)done();else waiting.push(done);}
  else if(req.url==='/result'&&req.method==='POST'){let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{report=JSON.parse(body);res.writeHead(204);res.end();for(const done of waiting.splice(0))done();});}
  else{res.writeHead(200,{'content-type':'text/html'});res.end(page);}
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const profile=mkdtempSync(join(tmpdir(),'app-mixer-axe-renderer-'));
 try{
  await new Promise((resolve,reject)=>execFile(browserBinary,['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--user-data-dir='+profile,'--dump-dom',`http://127.0.0.1:${server.address().port}/`],{timeout:90000,maxBuffer:8*1024*1024},error=>error?reject(error):resolve()));
  assert.ok(report,'the page reported no axe results');assert.equal(report.fatal,undefined,report.fatal);
  t.diagnostic(`axe-core ${report.version}: ${report.passes} rules passed, ${report.violations.length} violated, ${report.incomplete.length} need review (${report.incomplete.join(', ')||'none'})`);
  const text=report.violations.map(item=>`${item.id} (${item.impact}): ${item.help}\n${item.nodes.map(node=>`    ${node.target}\n      ${node.html}\n      ${node.summary.replaceAll('\n','\n      ')}`).join('\n')}`).join('\n');
  assert.equal(report.violations.length,0,'accessibility violations:\n'+text);
 }finally{server.closeAllConnections();server.close();rmSync(profile,{recursive:true,force:true,maxRetries:20,retryDelay:250});}
});
