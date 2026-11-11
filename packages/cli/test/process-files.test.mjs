import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,readdirSync,statSync} from 'node:fs';
import {join,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../../',import.meta.url)),read=path=>readFileSync(join(root,path),'utf8');
function files(directory){return readdirSync(directory).flatMap(name=>{if(['node_modules','dist','.git'].includes(name))return[];const path=join(directory,name);return statSync(path).isDirectory()?files(path):[path];});}

test('contributor and security process files exist',()=>{
 for(const path of ['CONTRIBUTING.md','SECURITY.md','.nvmrc','.github/CODEOWNERS','.github/pull_request_template.md','.github/ISSUE_TEMPLATE/bug_report.md','.github/ISSUE_TEMPLATE/feature_request.md'])assert.ok(existsSync(join(root,path)),path+' exists');
 assert.match(read('.nvmrc'),/^22\s*$/);
});

test('CONTRIBUTING documents every opt-in test variable that a test or workflow reads',()=>{
 const found=new Set();
 for(const path of [...files(join(root,'packages')),...files(join(root,'adapters')),...files(join(root,'.github'))].filter(path=>/\.(mjs|ts|js|yml)$/.test(path)))for(const match of readFileSync(path,'utf8').matchAll(/APP_MIXER_TEST_[A-Z0-9_]+/g))found.add(match[0]);
 // Variables the tests pass to their own child processes or fixtures are internal.
 const internal=new Set(['APP_MIXER_TEST_PHASE','APP_MIXER_TEST_SCHEMA','APP_MIXER_TEST_OTEL_EXPORT','APP_MIXER_TEST_ALERT_EXPORT','APP_MIXER_TEST_DB','APP_MIXER_TEST_LEASE','APP_MIXER_TEST_PROVIDER','APP_MIXER_TEST_OPERATION','APP_MIXER_TEST_AGENT','APP_MIXER_TEST_CALL_ID','APP_MIXER_TEST_TERMINAL']),guide=read('CONTRIBUTING.md');
 assert.ok(found.has('APP_MIXER_TEST_POSTGRES_URL'));
 for(const name of found)if(!internal.has(name))assert.ok(guide.includes(name),name+' is documented in CONTRIBUTING.md');
 for(const workflow of readdirSync(join(root,'.github/workflows')).filter(name=>/^(kubernetes|agent-pod-recovery)\.yml$/.test(name)))assert.ok(guide.includes(workflow.replace('.yml','')),workflow+' is mentioned');
});

test('workflows cancel superseded runs, bound every job and exercise the device and cluster checks on main and weekly',()=>{
 const directory=join(root,'.github/workflows');
 assert.match(read('.github/workflows/ci.yml'),/concurrency:\s*\n\s+group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\s*\n\s+cancel-in-progress: true/);
 for(const name of readdirSync(directory).filter(file=>file.endsWith('.yml'))){
  const text=readFileSync(join(directory,name),'utf8').replaceAll('\r\n','\n'),jobs=text.slice(text.indexOf('\njobs:')).match(/^  [a-z0-9-]+:\n/gm)??[];
  assert.ok(jobs.length>0,name+' has jobs');assert.equal((text.match(/^    timeout-minutes: \d+$/gm)??[]).length,jobs.length,name+': every job has timeout-minutes');
  if(name!=='ci.yml'){assert.match(text,/^  push:\n    branches: \[main\]$/m,name+' runs on pushes to main');assert.match(text,/^  schedule:\n    - cron: '[^']+'$/m,name+' runs weekly');}
 }
});

test('every document under docs is reachable from the README and the generated index is current',async()=>{
 const {render}=await import(new URL('../../../scripts/docs-index.mjs',import.meta.url));
 assert.equal(read('docs/README.md').replaceAll('\r\n','\n'),render(),'docs/README.md is out of date; run npm run docs');
 const seen=new Set(),queue=[join(root,'README.md')];
 while(queue.length){
  const file=queue.pop();if(seen.has(file))continue;seen.add(file);
  for(const match of readFileSync(file,'utf8').matchAll(/\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g)){if(/^[a-z]+:/i.test(match[1]))continue;const target=join(file,'..',match[1]);if(existsSync(target))queue.push(target);}
 }
 const norm=path=>path.split(sep).join('/');
 const unreachable=files(join(root,'docs')).filter(path=>path.endsWith('.md')&&![...seen].some(item=>norm(item)===norm(path)));
 assert.deepEqual(unreachable.map(path=>norm(path).slice(norm(root).length)),[]);
});

test('dependency updates are automated and production vulnerabilities fail CI',()=>{
 const dependabot=read('.github/dependabot.yml');for(const ecosystem of ['npm','github-actions','docker'])assert.match(dependabot,new RegExp('package-ecosystem: '+ecosystem));
 assert.match(dependabot,/interval: weekly/);assert.match(read('.github/workflows/ci.yml'),/run: npm audit --omit=dev/);
});

// FIX-001: CONTRIBUTING.md must describe this branch, not another one.
const guide=()=>read('CONTRIBUTING.md').replaceAll('\r\n','\n');
test('FIX-001 every npm script CONTRIBUTING names exists in package.json',()=>{
 const scripts=Object.keys(JSON.parse(read('package.json')).scripts),missing=[...new Set([...guide().matchAll(/npm run ([\w:-]+)/g)].map(match=>match[1]))].filter(name=>!scripts.includes(name));
 assert.deepEqual(missing,[],'npm scripts named in CONTRIBUTING.md but absent from package.json');
});
test('FIX-001 every file CONTRIBUTING names exists',()=>{
 const names=new Set(files(root).map(path=>path.split(sep).pop())),missing=[...new Set([...guide().matchAll(/[\w.@/-]+\.(?:mjs|cjs|js|ts|json|yml|md)\b/g)].map(match=>match[0]))].filter(word=>word!=='Node.js'&&(word.includes('/')?!existsSync(join(root,word)):!names.has(word)));
 assert.deepEqual(missing,[],'files named in CONTRIBUTING.md but absent from the repository');
});
test('FIX-001 CONTRIBUTING repeats no sentence',()=>{
 const seen=new Set(),repeated=new Set();
 for(const raw of guide().split(/\n|(?<=[.!?])\s+/)){const sentence=raw.replace(/\s+/g,' ').trim();if(sentence.length<=40)continue;if(seen.has(sentence))repeated.add(sentence);seen.add(sentence);}
 assert.deepEqual([...repeated],[],'sentences that appear more than once in CONTRIBUTING.md');
});

// TASK-002.1.7: the lint baseline.
test('TASK-002.1.7 the lint baseline is configured, scripted, documented and run in CI',()=>{
 const config=read('eslint.config.mjs');
 for(const rule of ['no-floating-promises','no-misused-promises','await-thenable','no-unused-vars'])assert.ok(config.includes(rule),rule+' is enabled');
 assert.ok(!config.includes('eslint-disable'),'no rule is switched off by a comment');
 const manifest=JSON.parse(read('package.json'));
 assert.equal(manifest.scripts.lint,'eslint "packages/*/src/**/*.ts"');
 for(const name of ['eslint','typescript-eslint'])assert.ok(manifest.devDependencies[name],name+' is a dev dependency');
 assert.ok(read('.github/workflows/ci.yml').includes('run: npm run lint'),'CI runs the lint');
 assert.ok(read('CONTRIBUTING.md').includes('npm run lint'),'CONTRIBUTING names the script');
 assert.ok(existsSync(join(root,'.editorconfig')),'.editorconfig exists');
});
