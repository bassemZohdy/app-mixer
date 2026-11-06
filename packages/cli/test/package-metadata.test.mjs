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
