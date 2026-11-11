import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,readdirSync,rmSync,utimesSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createFileReleaseFloorAnchor,createFileCounters,releaseFloorAnchorKey,PostgresPublicationReleaseRegistry} from '../dist/index.js';

const scope={tenantId:'tenant',applicationId:'app',environment:'prod'};
const directory=()=>join(mkdtempSync(join(tmpdir(),'floor-anchor-')),'anchor');
const cleanup=dir=>rmSync(join(dir,'..'),{recursive:true,force:true});
const file=(dir,s)=>join(dir,releaseFloorAnchorKey(s.tenantId,s.applicationId,s.environment)+'.floor');

test('the file anchor reads 0 when missing, advances durably and never lowers the floor',async()=>{
 const dir=directory();
 try{
  const anchor=createFileReleaseFloorAnchor(dir);
  assert.equal(await anchor.read(scope),0);
  await anchor.advance(scope,5);assert.equal(await anchor.read(scope),5);
  await anchor.advance(scope,3);assert.equal(await anchor.read(scope),5,'a lower floor is ignored');
  await anchor.advance(scope,5);await anchor.advance(scope,9);assert.equal(await anchor.read(scope),9);
  assert.equal(await anchor.read({...scope,environment:'staging'}),0,'scopes are independent');
  assert.deepEqual(readdirSync(dir),[releaseFloorAnchorKey('tenant','app','prod')+'.floor'],'one file, named by a hash, and no lock or temporary file left behind');
  assert.equal(readFileSync(file(dir,scope),'utf8'),'9\n');
  assert.equal(await createFileReleaseFloorAnchor(dir).read(scope),9,'a new instance sees the durable value');
 }finally{cleanup(dir);}
});

test('scopes whose identifiers differ only by separators, case or length get different files',async()=>{
 const dir=directory();
 try{
  const anchor=createFileReleaseFloorAnchor(dir),long='x'.repeat(128);
  const scopes=[{tenantId:'a__b',applicationId:'c',environment:'prod'},{tenantId:'a',applicationId:'b__c',environment:'prod'},{tenantId:'t',applicationId:'a',environment:'Prod'},{tenantId:'t',applicationId:'a',environment:'prod'},{tenantId:long,applicationId:long,environment:long}];
  for(const [index,s] of scopes.entries())await anchor.advance(s,index+1);
  for(const [index,s] of scopes.entries())assert.equal(await anchor.read(s),index+1,JSON.stringify(s).slice(0,80));
  assert.equal(new Set(readdirSync(dir)).size,scopes.length);
  assert.ok(readdirSync(dir).every(entry=>entry.length<100),'file names stay short whatever the identifiers');
 }finally{cleanup(dir);}
});

test('the file anchor rejects invalid scopes, floors and corrupt files',async()=>{
 const dir=directory();
 try{
  assert.throws(()=>createFileReleaseFloorAnchor(''),/Invalid release floor anchor directory/);
  const anchor=createFileReleaseFloorAnchor(dir);
  for(const bad of [{...scope,tenantId:'../escape'},{...scope,applicationId:'a/b'},{tenantId:'t',applicationId:'a'},null])assert.throws(()=>anchor.read(bad),/Invalid publication release scope/);
  for(const bad of [-1,1.5,Number.NaN,'3'])assert.throws(()=>anchor.advance(scope,bad),/Invalid release floor/);
  for(const text of ['abc\n','-1\n','1.5','007\n','','12\n34\n']){writeFileSync(file(dir,scope),text);await assert.rejects(anchor.read(scope),/Corrupt anchor/,JSON.stringify(text));}
 }finally{cleanup(dir);}
});

test('racing writers cannot lower a counter and the value only ever rises',async()=>{
 const dir=directory();
 try{
  const a=createFileCounters(dir,'.floor'),b=createFileCounters(dir,'.floor');
  const values=Array.from({length:24},(_,i)=>(i*7919)%97+1),writes=values.map((value,i)=>(i%2?a:b).advance('race',value));
  const seen=[];let reading=true;const reader=(async()=>{while(reading){seen.push(await a.read('race'));await new Promise(resolve=>setImmediate(resolve));}})();
  const results=await Promise.allSettled(writes);reading=false;await reader;
  // On a heavily loaded machine a writer may wait out the lock and give up; that is an allowed, reported outcome. Nothing else may fail.
  const failed=results.filter(result=>result.status==='rejected');
  assert.ok(failed.every(result=>/Anchor is locked by another writer/.test(result.reason.message)),'only a lock timeout may fail: '+failed.map(result=>result.reason.message).join('; '));
  const written=values.filter((_,i)=>results[i].status==='fulfilled');
  assert.ok(written.length>0,'at least one writer got through');
  assert.ok(await a.read('race')>=Math.max(...written),'the final value is at least the highest value a writer was told it had written');
  assert.ok(seen.every((value,i)=>i===0||value>=seen[i-1]),'no read ever saw the counter go down: '+seen.join(','));
  assert.deepEqual(readdirSync(dir),['race.floor'],'no lock or temporary file is left behind');
  // set() is the only way down and reports what it replaced.
  const before=await a.read('race');assert.deepEqual(await a.set('race',2),{before});assert.equal(await b.read('race'),2);
 }finally{cleanup(dir);}
});

test('a lock left by a crashed writer is broken once stale, and a live lock makes a writer give up',async()=>{
 const dir=directory();
 try{
  const counters=createFileCounters(dir,'.floor'),lock=join(dir,'held.floor.lock');
  writeFileSync(lock,'');const old=new Date(Date.now()-120000);utimesSync(lock,old,old);
  await counters.advance('held',4);assert.equal(await counters.read('held'),4);assert.equal(existsSync(lock),false,'the stale lock was broken and released');
  writeFileSync(lock,'');await assert.rejects(counters.advance('held',9),/Anchor is locked by another writer/);assert.equal(await counters.read('held'),4,'nothing was written while another writer held the lock');
 }finally{cleanup(dir);}
});

test('a registry with a file anchor refuses a database whose floor went back',async()=>{
 const dir=directory();
 try{
  const state={floor:4},query=async sql=>sql.startsWith('SELECT minimum_version')?{rows:[{minimum_version:state.floor}],rowCount:1}:{rows:[{allowed:1}],rowCount:1};
  const reported=[],releases=new PostgresPublicationReleaseRegistry({query,floorAnchor:createFileReleaseFloorAnchor(dir),onAnchorError:error=>reported.push(error)}),digest='b'.repeat(64);
  assert.equal(await releases.isAllowed(scope,4,digest),true,'the first check adopts the database floor');
  assert.equal(readFileSync(file(dir,scope),'utf8'),'4\n');
  state.floor=2;await assert.rejects(releases.isAllowed(scope,4,digest),/Release floor was rolled back/);
  writeFileSync(file(dir,scope),'garbage');await assert.rejects(releases.isAllowed(scope,4,digest),/Release floor anchor unavailable/);
  assert.deepEqual(reported,[]);
 }finally{cleanup(dir);}
});
