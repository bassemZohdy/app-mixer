import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PostgresJwtRevocations,PostgresExtensionApprovals,createFileSequenceAnchor,jwtRevocationAnchorKey,extensionApprovalAnchorKey} from '../dist/index.js';

const issuer='https://identity.example.test/',claims=jti=>({iss:issuer,jti}),time=1700000000000;
const directory=()=>join(mkdtempSync(join(tmpdir(),'epoch-anchor-')),'anchor');
const cleanup=dir=>rmSync(join(dir,'..'),{recursive:true,force:true});

/** A stand-in database for the revocation table and its epoch. */
function revocationDatabase(state){
 return async sql=>{
  if(sql.startsWith('WITH bumped')){state.epoch=(state.epoch??0)+1;return {rows:[{retain_until:state.retainUntil,epoch:state.epoch}],rowCount:1};}
  if(sql.startsWith('INSERT INTO app_mixer_jwt_revocations'))return {rows:[{retain_until:state.retainUntil}],rowCount:1};
  if(sql.startsWith('SELECT (SELECT epoch'))return {rows:[{epoch:state.epoch===undefined?null:state.epoch,revoked:state.revoked}],rowCount:1};
  if(sql.startsWith('SELECT 1 FROM app_mixer_jwt_revocations'))return {rows:state.revoked?[{'?column?':1}]:[],rowCount:state.revoked?1:0};
  throw Error('unexpected query '+sql.slice(0,30));
 };
}

test('the revocation store advances an epoch with each revocation and refuses to answer once the epoch went back',async()=>{
 const dir=directory(),state={retainUntil:time+5000};
 try{
  const anchor=createFileSequenceAnchor(dir),store=new PostgresJwtRevocations({issuer,clock:()=>time,query:revocationDatabase(state),epochAnchor:anchor});
  await store.revoke('one',time+5000);await store.revoke('two',time+5000);
  assert.equal(await anchor.read(jwtRevocationAnchorKey(issuer)),2);
  state.revoked=false;assert.equal(await store.isTokenActive(claims('other')),true);
  state.revoked=true;assert.equal(await store.isTokenActive(claims('one')),false);
  // A restore puts the epoch back to 1: answers are refused, whether the token is revoked in the restored data or not.
  state.epoch=1;for(const revoked of [false,true]){state.revoked=revoked;await assert.rejects(store.isTokenActive(claims('one')),/Revocations were rolled back/);}
  // A database with no epoch row at all (a restore to before the first revocation) is also behind a positive anchor.
  state.epoch=undefined;await assert.rejects(store.isTokenActive(claims('one')),/rolled back/);
  // An epoch ahead of a lagging anchor is accepted and the anchor catches up.
  rmSync(join(dir,jwtRevocationAnchorKey(issuer)+'.sequence'));state.epoch=5;state.revoked=false;assert.equal(await store.isTokenActive(claims('x')),true);assert.equal(await anchor.read(jwtRevocationAnchorKey(issuer)),5);
  // A different issuer has its own epoch and anchor key.
  assert.notEqual(jwtRevocationAnchorKey(issuer),jwtRevocationAnchorKey('https://other.example.test/'));
 }finally{cleanup(dir);}
});

test('an unreadable revocation epoch anchor fails closed, an anchor failure on revoke does not fail the revoke, and plain stores are unchanged',async()=>{
 const state={retainUntil:time+5000,revoked:false};
 for(const read of [()=>{throw Error('down');},()=>-1,()=>1.5,()=>'2',()=>undefined]){
  const store=new PostgresJwtRevocations({issuer,clock:()=>time,query:revocationDatabase(state),epochAnchor:{read,advance:()=>{}}});await assert.rejects(store.isTokenActive(claims('x')),/Revocation epoch anchor unavailable/);
 }
 const reported=[],flaky=new PostgresJwtRevocations({issuer,clock:()=>time,query:revocationDatabase(state),epochAnchor:{read:()=>0,advance:()=>{throw Error('down');}},onAnchorError:error=>reported.push(error.message)});
 assert.equal(await flaky.revoke('one',time+5000),time+5000);assert.deepEqual(reported,['down'],'the failed anchor advance was reported');
 const plain=new PostgresJwtRevocations({issuer,clock:()=>time,query:revocationDatabase(state)});
 const before=state.epoch;await plain.revoke('one',time+5000);assert.equal(state.epoch,before,'without an anchor the epoch is not touched');assert.equal(await plain.isTokenActive(claims('x')),true);
 for(const bad of [{},{read:()=>1},{advance:()=>{}},null,'anchor'])assert.throws(()=>new PostgresJwtRevocations({issuer,query:async()=>({rows:[],rowCount:0}),epochAnchor:bad}),/Invalid JWT revocation configuration/);
});

/** A stand-in database for the approval table: the epoch is the sum of revisions. */
const scope={tenantId:'tenant',applicationId:'demo'},admin={tenantId:'tenant',principalId:'admin'},reference={id:'example.report',version:'1.0.0',scope:'application'},operation={extensionId:'example.report',kind:'tool',name:'lookup'};
function approvalDatabase(state){
 return async sql=>{
  if(sql.startsWith('SELECT COALESCE(SUM(revision)'))return {rows:[{epoch:state.epoch}],rowCount:1};
  if(sql.startsWith('SELECT revision,allowed,expires_at'))return {rows:[{revision:state.epoch,allowed:true,expires_at:time+60000}],rowCount:1};
  if(sql.startsWith('WITH changed AS')){state.epoch+=1;return {rows:[{revision:state.expected+1}],rowCount:1};}
  throw Error('unexpected query '+sql.slice(0,30));
 };
}
test('the approval store refuses to answer once its epoch (the sum of revisions) went below the anchored epoch',async()=>{
 const dir=directory(),state={epoch:0,expected:0};
 try{
  const anchor=createFileSequenceAnchor(dir),store=new PostgresExtensionApprovals({query:approvalDatabase(state),authorize:()=>true,clock:()=>time,epochAnchor:anchor});
  await store.decide(admin,scope,reference,operation,{allowed:true,expiresAt:time+60000,expectedRevision:0});
  assert.equal(await anchor.read(extensionApprovalAnchorKey('tenant','demo')),1,'a decision moves the anchor forward');
  state.expected=1;await store.decide(admin,scope,reference,operation,{allowed:false,expiresAt:0,expectedRevision:1});assert.equal(await anchor.read(extensionApprovalAnchorKey('tenant','demo')),2);
  assert.equal(await store.isAllowed(admin,scope,reference,operation),true,'the stub row still says allowed; the epoch is what is checked here');
  state.epoch=1;await assert.rejects(store.isAllowed(admin,scope,reference,operation),/Extension approvals were rolled back/);
  state.epoch=0;await assert.rejects(store.isAllowed(admin,scope,reference,operation),/rolled back/);
  // A lagging anchor is caught up when the database is ahead; applications have independent keys.
  rmSync(join(dir,extensionApprovalAnchorKey('tenant','demo')+'.sequence'));state.epoch=6;await store.isAllowed(admin,scope,reference,operation);assert.equal(await anchor.read(extensionApprovalAnchorKey('tenant','demo')),6);
  assert.notEqual(extensionApprovalAnchorKey('tenant','demo'),extensionApprovalAnchorKey('tenant','other'));assert.notEqual(extensionApprovalAnchorKey('ab','c'),extensionApprovalAnchorKey('a','bc'));
  writeFileSync(join(dir,extensionApprovalAnchorKey('tenant','demo')+'.sequence'),'garbage');await assert.rejects(store.isAllowed(admin,scope,reference,operation),/Extension approval epoch anchor unavailable/);
 }finally{cleanup(dir);}
});

test('approval anchor failures on decide do not fail the decision and invalid anchors are rejected',async()=>{
 const state={epoch:0,expected:0},reported=[],flaky=new PostgresExtensionApprovals({query:approvalDatabase(state),authorize:()=>true,clock:()=>time,epochAnchor:{read:()=>0,advance:()=>{throw Error('down');}},onAnchorError:error=>reported.push(error.message)});
 assert.equal(await flaky.decide(admin,scope,reference,operation,{allowed:true,expiresAt:time+60000,expectedRevision:0}),1);assert.deepEqual(reported,['down'],'the failed anchor advance was reported');
 for(const bad of [{},{read:()=>1},{advance:()=>{}},null,'anchor'])assert.throws(()=>new PostgresExtensionApprovals({query:async()=>({rows:[],rowCount:0}),authorize:()=>true,epochAnchor:bad}),/Invalid extension approval configuration/);
});
