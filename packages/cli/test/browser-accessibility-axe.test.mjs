// Runs the axe-core accessibility rules (WCAG 2.0 to 2.2 A and AA, plus axe's best practices) against the page a freshly
// generated app serves, in a real browser. The generated server's content security policy allows scripts from its own
// origin, so a small same-origin proxy adds axe to the page without weakening the policy for the page's own code.
// Opt-in: APP_MIXER_TEST_BROWSER=1 with headless Chrome or Edge (CHROME_BIN, or found in the usual install location).
// This checks what an automated rule set can: it does not replace testing with a screen reader.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {existsSync,readFileSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {once} from 'node:events';
import {createProject} from '../dist/index.js';

const browserBinary=process.env.CHROME_BIN||['/usr/bin/google-chrome','/usr/bin/chromium','C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(path=>existsSync(path));
const enabled=process.env.APP_MIXER_TEST_BROWSER==='1';

// Runs inside the page once the application has rendered, then reports.
const runner=`
const rules=['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa','best-practice'];
const waitFor=async(check,ms)=>{const end=Date.now()+ms;while(Date.now()<end){if(check())return true;await new Promise(r=>setTimeout(r,100));}return false;};
const rendered=await waitFor(()=>document.getElementById('pages')?.children.length>0,15000);
const results=await axe.run(document,{runOnly:{type:'tag',values:rules}});
const summarize=item=>({id:item.id,impact:item.impact,help:item.help,nodes:item.nodes.map(node=>({target:node.target.join(' '),html:node.html.slice(0,160),summary:node.failureSummary?.slice(0,300)}))});
await fetch('/axe-result',{method:'POST',body:JSON.stringify({rendered,version:axe.version,passes:results.passes.length,violations:results.violations.map(summarize),incomplete:results.incomplete.map(item=>({id:item.id,impact:item.impact,nodes:item.nodes.length}))})});
`;

test('the generated app has no axe-core accessibility violations in a real browser',{skip:!enabled?'set APP_MIXER_TEST_BROWSER=1 to run in a real browser':browserBinary?false:'no Chrome or Edge found; set CHROME_BIN',timeout:240000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'app-mixer-axe-')),require=createRequire(import.meta.url),axeSource=readFileSync(require.resolve('axe-core/axe.min.js'));
 let app,proxy,report;
 try{
  const target=await createProject('axe-app',dir);
  app=spawn(process.execPath,['server.mjs'],{cwd:target,env:{...process.env,PORT:'0'},stdio:['ignore','pipe','pipe']});app.stderr.resume();
  const appUrl=await new Promise((resolve,reject)=>{let out='';const timer=setTimeout(()=>reject(Error('The generated app did not start: '+out)),20000);app.stdout.on('data',chunk=>{out+=chunk;const match=out.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});app.once('exit',code=>{clearTimeout(timer);reject(Error('The generated app exited with '+code+': '+out));});});
  let waiting=[];
  proxy=createServer(async(req,res)=>{
   if(req.url==='/axe.min.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(axeSource);return;}
   if(req.url==='/axe-run.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(runner);return;}
   if(req.url==='/wait'){const done=()=>{res.writeHead(204);res.end();};if(report!==undefined)done();else waiting.push(done);return;}
   if(req.url==='/axe-result'&&req.method==='POST'){let body='';for await(const chunk of req)body+=chunk;report=JSON.parse(body);res.writeHead(204);res.end();for(const done of waiting.splice(0))done();return;}
   if(req.method!=='GET'){res.writeHead(405);res.end();return;}
   try{
    const upstream=await fetch(appUrl+req.url,{redirect:'error'}),headers={};for(const name of ['content-type','content-security-policy','cache-control','x-content-type-options'])if(upstream.headers.has(name))headers[name]=upstream.headers.get(name);
    let body=Buffer.from(await upstream.arrayBuffer());
    // The page is served unchanged except for three tags before </html>; its scripts keep their hashes.
    if(req.url==='/'&&/text\/html/.test(headers['content-type']??''))body=Buffer.from(body.toString('utf8').replace(/<\/html>\s*$/i,'<script src="/axe.min.js"></script><script type="module" src="/axe-run.js"></script><img src="/wait" alt=""></html>'));
    res.writeHead(upstream.status,headers);res.end(body);
   }catch{res.writeHead(502);res.end();}
  });
  proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
  const profile=join(dir,'profile');
  await new Promise((resolve,reject)=>execFile(browserBinary,['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--user-data-dir='+profile,'--dump-dom',`http://127.0.0.1:${proxy.address().port}/`],{timeout:120000,maxBuffer:8*1024*1024},error=>error?reject(error):resolve()));
  assert.ok(report,'the page reported no axe results');
  assert.equal(report.rendered,true,'the application rendered before axe ran');
  t.diagnostic(`axe-core ${report.version}: ${report.passes} rules passed, ${report.violations.length} violated, ${report.incomplete.length} need review (${report.incomplete.map(item=>item.id).join(', ')||'none'})`);
  const text=report.violations.map(item=>`${item.id} (${item.impact}): ${item.help}\n${item.nodes.map(node=>`    ${node.target}\n      ${node.html}\n      ${(node.summary??'').replaceAll('\n','\n      ')}`).join('\n')}`).join('\n');
  assert.equal(report.violations.length,0,'accessibility violations:\n'+text);
 }finally{
  proxy?.closeAllConnections?.();proxy?.close();
  if(app&&app.exitCode===null){const exited=once(app,'exit');app.kill();await exited;}
  await rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:250});
 }
});
