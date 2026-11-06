import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createProject} from '../dist/index.js';
test('scaffolds runnable app',async()=>{const dir=await mkdtemp(join(tmpdir(),'app-mixer-'));try{const target=await createProject('demo-app',dir);const a=JSON.parse(await readFile(join(target,'application.json'),'utf8'));assert.equal(a.pages[0].route,'/');await assert.rejects(createProject('demo-app',dir),/exists/);}finally{await rm(dir,{force:true,recursive:true})}});
test('rejects path traversal',async()=>{await assert.rejects(createProject('../bad'),/Invalid/)});

// The command entry is detected by comparing paths, so it also works where argv[1] uses backslashes (Windows).
import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {fileURLToPath} from 'node:url';import {stat} from 'node:fs/promises';import {relative} from 'node:path';
const run=promisify(execFile),entry=fileURLToPath(new URL('../dist/index.js',import.meta.url));
test('the command entry creates a project from the command line',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'app-mixer-cli-'));
 try{
  const created=await run(process.execPath,[entry,'create','cli-app'],{cwd:dir});
  assert.match(created.stdout,/^Created .*cli-app/);assert.ok((await stat(join(dir,'cli-app','server.mjs'))).isFile());
  const viaRelativePath=await run(process.execPath,[relative(dir,entry),'create','second-app'],{cwd:dir});
  assert.match(viaRelativePath.stdout,/^Created .*second-app/);
  const usage=await run(process.execPath,[entry],{cwd:dir}).catch(error=>error);
  assert.equal(usage.code,1,'missing arguments print the usage and fail');assert.match(String(usage.stderr),/Usage: app-mixer create <name>/);
  const invalid=await run(process.execPath,[entry,'create','Bad Name'],{cwd:dir}).catch(error=>error);
  assert.equal(invalid.code,1);assert.match(String(invalid.stderr),/Invalid project name/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
