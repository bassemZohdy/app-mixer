import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp,rm,readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createProject} from '../dist/index.js';
const cli=fileURLToPath(new URL('../dist/index.js',import.meta.url));
const run=(args,cwd)=>new Promise(resolve=>execFile(process.execPath,[cli,...args],{cwd,env:{...process.env,NODE_NO_WARNINGS:'1'}},(error,stdout,stderr)=>resolve({code:error?error.code:0,stdout,stderr})));
const COMMANDS=['create','extension-sign','extension-verify','extension-check','extension-check-set'];

test('FIX-038 --help and -h print one command per line and exit 0',async()=>{
 for(const flag of ['--help','-h']){
  const result=await run([flag]);
  assert.equal(result.code,0,flag);
  assert.equal(result.stderr,'');
  const lines=result.stdout.split(/\r?\n/).filter(line=>line.trim());
  for(const command of COMMANDS)assert.equal(lines.filter(line=>line.trim().startsWith(command+' ')||line.trim()===command).length,1,`${flag}: one line for ${command}`);
  assert.ok(lines.length>=COMMANDS.length+1,'a heading line and a line per command');
 }
});

test('FIX-038 no command or an unknown command still exits 1 with the usage',async()=>{
 for(const args of [[],['bogus']]){
  const result=await run(args);
  assert.equal(result.code,1);
  assert.match(result.stderr,/create/);
 }
});

test('FIX-038 --version prints the package version',async()=>{
 const {version}=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
 const result=await run(['--version']);
 assert.equal(result.code,0);
 assert.equal(result.stdout.trim(),version);
});

test('FIX-038 create refuses Windows device names and writes nothing',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cli-usage-'));
 try{
  for(const name of ['con','nul','aux','prn','com1','com9','lpt1','lpt9']){
   const result=await run(['create',name],dir);
   assert.equal(result.code,1,name);
   assert.match(result.stderr,/Invalid project name/);
   await assert.rejects(createProject(name,dir),/Invalid project name/);
  }
  assert.deepEqual(await readdir(dir),[]);
  const ok=await run(['create','console-app'],dir);
  assert.equal(ok.code,0);
  assert.deepEqual(await readdir(dir),['console-app']);
 }finally{await rm(dir,{recursive:true,force:true});}
});
