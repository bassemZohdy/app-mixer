#!/usr/bin/env node
// Contention benchmark for the SQLite stores: several worker processes append rows to one shared database file,
// the way a run registry, action journal and approvals do, with the rollback journal and with WAL.
// `node scripts/bench-sqlite.mjs [workers=4] [writesPerWorker=300]` prints transactions per second and busy errors.
import {DatabaseSync} from 'node:sqlite';
import {fork} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

if(process.argv[2]==='worker'){
 const [,,,path,mode,writes,id]=process.argv,db=new DatabaseSync(path);let busy=0;
 db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode='+mode);
 const insert=db.prepare('INSERT INTO bench (worker,n) VALUES (?,?)'),read=db.prepare('SELECT COUNT(*) AS n FROM bench');
 for(let n=0;n<Number(writes);n++){
  try{db.exec('BEGIN IMMEDIATE');insert.run(Number(id),n);db.exec('COMMIT');read.get();}catch(error){busy++;try{db.exec('ROLLBACK');}catch{}}
 }
 db.close();process.send({busy});process.exit(0);
}
const workers=Number(process.argv[2]??4),writes=Number(process.argv[3]??300),script=fileURLToPath(import.meta.url);
async function run(mode){
 const dir=mkdtempSync(join(tmpdir(),'bench-sqlite-')),path=join(dir,'db.sqlite'),db=new DatabaseSync(path);db.exec('PRAGMA journal_mode='+mode+'; CREATE TABLE bench (worker INTEGER, n INTEGER)');db.close();
 const started=performance.now();let busy=0;
 await Promise.all(Array.from({length:workers},(_,id)=>new Promise((resolve,reject)=>{const child=fork(script,['worker',path,mode,String(writes),String(id)]);child.on('message',message=>{busy+=message.busy;});child.on('exit',code=>code===0?resolve():reject(Error('worker failed')));})));
 const seconds=(performance.now()-started)/1000;rmSync(dir,{recursive:true,force:true});
 return {mode,transactions:workers*writes,seconds:Number(seconds.toFixed(2)),perSecond:Math.round(workers*writes/seconds),busyErrors:busy};
}
for(const mode of ['DELETE','WAL'])console.log(JSON.stringify(await run(mode)));
