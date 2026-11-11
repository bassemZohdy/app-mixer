import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
// TASK-002.1.1: core and agent each keep one definition of the identifier and integer validators.
const root=fileURLToPath(new URL('../../../',import.meta.url));
const agent=await import('../../agent/dist/validation.js'),core=await import('../../core/dist/validation.js');

test('TASK-002.1.1 isIdentifier accepts 1 to 128 characters that start with a letter or digit and refuses the rest',()=>{
 for(const value of ['a','A9','tenant-1','agent.run_2','a:b','user@example.com','a/b','x'.repeat(128)])assert.equal(agent.isIdentifier(value),true,String(value));
 for(const value of ['',' a','a b','-a','.a','_a','a\n','a?b','x'.repeat(129),1,null,undefined,{},['a']])assert.equal(agent.isIdentifier(value),false,String(value));
});

test('TASK-002.1.1 isNonNegativeInteger refuses negatives, fractions, unsafe integers and non-numbers in both packages',()=>{
 for(const module of [agent,core]){
  for(const value of [0,1,42,Number.MAX_SAFE_INTEGER])assert.equal(module.isNonNegativeInteger(value),true,String(value));
  for(const value of [-1,0.5,Number.MAX_SAFE_INTEGER+1,Infinity,NaN,'1',null,undefined,1n])assert.equal(module.isNonNegativeInteger(value),false,String(value));
 }
});

test('TASK-002.1.1 no source file keeps an identical local copy of a shared validator',()=>{
 const identifier=/^(?:export )?const \w+=\((\w+):unknown\):\1 is string=>typeof \1==='string'&&\/\^\[A-Za-z0-9\]\[A-Za-z0-9\._:@\/-\]\{0,127\}\$\/\.test\(\1\);\s*$/m;
 const integer=/^(?:export )?const \w+=\((\w+):unknown\):\1 is number=>Number\.isSafeInteger\(\1\)&&Number\(\1\)>=0;\s*$/m;
 const copies=[];
 for(const [name,patterns] of [['agent',[identifier,integer]],['core',[integer]]]){
  const directory=join(root,'packages',name,'src');
  for(const file of readdirSync(directory).filter(file=>file.endsWith('.ts')&&file!=='validation.ts'))for(const pattern of patterns)if(pattern.test(readFileSync(join(directory,file),'utf8')))copies.push(name+'/'+file);
 }
 assert.deepEqual(copies,[],'files that still define a validator that validation.ts already provides');
});
