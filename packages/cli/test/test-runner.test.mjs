import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const run=promisify(execFile);

test('test runner discovers each workspace and propagates test failures',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mixer test runner '));
 try{
  await mkdir(join(root,'scripts'));await writeFile(join(root,'scripts','run-tests.mjs'),await readFile(resolve('scripts/run-tests.mjs')));
  for(const name of ['core','cli','web','native','agent']){const dir=join(root,'packages',name,'test');await mkdir(dir,{recursive:true});await writeFile(join(dir,'sample.test.mjs'),"import {test} from 'node:test';test('fixture',()=>{});\n");await writeFile(join(dir,'ignored.mjs'),"throw Error('must not load');\n");}
  const script=join(root,'scripts','run-tests.mjs'),env={...process.env,APP_MIXER_TEST_CONCURRENCY:'2'};delete env.NODE_TEST_CONTEXT;const result=await run(process.execPath,[script],{cwd:tmpdir(),env});assert.match(result.stdout,/pass 5/);assert.match(result.stdout,/fail 0/);
  for(const value of ['0','33','01','x',''])await assert.rejects(run(process.execPath,[script],{env:{...env,APP_MIXER_TEST_CONCURRENCY:value}}),error=>error.code===1&&/integer from 1 to 32/.test(error.stderr));
  await writeFile(join(root,'packages','core','test','sample.test.mjs'),"import {test} from 'node:test';test('fixture',()=>{throw Error('expected failure');});\n");await assert.rejects(run(process.execPath,[script],{env}),error=>error.code===1&&/fail 1/.test(error.stdout));
 }finally{await rm(root,{recursive:true,force:true});}
});
