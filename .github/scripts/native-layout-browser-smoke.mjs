import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';

if(!process.env.REACT_SMOKE_DEPS)throw Error('REACT_SMOKE_DEPS is required');
const deps=resolve(process.env.REACT_SMOKE_DEPS),require=createRequire(join(deps,'package.json'));
const esbuild=require('esbuild'),dir=await mkdtemp(join(tmpdir(),'app-mixer-native-layout-'));
try{
  await esbuild.build({entryPoints:['.github/scripts/native-layout-browser-fixture.mjs'],bundle:true,platform:'browser',format:'iife',outfile:join(dir,'fixture.js'),nodePaths:[join(deps,'node_modules')],logLevel:'silent'});
  await writeFile(join(dir,'index.html'),'<html><body><div id="host" style="width:240px"></div><script src="fixture.js"></script></body></html>');
  const {stdout}=await promisify(execFile)(process.env.CHROME_BIN||'google-chrome',['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--virtual-time-budget=10000','--dump-dom',pathToFileURL(join(dir,'index.html')).href],{timeout:30000,maxBuffer:1024*1024});
  const result=stdout.match(/data-result="([^"]+)"/)?.[1],detail=stdout.match(/data-error="([^"]+)"/)?.[1];
  assert.equal(result,'pass',`React Native browser layout check failed: ${detail??'no result before the browser stopped'}`);
}finally{await rm(dir,{recursive:true,force:true});}
