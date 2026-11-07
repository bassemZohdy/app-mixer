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
 const internal=new Set(['APP_MIXER_TEST_PHASE','APP_MIXER_TEST_SCHEMA','APP_MIXER_TEST_OTEL_EXPORT','APP_MIXER_TEST_ALERT_EXPORT']),guide=read('CONTRIBUTING.md');
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

test('the Data Plane image installs only its workspaces, has a healthcheck and CI bounds its size',()=>{
 const dockerfile=read('Dockerfile.data-plane'),workflow=read('.github/workflows/kubernetes.yml');
 assert.match(dockerfile,/npm ci --workspace @app-mixer\/core --workspace @app-mixer\/web/);assert.doesNotMatch(dockerfile,/npm ci\s*&&/,'no whole-workspace install');
 assert.doesNotMatch(dockerfile,/npm run build\s*&&|npm run build --workspaces/,'only core and web are built');
 assert.match(dockerfile,/^HEALTHCHECK /m);assert.match(workflow,/docker image inspect app-mixer-data-plane:test[^\n]*\.Size/);assert.match(workflow,/test "\$size" -le \d+/);
});

test('the shared TypeScript configuration keeps its strictness flags',()=>{
 const options=JSON.parse(read('tsconfig.base.json')).compilerOptions;
 for(const flag of ['strict','noFallthroughCasesInSwitch','noImplicitOverride','exactOptionalPropertyTypes','verbatimModuleSyntax'])assert.equal(options[flag],true,flag);
});

test('dependency updates are automated and production vulnerabilities fail CI',()=>{
 const dependabot=read('.github/dependabot.yml');for(const ecosystem of ['npm','github-actions','docker'])assert.match(dependabot,new RegExp('package-ecosystem: '+ecosystem));
 assert.match(dependabot,/interval: weekly/);assert.match(read('.github/workflows/ci.yml'),/run: npm audit --omit=dev/);
});

test('the lint baseline is configured, scripted and run in CI',()=>{
 const config=read('eslint.config.mjs');for(const rule of ['no-floating-promises','no-misused-promises','await-thenable','no-unused-vars'])assert.match(config,new RegExp(rule));
 assert.equal(JSON.parse(read('package.json')).scripts.lint,'eslint "packages/*/src/**/*.ts"');assert.match(read('.github/workflows/ci.yml'),/run: npm run lint/);assert.ok(existsSync(join(root,'.editorconfig')));
});

test('CI caches the pinned Docker images the container tests start',async()=>{
 const {execFileSync}=await import('node:child_process');
 const images=execFileSync(process.execPath,[join(root,'.github/scripts/docker-images.mjs')],{encoding:'utf8'}).trim().split('\n');
 assert.ok(images.length>=5,'found '+images.length+' images');
 for(const image of images)assert.match(image,/@sha256:[a-f0-9]{64}$|:[0-9][A-Za-z0-9._-]*$/,image+' is pinned to a version or digest');
 for(const name of ['keycloak','seaweedfs','opentelemetry-collector','prometheus','alertmanager'])assert.ok(images.some(image=>image.includes(name)),name+' is cached');
 const workflow=read('.github/workflows/ci.yml');assert.match(workflow,/uses: actions\/cache@v4\s*\n\s+with:\s*\n\s+path: ~\/docker-images/);assert.match(workflow,/docker load -i/);assert.match(workflow,/docker save -o/);
});

test('tests poll conditions with a deadline instead of adding fixed sleeps',async()=>{
 const {waitFor}=await import('../../../scripts/wait-for.mjs');
 let ready=false;setTimeout(()=>{ready=true;},30);assert.equal(await waitFor(()=>ready,{timeoutMs:2000,message:'ready'}),true);
 assert.equal(await waitFor(async()=>'async value'),'async value');
 const started=Date.now();await assert.rejects(waitFor(()=>false,{timeoutMs:60,intervalMs:5,message:'never'}),/Timed out after 60 ms waiting for never/);assert.ok(Date.now()-started<2000);
 await assert.rejects(waitFor(()=>{throw new Error('probe failed');},{timeoutMs:30,message:'probe'}),error=>/probe/.test(error.message)&&error.cause?.message==='probe failed','the last probe error is kept as the cause');
 // A ratchet: the number of inline sleeps in test files may only go down. Poll with waitFor from scripts/wait-for.mjs instead.
 let sleeps=0;for(const name of ['core','agent','cli','web','native'])for(const file of readdirSync(join(root,'packages',name,'test')).filter(file=>file.endsWith('.test.mjs')))sleeps+=(readFileSync(join(root,'packages',name,'test',file),'utf8').match(/new Promise\(\(?\w+\)?=>setTimeout\(\w+,/g)??[]).length;
 assert.ok(sleeps<=63,`${sleeps} inline sleeps in tests (limit 63): use waitFor and lower the limit when you remove one`);
});

test('the record editor preview shares its schema parser with the template through the sync script',async()=>{
 const {synced}=await import('../../../scripts/sync-editor-previews.mjs'),template=read('packages/cli/templates/data-editor.mjs'),preview=read('packages/core/src/data-editor-preview.ts');
 assert.equal(synced(template,preview),preview.replaceAll('\r\n','\n'),'the preview is current; run npm run previews');
 const changed=template.replace("function normalizeFields(","function normalizeFields(/* edited */ ");assert.notEqual(changed,template);
 assert.match(synced(changed,preview),/function normalizeFields\(\/\* edited \*\//,'an edit to the template reaches the preview');
 const escaped=synced(template.replace("function normalizeFields(","function normalizeFields(a=`x${1}`,"),preview);assert.ok(escaped.includes('a='+String.fromCharCode(92)+'`x'+String.fromCharCode(92)+'${1}'+String.fromCharCode(92)+'`'),'backticks and interpolation are escaped for the template literal');
});

test('the Grafana dashboard only queries metrics and labels the code exports and its layout is valid',()=>{
 const dashboard=JSON.parse(read('deploy/observability/grafana-dashboard.json')),sources=['packages/core/src/data-plane-metrics.ts','packages/agent/src/agent-run-metrics.ts','packages/agent/src/agent-metrics-server.ts'].map(read).join('\n');
 const exported=new Set([...sources.matchAll(/app_mixer_[a-z_]+/g)].map(match=>match[0]));
 const panels=dashboard.panels,ids=panels.map(panel=>panel.id);assert.equal(new Set(ids).size,ids.length,'panel IDs are unique');assert.ok(panels.filter(panel=>panel.type!=='row').length>=10);
 for(const panel of panels){const {x,y,w,h}=panel.gridPos;assert.ok(x>=0&&w>=1&&x+w<=24&&y>=0&&h>=1,`panel ${panel.id} fits the 24-column grid`);}
 const labelsOf={app_mixer_data_plane_requests_total:['route','outcome','status_class'],app_mixer_data_plane_request_duration_seconds_bucket:['route','outcome','le'],app_mixer_agent_runs:['status','archived'],app_mixer_agent_actions:['status'],app_mixer_agent_approvals:['status'],app_mixer_agent_notice_deliveries:['status'],app_mixer_agent_oldest_overdue_seconds:['kind'],app_mixer_agent_overdue_runs:['kind']};
 let queries=0;
 for(const panel of panels.filter(item=>item.type!=='row'))for(const target of panel.targets){
  queries++;const expression=target.expr;
  for(const metric of expression.match(/app_mixer_[a-z_]+/g))assert.ok(exported.has(metric),`${metric} in "${expression}" is exported`);
  for(const match of expression.matchAll(/(app_mixer_[a-z_]+)\{([^}]*)\}/g)){const [,metric,body]=match;
   for(const label of body.split(',').map(part=>part.split(/=~?|!=/)[0].trim()).filter(Boolean))assert.ok(label==='job'||(labelsOf[metric]??[]).includes(label),`${label} is a label of ${metric}`);
  }
  assert.equal([...expression].filter(c=>c==='(').length,[...expression].filter(c=>c===')').length,'balanced parentheses in '+expression);
 }
 assert.ok(queries>=12);assert.equal(dashboard.templating.list[0].name,'job');
});
