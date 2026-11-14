import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {dirname,join} from 'node:path';

const dist=fileURLToPath(new URL('../dist/',import.meta.url)),hooks=pathToFileURL(fileURLToPath(new URL('./fixtures/record-provider-loads.mjs',import.meta.url))).href;
const providers=['@langchain/openai','openai','twilio'];
/** Every package that a built module reaches through static imports (dynamic imports are not followed). */
function staticPackages(entry){
 const files=new Set(),packages=new Set(),queue=[join(dist,entry)];
 while(queue.length){
  const file=queue.pop();if(files.has(file))continue;files.add(file);
  for(const match of readFileSync(file,'utf8').matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)){
   const specifier=match[1]??match[2];
   if(specifier.startsWith('.'))queue.push(join(dirname(file),specifier));else packages.add(specifier.startsWith('@')?specifier.split('/').slice(0,2).join('/'):specifier.split('/')[0]);
  }
 }
 return packages;
}
/** Runs a script in a fresh process that reports every provider SDK the module loader resolves. */
function run(script){
 const result=spawnSync(process.execPath,['--import',hooks,'--input-type=module','-e',script],{encoding:'utf8',timeout:60000,cwd:dirname(dist)});
 return {status:result.status,stdout:result.stdout,stderr:result.stderr,loaded:[...result.stderr.matchAll(/^PROVIDER-LOADED (\S+)$/gm)].map(match=>match[1])};
}

test('TASK-011 the root entry reaches no provider SDK through static imports',()=>{
 const packages=staticPackages('index.js');
 for(const name of providers)assert.ok(!packages.has(name),`the root entry must not statically import ${name}`);
 assert.ok(packages.has('@langchain/core'),'the root entry still carries the graph packages');
});

test('TASK-011 importing the root entry loads no provider SDK, and building a model does not either',()=>{
 const imported=run("const agent=await import('./dist/index.js');if(typeof agent.createOpenAIModel!=='function')throw Error('missing');agent.createOpenAIModel({model:'m',apiKey:'k'});agent.createOpenAIToolModel({model:'m',apiKey:'k'},[]);agent.createOpenAILimitedToolModel({model:'m',apiKey:'k'},[]);");
 assert.equal(imported.status,0,imported.stderr);assert.deepEqual(imported.loaded,[],'no provider SDK is loaded by importing or by constructing a model');
});

test('TASK-011 the first model call loads the OpenAI client, once, and still reports a provider failure normally',()=>{
 const used=run("const {createOpenAILimitedToolModel}=await import('./dist/index.js');const model=createOpenAILimitedToolModel({model:'m',apiKey:'k',baseURL:'http://127.0.0.1:9/v1'},[]);let failed=0;for(let i=0;i<2;i++){try{await model.invoke([{role:'user',content:'hi'}],{signal:AbortSignal.timeout(5000)});}catch(error){failed++;if(/Cannot find (module|package)/.test(String(error?.message)))throw error;}}if(failed!==2)throw Error('expected two provider failures');");
 assert.equal(used.status,0,used.stderr);assert.ok(used.loaded.includes('@langchain/openai'),'the OpenAI client loads on first use');assert.equal(used.loaded.filter(name=>name==='@langchain/openai').length,1,'it loads once');
});

test('TASK-011 each documented subpath resolves and an unknown subpath is refused',()=>{
 const resolved=run("for(const entry of ['@app-mixer/agent','@app-mixer/agent/webhooks','@app-mixer/agent/stores','@app-mixer/agent/dist/shared-run-experimental.js'])await import(entry);console.log('resolved');");
 assert.equal(resolved.status,0,resolved.stderr);assert.match(resolved.stdout,/resolved/);
 for(const entry of ['@app-mixer/agent/nope','@app-mixer/agent/dist/index.js','@app-mixer/agent/src/index.ts']){
  const refused=run(`try{await import('${entry}');console.log('imported');}catch(error){console.log(error.code);}`);
  assert.match(refused.stdout,/ERR_PACKAGE_PATH_NOT_EXPORTED/,entry+' is refused');
 }
 for(const entry of ['@app-mixer/agent/webhooks','@app-mixer/agent/stores']){
  const light=run(`await import('${entry}');`);assert.equal(light.status,0,light.stderr);assert.deepEqual(light.loaded,[],entry+' loads no provider SDK');
 }
});
