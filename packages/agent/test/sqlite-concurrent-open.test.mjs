// Several processes that start together and open the same, still missing, SQLite file must all succeed. Switching a new
// database to WAL mode can fail with "database is locked" without waiting for the busy timeout, so opening retries it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const worker=fileURLToPath(new URL('./fixtures/open-runs-worker.mjs',import.meta.url));
const start=path=>{const child=fork(worker,[path],{stdio:['ignore','ignore','pipe','ipc']});child.output='';child.stderr.on('data',chunk=>child.output+=chunk);child.report=new Promise(resolve=>{child.loaded=new Promise(ready=>child.on('message',message=>{if(message.type==='loaded')ready();else resolve(message);}));child.on('exit',code=>resolve({type:'failed',message:`exited with ${code}: ${child.output.slice(-300)}`}));});return child;};

test('processes opening the same new run registry at the same moment all succeed',{timeout:240000},async()=>{
 const failures=[];
 for(let round=0;round<15;round++){
  const dir=mkdtempSync(join(tmpdir(),'app-mixer-open-runs-')),children=Array.from({length:4},()=>start(join(dir,'runs.sqlite')));
  try{
   await Promise.all(children.map(child=>child.loaded));children.forEach(child=>child.send('go'));
   for(const result of await Promise.all(children.map(child=>child.report)))if(result.type!=='opened')failures.push(`round ${round}: ${result.message}`);
  }finally{for(const child of children)if(child.exitCode===null)child.kill('SIGKILL');rmSync(dir,{recursive:true,force:true,maxRetries:20,retryDelay:100});}
 }
 assert.deepEqual(failures,[]);
});
