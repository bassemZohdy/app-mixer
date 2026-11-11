import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteStagedOperations} from '../dist/index.js';
import {SqliteAgentRuns} from '../../agent/dist/index.js';
import {schemaVersion,assertSchemaSupported,recordSchemaVersion} from '../dist/schema-version.js';

test('schema versions are recorded per component, never lowered, and a newer database is refused',()=>{
 const db=new DatabaseSync(':memory:');
 assert.equal(schemaVersion(db,'thing'),1,'a database without records is the original layout');
 recordSchemaVersion(db,'thing',3);recordSchemaVersion(db,'thing',2);assert.equal(schemaVersion(db,'thing'),3,'a version is never lowered');assert.equal(schemaVersion(db,'other'),1);
 assertSchemaSupported(db,'thing',3);assert.throws(()=>assertSchemaSupported(db,'thing',2),/schema is version 3, newer than this release supports \(2\)/);
});

test('the migrating stores record their version, upgrade older databases and refuse newer ones',()=>{
 const dir=mkdtempSync(join(tmpdir(),'schema-version-'));
 try{
  for(const [name,open,component] of [['runs',path=>new SqliteAgentRuns(path),'agent_runs'],['staged',path=>new SqliteStagedOperations(path),'staged_operations']]){
   const path=join(dir,name+'.sqlite');open(path).close();
   const probe=new DatabaseSync(path);assert.equal(Number(probe.prepare('SELECT version FROM app_mixer_schema WHERE component=?').get(component).version),2,component+' records version 2');
   probe.exec("DELETE FROM app_mixer_schema");probe.close();open(path).close();
   const again=new DatabaseSync(path);assert.equal(Number(again.prepare('SELECT version FROM app_mixer_schema WHERE component=?').get(component).version),2,'a database without a record is upgraded and recorded');
   again.prepare('UPDATE app_mixer_schema SET version=3 WHERE component=?').run(component);again.close();
   assert.throws(()=>open(path),/newer than this release supports \(2\)/);
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});
