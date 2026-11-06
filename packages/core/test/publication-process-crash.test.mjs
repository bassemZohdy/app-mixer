import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SqliteApplicationStore} from '../dist/index.js';

const initial=id=>({id,schemaVersion:1,revision:0,pages:[]}),workerPath=fileURLToPath(new URL('./fixtures/crash-publication-worker.mjs',import.meta.url));
const title=(store,version)=>store.getPublished(version)?.definition.pages[0].title;

for(const mode of ['published','rolledback'])test(`process kill after a ${mode} publication keeps immutable versions, rollback lineage and version fencing`,{timeout:30000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'app-mixer-publication-crash-')),path=join(dir,'definitions.sqlite');let store,other,child;
 try{
  child=fork(workerPath,[path,mode],{stdio:['ignore','ignore','ignore','ipc']});
  const [message]=await Promise.race([once(child,'message'),once(child,'exit').then(([code,signal])=>{throw Error(`worker exited early (${code??signal})`);})]);assert.equal(message.type,mode);
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;child=undefined;

  store=new SqliteApplicationStore(path,initial('demo'));other=new SqliteApplicationStore(path,initial('other'));
  const latest=mode==='published'?2:3;
  assert.equal(store.getPublished().version,latest);
  assert.equal(title(store,1),'Home');assert.equal(title(store,2),'Changed');
  if(mode==='rolledback'){assert.equal(title(store,3),'Home');assert.equal(store.getPublished(3).version,3);}
  assert.equal(store.getPublished(latest+1),undefined);
  // Another application in the same database is untouched.
  assert.equal(other.getPublished(),undefined);
  // The draft revision survived and stale writers are rejected without changing anything.
  assert.equal(store.getDraft().revision,2);
  assert.throws(()=>store.apply(1,[]),/Revision conflict/);
  assert.throws(()=>store.rollback(1,latest-1));
  assert.equal(store.getPublished().version,latest);
  // A correctly fenced rollback adds one new immutable version and rewrites nothing.
  const before=JSON.stringify([store.getPublished(1),store.getPublished(2)]);
  const source=mode==='published'?1:2,rolled=store.rollback(source,latest);assert.equal(rolled.version,latest+1);assert.equal(title(store,latest+1),source===1?'Home':'Changed');
  assert.equal(JSON.stringify([store.getPublished(1),store.getPublished(2)]),before);
 }finally{if(child){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}other?.close?.();store?.close?.();rmSync(dir,{recursive:true,force:true});}
});
