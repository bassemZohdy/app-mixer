import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createFileReleaseFloorAnchor,PostgresPublicationReleaseRegistry} from '../dist/index.js';

const scope={tenantId:'tenant',applicationId:'app',environment:'prod'};
test('the file anchor reads 0 when missing, advances atomically and never lowers the floor',()=>{
 const dir=join(mkdtempSync(join(tmpdir(),'floor-anchor-')),'anchor');
 try{
  const anchor=createFileReleaseFloorAnchor(dir);
  assert.equal(anchor.read(scope),0);
  anchor.advance(scope,5);assert.equal(anchor.read(scope),5);
  anchor.advance(scope,3);assert.equal(anchor.read(scope),5,'a lower floor is ignored');
  anchor.advance(scope,5);anchor.advance(scope,9);assert.equal(anchor.read(scope),9);
  assert.equal(anchor.read({...scope,environment:'staging'}),0,'scopes are independent');
  assert.deepEqual(readdirSync(dir),['tenant__app__prod.floor'],'no temporary file is left behind');
  assert.equal(readFileSync(join(dir,'tenant__app__prod.floor'),'utf8'),'9\n');
  assert.equal(createFileReleaseFloorAnchor(dir).read(scope),9,'a new instance sees the durable value');
 }finally{rmSync(join(dir,'..'),{recursive:true,force:true});}
});

test('the file anchor rejects invalid scopes, floors and corrupt files',()=>{
 const dir=join(mkdtempSync(join(tmpdir(),'floor-anchor-')),'anchor');
 try{
  assert.throws(()=>createFileReleaseFloorAnchor(''),/Invalid release floor anchor directory/);
  const anchor=createFileReleaseFloorAnchor(dir);
  for(const bad of [{...scope,tenantId:'../escape'},{...scope,applicationId:'a/b'},{tenantId:'t',applicationId:'a'},null])assert.throws(()=>anchor.read(bad),/Invalid publication release scope/);
  for(const bad of [-1,1.5,Number.NaN,'3'])assert.throws(()=>anchor.advance(scope,bad),/Invalid release floor/);
  for(const text of ['abc\n','-1\n','1.5','007\n','','12\n34\n'])writeFileSync(join(dir,'tenant__app__prod.floor'),text),assert.throws(()=>anchor.read(scope),/Corrupt release floor anchor/,JSON.stringify(text));
 }finally{rmSync(join(dir,'..'),{recursive:true,force:true});}
});

test('a registry with a file anchor refuses a database whose floor went back',async()=>{
 const dir=join(mkdtempSync(join(tmpdir(),'floor-anchor-')),'anchor');
 try{
  const state={floor:4},query=async sql=>sql.startsWith('SELECT minimum_version')?{rows:[{minimum_version:state.floor}],rowCount:1}:{rows:[{allowed:1}],rowCount:1};
  const releases=new PostgresPublicationReleaseRegistry({query,floorAnchor:createFileReleaseFloorAnchor(dir)}),digest='b'.repeat(64);
  assert.equal(await releases.isAllowed(scope,4,digest),true,'the first check adopts the database floor');
  assert.equal(readFileSync(join(dir,'tenant__app__prod.floor'),'utf8'),'4\n');
  state.floor=2;await assert.rejects(releases.isAllowed(scope,4,digest),/Release floor was rolled back/);
  writeFileSync(join(dir,'tenant__app__prod.floor'),'garbage');await assert.rejects(releases.isAllowed(scope,4,digest),/Release floor anchor unavailable/);
 }finally{rmSync(join(dir,'..'),{recursive:true,force:true});}
});
