import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

const root=fileURLToPath(new URL('../../../',import.meta.url)),packages=['core','web','cli','agent','native'];
const manifest=name=>JSON.parse(readFileSync(join(root,'packages',name,'package.json'),'utf8'));

test('every package declares its license, repository directory and published files',()=>{
 for(const name of packages){
  const json=manifest(name);assert.equal(json.license,'Apache-2.0',name);
  assert.equal(json.repository?.url,'git+https://github.com/bassemZohdy/app-mixer.git',name);assert.equal(json.repository?.directory,'packages/'+name,name);
  assert.ok(Array.isArray(json.files)&&json.files.includes('dist'),name+' publishes dist');assert.ok(!json.files.includes('src')&&!json.files.includes('test'),name+' does not publish sources or tests');
 }
 for(const name of ['core','web','agent','native'])assert.equal(manifest(name).types,'dist/index.d.ts',name);
});

test('workspace dependencies use one exact version everywhere',()=>{
 const versions=new Map(packages.map(name=>[manifest(name).name,manifest(name).version]));
 for(const name of packages)for(const [dependency,range] of Object.entries(manifest(name).dependencies??{}))if(versions.has(dependency))assert.equal(range,versions.get(dependency),`${name} depends on ${dependency} with ${range}`);
});

test('npm pack contains the built output and templates but no sources or tests',{timeout:120000},()=>{
 const expected={core:['dist/index.js','dist/index.d.ts'],web:['dist/index.js','catalog/v1/catalog.json'],cli:['dist/index.js','templates/data-editor.mjs'],agent:['dist/index.js'],native:['dist/index.js']};
 for(const name of packages){
  const run=spawnSync('npm',['pack','--dry-run','--json','--ignore-scripts'],{cwd:join(root,'packages',name),encoding:'utf8',shell:process.platform==='win32'});
  assert.equal(run.status,0,name+': '+run.stderr);const report=JSON.parse(run.stdout),entry=Array.isArray(report)?report[0]:Object.values(report)[0],paths=entry.files.map(file=>file.path);// npm 12 keys the report by package name, older versions return an array
  for(const path of expected[name])assert.ok(paths.includes(path),`${name} ships ${path}`);
  assert.ok(!paths.some(path=>/^(src|test|node_modules|device-test)\//.test(path)),`${name} ships no sources, tests or dependencies`);
 }
});

// TASK-002.1.6: one Node floor everywhere, and the dependency generations the suite is verified with.
test('TASK-002.1.6 the Node floor is 22.22.2 in engines, README, CONTRIBUTING, the CI matrix and every Docker base image',()=>{
 const text=path=>readFileSync(join(root,path),'utf8').replaceAll('\r\n','\n'),floor='22.22.2';
 assert.equal(JSON.parse(text('package.json')).engines.node,'>='+floor);
 assert.ok(text('README.md').includes('Requires Node.js '+floor+'+'),'README');
 assert.ok(text('CONTRIBUTING.md').includes('Use Node '+floor+' or later'),'CONTRIBUTING');
 assert.ok(text('.github/workflows/ci.yml').includes("node: ['"+floor+"', 22, 24]"),'CI matrix');
 for(const workflow of ['kubernetes.yml','kubernetes-node-recovery.yml'])assert.ok(text('.github/workflows/'+workflow).includes("node-version: '"+floor+"'"),workflow);
 for(const file of ['Dockerfile.data-plane','Dockerfile.local','deploy/kubernetes/test-support/agent-recovery/Dockerfile']){
  const bases=text(file).split('\n').filter(line=>line.startsWith('FROM node:'));
  assert.ok(bases.length>0,file+' has a Node base image');
  for(const line of bases)assert.ok(line.startsWith('FROM node:'+floor+'-bookworm-slim'),file+': '+line);
 }
});

test('TASK-002.1.6 jsdom 31 and OpenTelemetry API 1.10 are declared by every package that uses them',()=>{
 for(const name of ['web','cli','agent'])assert.equal({...manifest(name).devDependencies,...manifest(name).dependencies}.jsdom,'^31.0.0',name+' jsdom');
 for(const name of ['core','agent'])assert.equal(manifest(name).dependencies['@opentelemetry/api'],'1.10.0',name+' @opentelemetry/api');
 for(const dependency of ['@opentelemetry/context-async-hooks','@opentelemetry/core','@opentelemetry/sdk-trace'])assert.equal(manifest('core').devDependencies[dependency],'3.1.0',dependency);
});

// TASK-014: JSON.parse keeps the last of a repeated key, so a duplicate hides in a manifest unless the text is scanned.
function repeatedKeys(text){
 const repeats=[],stack=[];let index=0;
 const string=()=>{let end=index+1;while(text[end]!=='"'){if(text[end]===String.fromCharCode(92))end++;end++;}const value=JSON.parse(text.slice(index,end+1));index=end+1;return value;};
 while(index<text.length){
  const character=text[index];
  if(character==='{'){stack.push({keys:new Set(),expectKey:true});index++;}
  else if(character==='['){stack.push({array:true});index++;}
  else if(character==='}'||character===']'){stack.pop();index++;}
  else if(character==='"'){const top=stack.at(-1),value=string();if(top&&!top.array&&top.expectKey){if(top.keys.has(value))repeats.push(value);top.keys.add(value);top.expectKey=false;}}
  else{if(character===','&&stack.at(-1)&&!stack.at(-1).array)stack.at(-1).expectKey=true;index++;}
 }
 return repeats;
}

test('TASK-014 no manifest repeats a key, and the scan finds a repeat',()=>{
 assert.deepEqual(repeatedKeys('{"a":1,"b":{"a":2,"c":[{"a":1,"a":2}]},"a":3}'),['a','a']);
 assert.deepEqual(repeatedKeys('{"license":"MIT","name":"x","license":"MIT"}'),['license']);
 const offenders=[];
 for(const path of ['package.json',...packages.map(name=>'packages/'+name+'/package.json'),'adapters/angular/package.json'])for(const key of repeatedKeys(readFileSync(join(root,path),'utf8')))offenders.push(path+': '+key);
 assert.deepEqual(offenders,[],'repeated manifest keys');
});

test('TASK-014 CONTRIBUTING names the npm workspaces the root manifest declares',()=>{
 const workspaces=JSON.parse(readFileSync(join(root,'package.json'),'utf8')).workspaces,intro=readFileSync(join(root,'CONTRIBUTING.md'),'utf8').replaceAll('\r\n','\n').split('\n')[2];
 const named=[...intro.matchAll(/`((?:packages|adapters)\/\*)`/g)].map(match=>match[1]);
 assert.ok(named.length>0,'the introduction names the workspaces');
 for(const name of named)assert.ok(workspaces.includes(name),name+' is a workspace in package.json, not a standalone directory');
});
