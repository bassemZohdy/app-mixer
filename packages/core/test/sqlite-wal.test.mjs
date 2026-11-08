import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync,readFileSync,rmSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SqliteApplicationStore,SqliteCapabilityAudit,SqliteOfflineQueue} from '../dist/index.js';

test('every SQLite store opens its database in WAL mode',()=>{
 const packages=fileURLToPath(new URL('../../',import.meta.url));let stores=0;
 for(const name of readdirSync(packages)){
  let sources;try{sources=readdirSync(join(packages,name,'src')).filter(file=>file.endsWith('.ts'));}catch{continue;}
  for(const file of sources){const text=readFileSync(join(packages,name,'src',file),'utf8');if(!text.includes('new DatabaseSync(')&&!text.includes('openDatabase('))continue;stores++;if(text.includes('openDatabase('))continue;/* read-only connections cannot change the journal mode */if(![...text.matchAll(/new DatabaseSync\((?![^)]*readOnly)/g)].length)continue;/* openDatabase switches to WAL, retrying when processes open a new file together */assert.match(text,/journal_mode\s*=\s*WAL/,`${name}/src/${file} opens SQLite without WAL; use openDatabase(path) or add PRAGMA journal_mode=WAL beside busy_timeout`);}
 }
 assert.ok(stores>=26,'found '+stores+' stores');
});

test('stores use WAL on disk, readers see committed rows while a writer is mid-transaction, and the extra files are removed on close',()=>{
 const dir=mkdtempSync(join(tmpdir(),'wal-'));
 try{
  const path=join(dir,'definitions.sqlite'),store=new SqliteApplicationStore(path,{id:'demo',schemaVersion:1,revision:0,pages:[]}),audit=new SqliteCapabilityAudit(join(dir,'audit.sqlite')),queue=new SqliteOfflineQueue(join(dir,'queue.sqlite'),{enabled:true,maxAttempts:2,retryDelayMs:10});
  try{
   for(const file of ['definitions.sqlite','audit.sqlite','queue.sqlite']){const probe=new DatabaseSync(join(dir,file));try{assert.equal(probe.prepare('PRAGMA journal_mode').get().journal_mode,'wal',file);}finally{probe.close();}}
   // A reader proceeds while another connection holds an open write transaction and sees only committed rows.
   const writer=new DatabaseSync(path);writer.exec('PRAGMA busy_timeout=0');writer.exec('BEGIN IMMEDIATE');writer.exec("INSERT INTO application_drafts(app_id,revision,definition) VALUES ('other',1,'{}')");
   try{const reader=new DatabaseSync(path);reader.exec('PRAGMA busy_timeout=0');try{assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM application_drafts').get().n,1,'the reader sees the committed state');}finally{reader.close();}}finally{writer.exec('ROLLBACK');writer.close();}
  }finally{store.close();audit.close();queue.close();}
  assert.deepEqual(readdirSync(dir).filter(file=>/-(wal|shm)$/.test(file)),[],'the WAL and shared-memory files are removed when the last connection closes');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('the contention benchmark runs for both journal modes without lock errors',async()=>{
 const {spawnSync}=await import('node:child_process'),script=fileURLToPath(new URL('../../../scripts/bench-sqlite.mjs',import.meta.url));
 const run=spawnSync(process.execPath,['--no-warnings',script,'2','10'],{encoding:'utf8',timeout:60000});assert.equal(run.status,0,run.stderr);
 const results=run.stdout.trim().split('\n').map(line=>JSON.parse(line));assert.deepEqual(results.map(result=>result.mode),['DELETE','WAL']);
 for(const result of results){assert.equal(result.transactions,20);assert.equal(result.busyErrors,0);assert.ok(result.perSecond>0);}
});
