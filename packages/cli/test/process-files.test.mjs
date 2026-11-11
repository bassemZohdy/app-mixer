import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,readdirSync,statSync} from 'node:fs';
import {join,relative,sep} from 'node:path';
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

// TASK-002.2.4
test('the record editor preview shares its schema parser with the template through the sync script',async()=>{
 const {synced}=await import('../../../scripts/sync-editor-previews.mjs'),template=read('packages/cli/templates/data-editor.mjs'),preview=read('packages/core/src/data-editor-preview.ts');
 assert.equal(synced(template,preview),preview.replaceAll('\r\n','\n'),'the preview is current; run npm run previews');
 const changed=template.replace("function normalizeFields(","function normalizeFields(/* edited */ ");assert.notEqual(changed,template);
 assert.match(synced(changed,preview),/function normalizeFields\(\/\* edited \*\//,'an edit to the template reaches the preview');
 const escaped=synced(template.replace("function normalizeFields(","function normalizeFields(a=`x${1}`,"),preview);assert.ok(escaped.includes('a='+String.fromCharCode(92)+'`x'+String.fromCharCode(92)+'${1}'+String.fromCharCode(92)+'`'),'backticks and interpolation are escaped for the template literal');
});

// FIX-025: a force-deleted pod can still hold a lock for a moment, so a raw connection must wait for it instead of failing at once.
test('FIX-025 every raw database open in the pod recovery scripts sets a busy timeout first',()=>{
 const directory=join(root,'deploy/kubernetes/test-support/agent-recovery'),offenders=[];let opens=0;
 for(const name of readdirSync(directory).filter(file=>file.endsWith('.mjs'))){
  const text=readFileSync(join(directory,name),'utf8').replaceAll('\r\n','\n');
  for(const match of text.matchAll(/(\w+)=new DatabaseSync\(/g)){opens++;if(!new RegExp(match[1]+"\\.exec\\('PRAGMA busy_timeout=\\d+'\\)").test(text.slice(match.index)))offenders.push(name);}
 }
 assert.ok(opens>=2,'the scripts open the database directly ('+opens+' opens)');
 assert.deepEqual(offenders,[],'scripts that open the database without a busy timeout');
});

test('TASK-002.6.1 every ADR file is listed in the ADR table with its status and the core dependency decision is recorded',()=>{
 const table=read('docs/adr/README.md');
 for(const name of readdirSync(join(root,'docs/adr')).filter(file=>/^d{4}-.+.md$/.test(file)))assert.ok(table.includes('('+name+')'),name+' is listed in docs/adr/README.md');
 assert.ok(existsSync(join(root,'docs/adr/0011-core-depends-on-the-web-renderer.md')),'ADR 0011 records why core depends on the web renderer');
});

test('TASK-002.6.3 every repository path that the guides and the CHANGELOG name in code spans exists',()=>{
 const missing=[];
 const pages=[join(root,'README.md'),join(root,'CONTRIBUTING.md'),join(root,'CHANGELOG.md'),...files(join(root,'docs')).filter(path=>path.endsWith('.md')&&!path.includes(sep+'plans'+sep))];
 for(const page of pages)for(const match of readFileSync(page,'utf8').matchAll(/`((?:packages|deploy|scripts|\.github|adapters)\/[A-Za-z0-9_.\/-]+\.(?:mjs|cjs|js|ts|sh|ya?ml|json|md))`/g))if(!existsSync(join(root,match[1])))missing.push(match[1]+' (named in '+relative(root,page)+')');
 assert.deepEqual(missing,[],'paths named in the guides that are not in the repository');
});

test('TASK-002.6.5 each acceptance checklist section states what is verified once and lists no item twice',()=>{
 const sections=read('docs/acceptance-checklists.md').replaceAll('\r\n','\n').split(/^### /m).slice(1);
 assert.ok(sections.length>10);
 for(const section of sections){
  const lines=section.split('\n'),title=lines[0],items=lines.filter(line=>/^(- \*\*|  - \[)/.test(line));
  assert.ok(items.filter(line=>line.startsWith('- **Verified locally:**')).length<=1,title+' has more than one Verified locally line');
  const seen=new Set();for(const line of items){const opening=line.slice(0,90);assert.equal(seen.has(opening),false,title+' repeats: '+opening);seen.add(opening);}
 }
});

test('TASK-002.6.7 CI caches the pinned Docker images the container tests start',async()=>{
 const {execFileSync}=await import('node:child_process');
 const images=execFileSync(process.execPath,[join(root,'.github/scripts/docker-images.mjs')],{encoding:'utf8'}).trim().split('\n');
 assert.ok(images.length>=5,'found '+images.length+' images');
 for(const image of images)assert.match(image,/@sha256:[a-f0-9]{64}$|:[0-9][A-Za-z0-9._-]*$/,image+' is pinned to a version or digest');
 for(const name of ['hydra','grafana','opentelemetry-collector','prometheus','alertmanager','pgvector'])assert.ok(images.some(image=>image.includes(name)),name+' is cached');
 const workflow=read('.github/workflows/ci.yml').replaceAll('\r\n','\n');assert.match(workflow,/uses: actions\/cache@v4\s*\n\s+with:\s*\n\s+path: ~\/docker-images/);assert.match(workflow,/docker load -i/);assert.match(workflow,/docker save -o/);
});

test('TASK-002.7.2 the Data Plane image installs only its workspaces, has a healthcheck and CI bounds its size',()=>{
 const dockerfile=read('Dockerfile.data-plane'),workflow=read('.github/workflows/kubernetes.yml');
 assert.match(dockerfile,/npm ci --workspace @app-mixer\/core --workspace @app-mixer\/web/);assert.doesNotMatch(dockerfile,/npm ci\s*&&/,'no whole-workspace install');
 assert.doesNotMatch(dockerfile,/npm run build\s*&&|npm run build --workspaces/,'only core and web are built');
 assert.match(dockerfile,/^HEALTHCHECK /m);assert.match(workflow,/docker image inspect app-mixer-data-plane:test[^\n]*\.Size/);assert.match(workflow,/test "\$size" -le \d+/);
});

test('FIX-003 every Dockerfile builds from the same Node base image, newer than 22.13.0 and pinned by digest',()=>{
 const dockerfiles=['Dockerfile.data-plane','Dockerfile.local','deploy/kubernetes/test-support/agent-recovery/Dockerfile'],images=new Set();
 for(const path of dockerfiles){
  const from=read(path).replaceAll('\r\n','\n').split('\n').filter(line=>/^FROM /.test(line));
  assert.ok(from.length>0,path+' has a FROM line');
  for(const line of from){const match=/^FROM (node:(\d+)\.(\d+)\.(\d+)-bookworm-slim@sha256:[a-f0-9]{64})(?: AS \w+)?$/.exec(line);assert.ok(match,path+': the base image is a Node tag pinned by digest: '+line);images.add(match[1]);const [major,minor,patch]=match.slice(2).map(Number);assert.ok(major>22||(major===22&&(minor>13||(minor===13&&patch>0))),path+': Node is newer than 22.13.0');}
 }
 assert.equal(images.size,1,'every Dockerfile uses the same pinned image: '+[...images].join(', '));
});

test('TASK-013 no Markdown file repeats a line of more than 120 characters',()=>{
 const repeats=[];
 for(const file of files(root).filter(path=>path.endsWith('.md'))){
  const seen=new Map();
  readFileSync(file,'utf8').replaceAll('\r\n','\n').split('\n').forEach((line,index)=>{
   if(line.length<=120)return;
   const key=line.trim();
   if(seen.has(key))repeats.push(file.slice(root.length)+':'+(index+1)+' repeats line '+seen.get(key));else seen.set(key,index+1);
  });
 }
 assert.deepEqual(repeats,[],'repeated passages');
});
