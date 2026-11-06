import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SqliteApplicationStore} from '../dist/index.js';

const workerPath=fileURLToPath(new URL('./fixtures/race-store-worker.mjs',import.meta.url));
const spawn=(path,title)=>{const child=fork(workerPath,[path,title],{stdio:['ignore','ignore','ignore','ipc']});child.queue=[];child.waiters=[];child.on('message',message=>{child.queue.push(message);child.waiters.splice(0).forEach(resolve=>resolve());});return child;};
const take=async(child,types)=>{for(;;){const index=child.queue.findIndex(message=>types.includes(message.type));if(index>=0)return child.queue.splice(index,1)[0];await new Promise(resolve=>child.waiters.push(resolve));}};

test('two processes editing and publishing from the same draft revision produce exactly one winner and one coherent version',{timeout:30000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'app-mixer-store-race-')),path=join(dir,'definitions.sqlite'),children=[];let store;
 try{
  children.push(spawn(path,'From A'),spawn(path,'From B'));
  await Promise.all(children.map(child=>take(child,['ready'])));children.forEach(child=>child.send('go'));
  const results=await Promise.all(children.map(child=>take(child,['won','lost'])));
  const winners=results.filter(result=>result.type==='won'),losers=results.filter(result=>result.type==='lost');
  assert.equal(winners.length,1,JSON.stringify(results));assert.equal(losers.length,1);assert.match(losers[0].message,/Revision conflict|Duplicate/);
  store=new SqliteApplicationStore(path,{id:'demo',schemaVersion:1,revision:0,pages:[]});
  // Exactly one version exists and it is the winner's content, never a mixture.
  assert.equal(store.getPublished().version,1);assert.equal(store.getPublished(2),undefined);
  assert.equal(store.getPublished(1).definition.pages.length,1);assert.equal(store.getPublished(1).definition.pages[0].title,winners[0].title);
  assert.equal(store.getDraft().revision,1);
 }finally{for(const child of children){if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}}store?.close?.();rmSync(dir,{recursive:true,force:true});}
});
