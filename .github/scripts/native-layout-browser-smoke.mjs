import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

if(!process.env.REACT_SMOKE_DEPS)throw Error('REACT_SMOKE_DEPS is required');
const deps=resolve(process.env.REACT_SMOKE_DEPS),require=createRequire(join(deps,'package.json'));
const esbuild=require('esbuild'),dir=await mkdtemp(join(tmpdir(),'app-mixer-native-layout-'));let browser,timer,resolveResult,rejectResult;
const result=new Promise((resolve,reject)=>{resolveResult=resolve;rejectResult=reject;});let script;
const server=createServer(async(req,res)=>{
  if(req.url==='/result'&&req.method==='POST'){const parts=[];for await(const part of req)parts.push(part);res.writeHead(204);res.end();resolveResult(Buffer.concat(parts).toString('utf8'));return;}
  if(req.url==='/fixture.js'){res.writeHead(200,{'content-type':'text/javascript; charset=utf-8'});res.end(script);return;}
  res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end('<html><body><div id="host" style="width:240px"></div><script src="fixture.js"></script></body></html>');
});
try{
  await esbuild.build({entryPoints:['.github/scripts/native-layout-browser-fixture.mjs'],bundle:true,platform:'browser',format:'iife',outfile:join(dir,'fixture.js'),nodePaths:[join(deps,'node_modules')],logLevel:'silent'});
  script=await readFile(join(dir,'fixture.js'));server.listen(0,'127.0.0.1');await once(server,'listening');
  browser=spawn(process.env.CHROME_BIN||'google-chrome',['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',`--user-data-dir=${join(dir,'profile')}`,`http://127.0.0.1:${server.address().port}/`],{stdio:['ignore','ignore','pipe']});
  browser.stderr.resume();browser.once('error',rejectResult);browser.once('exit',code=>rejectResult(Error(`Browser exited before reporting: ${code}`)));timer=setTimeout(()=>rejectResult(Error('Browser layout test timed out')),30000);
  assert.match(await result,/^pass:/);
}finally{
  clearTimeout(timer);if(browser&&browser.exitCode===null&&browser.signalCode===null){const stopped=once(browser,'exit');browser.kill();await stopped;}
  if(server.listening)await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200});
}
