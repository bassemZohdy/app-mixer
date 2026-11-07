import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,writeFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createFileSequenceAnchor,createFileReleaseFloorAnchor} from '../../core/dist/index.js';

const script=fileURLToPath(new URL('../../../scripts/anchor-admin.mjs',import.meta.url));
const cli=(...args)=>spawnSync(process.execPath,[script,...args],{encoding:'utf8'});

test('anchor-admin lists, reads and raises anchors, and lowering needs a flag and a reason that are logged',()=>{
 const dir=mkdtempSync(join(tmpdir(),'anchor-admin-'));
 try{
  // The files the library writes are the files the tool manages.
  createFileSequenceAnchor(dir).advance('authentication-failures',7);createFileReleaseFloorAnchor(dir).advance({tenantId:'t',applicationId:'a',environment:'prod'},4);
  writeFileSync(join(dir,'ignored.txt'),'x');
  const list=cli(dir,'list');assert.equal(list.status,0,list.stderr);
  assert.deepEqual(JSON.parse(list.stdout),[{file:'authentication-failures.sequence',value:7},{file:'t__a__prod.floor',value:4}]);
  assert.deepEqual(JSON.parse(cli(dir,'get','t__a__prod.floor').stdout),{file:'t__a__prod.floor',value:4});
  assert.deepEqual(JSON.parse(cli(dir,'get','missing.floor').stdout),{file:'missing.floor',value:0});
  // Raising works without ceremony and the library sees it.
  const raised=cli(dir,'set','t__a__prod.floor','9');assert.equal(raised.status,0,raised.stderr);assert.equal(JSON.parse(raised.stdout).after,9);
  assert.equal(createFileReleaseFloorAnchor(dir).read({tenantId:'t',applicationId:'a',environment:'prod'}),9);
  // Lowering is refused by default, then needs a real reason.
  const refused=cli(dir,'set','t__a__prod.floor','3');assert.equal(refused.status,1);assert.match(refused.stderr,/without --allow-lower/);assert.equal(readFileSync(join(dir,'t__a__prod.floor'),'utf8'),'9\n');
  const noReason=cli(dir,'set','t__a__prod.floor','3','--allow-lower');assert.equal(noReason.status,1);assert.match(noReason.stderr,/--reason/);
  const shortReason=cli(dir,'set','t__a__prod.floor','3','--allow-lower','--reason','oops');assert.equal(shortReason.status,1);
  const lowered=cli(dir,'set','t__a__prod.floor','3','--allow-lower','--reason','Restored the revocation database from the 02:00 backup and re-applied the floor');assert.equal(lowered.status,0,lowered.stderr);
  const entry=JSON.parse(lowered.stdout);assert.equal(entry.before,9);assert.equal(entry.after,3);assert.equal(entry.lowered,true);
  assert.equal(readFileSync(join(dir,'t__a__prod.floor'),'utf8'),'3\n');
  // Every successful change is one line in the log, with the reason for lowerings.
  const log=readFileSync(join(dir,'anchor-admin.log'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.deepEqual(log.map(item=>[item.file,item.before,item.after,item.lowered===true]),[['t__a__prod.floor',4,9,false],['t__a__prod.floor',9,3,true]]);
  assert.match(log[1].reason,/Restored the revocation database/);
  assert.deepEqual(readdirSync(dir).filter(file=>file.endsWith('.tmp')),[],'no temporary file is left behind');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('anchor-admin rejects unsafe names, bad values, unknown commands, corrupt files and a missing directory',()=>{
 const dir=mkdtempSync(join(tmpdir(),'anchor-admin-'));
 try{
  for(const file of ['../escape.floor','a/b.floor','plain.txt','.hidden.floor','x'.repeat(300)+'.floor'])assert.equal(cli(dir,'get',file).status,1,file);
  for(const value of ['-1','1.5','abc','007','99999999999999999'])assert.equal(cli(dir,'set','a.floor',value).status,1,value);
  assert.equal(cli(dir,'delete','a.floor').status,1);
  writeFileSync(join(dir,'bad.floor'),'garbage');assert.equal(cli(dir,'get','bad.floor').status,1);assert.match(cli(dir,'get','bad.floor').stderr,/corrupt/);
  assert.equal(cli(join(dir,'missing'),'list').status,1);
  assert.equal(cli().status,1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
