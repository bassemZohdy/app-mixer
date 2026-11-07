import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,writeFileSync,readdirSync,chmodSync,existsSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createFileSequenceAnchor,createFileReleaseFloorAnchor,releaseFloorAnchorKey,authenticationFailureAnchorKey,capabilityAuditAnchorKey} from '../../core/dist/index.js';

const script=fileURLToPath(new URL('../../../scripts/anchor-admin.mjs',import.meta.url));
const cli=(...args)=>new Promise(resolve=>execFile(process.execPath,[script,...args],{encoding:'utf8',timeout:60000},(error,stdout,stderr)=>resolve({status:error?(typeof error.code==='number'?error.code:1):0,stdout,stderr})));
const floorScope={tenantId:'t',applicationId:'a',environment:'prod'},floorFile=releaseFloorAnchorKey('t','a','prod')+'.floor';
const lines=dir=>readFileSync(join(dir,'anchor-admin.log'),'utf8').trim().split('\n').map(line=>JSON.parse(line));

test('anchor-admin finds anchor files by key, lists, reads and raises them, and lowering needs a flag and a reason that are logged',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'anchor-admin-'));
 try{
  // The files the library writes are the files the tool manages, and `key` names them.
  await createFileSequenceAnchor(dir).advance(authenticationFailureAnchorKey,7);await createFileReleaseFloorAnchor(dir).advance(floorScope,4);
  writeFileSync(join(dir,'ignored.txt'),'x');
  assert.deepEqual(JSON.parse((await cli('key','release-floor','t','a','prod')).stdout),{file:floorFile});
  assert.deepEqual(JSON.parse((await cli('key','authentication-failures')).stdout),{file:authenticationFailureAnchorKey+'.sequence'});
  assert.deepEqual(JSON.parse((await cli('key','capability-audit','tenant/with slash')).stdout),{file:capabilityAuditAnchorKey('tenant/with slash')+'.sequence'});
  for(const bad of [['key','release-floor','t','a'],['key','unknown'],['key','jwt-revocations'],['key','authentication-failures','extra']])assert.equal((await cli(...bad)).status,1,bad.join(' '));
  const list=await cli(dir,'list');assert.equal(list.status,0,list.stderr);
  assert.deepEqual(JSON.parse(list.stdout),[{file:authenticationFailureAnchorKey+'.sequence',value:7},{file:floorFile,value:4}].sort((x,y)=>x.file<y.file?-1:1));
  assert.deepEqual(JSON.parse((await cli(dir,'get',floorFile)).stdout),{file:floorFile,value:4});
  assert.deepEqual(JSON.parse((await cli(dir,'get','missing.floor')).stdout),{file:'missing.floor',value:0});
  // Raising works without ceremony, never lowers, and the library sees it.
  const raised=await cli(dir,'set',floorFile,'9');assert.equal(raised.status,0,raised.stderr);assert.equal(JSON.parse(raised.stdout).after,9);
  assert.equal(await createFileReleaseFloorAnchor(dir).read(floorScope),9);
  // Lowering is refused by default, then needs a real reason.
  const refused=await cli(dir,'set',floorFile,'3');assert.equal(refused.status,1);assert.match(refused.stderr,/without --allow-lower/);assert.equal(readFileSync(join(dir,floorFile),'utf8'),'9\n');
  assert.equal((await cli(dir,'set',floorFile,'3','--allow-lower')).status,1);
  assert.equal((await cli(dir,'set',floorFile,'3','--allow-lower','--reason','oops')).status,1);
  assert.equal((await cli(dir,'set',floorFile,'3','--allow-lower','--reason','--allow-lower')).status,1,'a flag is not a reason');
  const lowered=await cli(dir,'set',floorFile,'3','--allow-lower','--reason','Restored the revocation database from the 02:00 backup and re-applied the floor');assert.equal(lowered.status,0,lowered.stderr);
  const entry=JSON.parse(lowered.stdout);assert.equal(entry.phase,'applied');assert.equal(entry.before,9);assert.equal(entry.after,3);assert.equal(entry.lowered,true);
  assert.equal(readFileSync(join(dir,floorFile),'utf8'),'3\n');
  // Every change is two lines: the intent first, then what was applied; refused attempts leave no line.
  const log=lines(dir);
  assert.deepEqual(log.map(item=>[item.phase,item.before,item.after,item.lowered===true]),[['intent',4,9,false],['applied',4,9,false],['intent',9,3,true],['applied',9,3,true]]);
  assert.match(log[2].reason,/Restored the revocation database/);
  assert.deepEqual(readdirSync(dir).filter(file=>file.endsWith('.tmp')||file.endsWith('.lock')),[],'no temporary or lock file is left behind');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('anchor-admin changes nothing when it cannot write its log first',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'anchor-admin-'));
 try{
  await createFileReleaseFloorAnchor(dir).advance(floorScope,8);
  // A directory where the log file should be makes the intent line impossible to write.
  mkdirSync(join(dir,'anchor-admin.log'));
  const result=await cli(dir,'set',floorFile,'2','--allow-lower','--reason','Restored from backup, floor re-applied');assert.equal(result.status,1);
  assert.equal(readFileSync(join(dir,floorFile),'utf8'),'8\n','the anchor was not lowered because the intent could not be recorded');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('anchor-admin rejects unsafe names, bad values, unknown commands, corrupt files and a missing directory',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'anchor-admin-'));
 try{
  for(const file of ['../escape.floor','a/b.floor','plain.txt','.hidden.floor','x'.repeat(300)+'.floor'])assert.equal((await cli(dir,'get',file)).status,1,file);
  for(const value of ['-1','1.5','abc','007','99999999999999999'])assert.equal((await cli(dir,'set','a.floor',value)).status,1,value);
  assert.equal((await cli(dir,'delete','a.floor')).status,1);
  writeFileSync(join(dir,'bad.floor'),'garbage');const corrupt=await cli(dir,'get','bad.floor');assert.equal(corrupt.status,1);assert.match(corrupt.stderr,/Corrupt anchor/);
  assert.equal((await cli(join(dir,'missing'),'list')).status,1);
  assert.equal((await cli()).status,1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
