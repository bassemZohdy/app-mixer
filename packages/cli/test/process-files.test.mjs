import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,readdirSync,statSync} from 'node:fs';
import {join} from 'node:path';
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
