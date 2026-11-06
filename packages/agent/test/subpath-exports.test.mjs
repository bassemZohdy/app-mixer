import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';

const dist=fileURLToPath(new URL('../dist/',import.meta.url));
// Static import graph of a built module: every file reached through relative imports, and every package it imports.
function graph(entry){
 const files=new Set(),packages=new Set(),queue=[join(dist,entry)];
 while(queue.length){
  const file=queue.pop();if(files.has(file))continue;files.add(file);
  const text=readFileSync(file,'utf8');
  for(const match of text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)){
   const specifier=match[1]??match[2];
   if(specifier.startsWith('.'))queue.push(join(dirname(file),specifier));else packages.add(specifier.startsWith('@')?specifier.split('/').slice(0,2).join('/'):specifier.split('/')[0]);
  }
 }
 return {files,packages};
}
const heavy=['@langchain/core','@langchain/langgraph','@langchain/langgraph-checkpoint','@langchain/openai','@ag-ui/core','openai'];

test('the webhooks and stores entries never load the model, graph or AG-UI packages',()=>{
 for(const entry of ['webhooks.js','stores.js']){
  const {packages}=graph(entry);for(const name of heavy)assert.ok(!packages.has(name),`${entry} must not reach ${name}`);
 }
 assert.ok(heavy.some(name=>graph('index.js').packages.has(name)),'the root entry still carries them');
});

test('the entries re-export the same bindings as the root, without overlap, and together cover every light module',async()=>{
 const root=await import('../dist/index.js'),webhooks=await import('../dist/webhooks.js'),stores=await import('../dist/stores.js');
 for(const [name,entry] of [['webhooks',webhooks],['stores',stores]])for(const key of Object.keys(entry))assert.strictEqual(entry[key],root[key],`${name}.${key} is the root's ${key}`);
 const overlap=Object.keys(webhooks).filter(key=>key in stores);assert.deepEqual(overlap,[]);
 // Value exports of the root that come from light modules must be reachable from a subpath: only these heavy modules may be root-only.
 const heavyModules=await Promise.all(['transport','capability-tool','tool-model','configured-runtime','sqlite-checkpointer','agent-delegations','transport-tracing'].map(name=>import(`../dist/${name}.js`)));
 // These three are declared in the root module itself and need the model and graph packages.
 const rootOnly=new Set([...heavyModules.flatMap(module=>Object.keys(module)),'LangGraphAGUIAdapter','createOpenAIModel','validateRunInput']);
 const missing=Object.keys(root).filter(key=>!rootOnly.has(key)&&!(key in webhooks)&&!(key in stores));
 assert.deepEqual(missing,[],'every light export is on a subpath entry; add new exports to src/webhooks.ts or src/stores.ts');
});

test('the package manifest exposes the subpaths and the root',()=>{
 const manifest=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
 assert.deepEqual(Object.keys(manifest.exports),['.','./webhooks','./stores']);
 for(const [subpath,file] of [['./webhooks','webhooks'],['./stores','stores'],['.','index']]){assert.equal(manifest.exports[subpath].import,`./dist/${file}.js`);assert.equal(manifest.exports[subpath].types,`./dist/${file}.d.ts`);}
});
