#!/usr/bin/env node
// Online-migration experiment for the SQLite business-data provider: migrate one collection of N records while another
// process keeps writing to a different collection (and to the same one) of the same database. Reports how long the
// migration takes, how long writers were stalled, and whether any write failed.
// `node scripts/bench-migration.mjs [records=20000] [writerIntervalMs=5]`
import {DatabaseSync} from 'node:sqlite';
import {fork} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SqliteDataProvider} from '../packages/core/dist/index.js';

const scope={tenantId:'tenant',applicationId:'app'};
if(process.argv[2]==='writer'){
 const [,,,path,collection,interval]=process.argv,provider=new SqliteDataProvider(path);let n=0,failures=0,worst=0,stop=false;
 process.on('message',message=>{if(message==='stop')stop=true;});
 const tick=()=>{
  if(stop){process.send({writes:n,failures,worstMs:Number(worst.toFixed(1))});provider.close();process.exit(0);}
  const started=performance.now();
  try{provider.put(scope,collection,'w'+n,{n},null);n++;}catch{failures++;}
  worst=Math.max(worst,performance.now()-started);setTimeout(tick,Number(interval));
 };
 tick();
}else{
 const records=Number(process.argv[2]??20000),interval=process.argv[3]??'5',script=fileURLToPath(import.meta.url);
 const dir=mkdtempSync(join(tmpdir(),'bench-migration-')),path=join(dir,'db.sqlite');
 try{
  const provider=new SqliteDataProvider(path),load=new DatabaseSync(path);
  // Bulk-load through the provider's own table for speed; the provider validates reads and migration against these rows.
  load.exec('BEGIN');const insert=load.prepare("INSERT INTO business_records VALUES (?,?,?,?,1,?,0)");for(let n=0;n<records;n++)insert.run(scope.tenantId,scope.applicationId,'people','p'+n,JSON.stringify({name:'person '+n}));load.exec('COMMIT');load.close();
  const results=[];
  for(const collection of ['audit','people']){
   const writer=fork(script,['writer',path,collection,interval]);let report;writer.on('message',message=>{report=message;});
   await new Promise(resolve=>setTimeout(resolve,300));
   const preview=provider.previewMigration(scope,'people');
   const started=performance.now();let outcome='migrated';
   try{provider.migrateCollection(scope,'people',{fromVersion:preview.schemaVersion,toVersion:preview.schemaVersion+1,digest:preview.digest,transform:value=>({fullName:value.name??value.fullName}),validate:value=>typeof value.fullName==='string'});}catch(error){outcome=String(error.message);}
   const migrationMs=performance.now()-started;
   writer.send('stop');await new Promise(resolve=>writer.on('exit',resolve));
   results.push({writerCollection:collection,records,migrationMs:Number(migrationMs.toFixed(0)),outcome,writerWrites:report?.writes,writerFailures:report?.failures,writerWorstStallMs:report?.worstMs});
  }
  provider.close();for(const result of results)console.log(JSON.stringify(result));
 }catch(error){console.error(error);process.exitCode=1;}finally{try{rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200});}catch{}}
}
