import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PostgresCapabilityAudit,PostgresAuthenticationFailureAudit,createFileSequenceAnchor,capabilityAuditAnchorKey,authenticationFailureAnchorKey} from '../dist/index.js';

const event=(tenantId='tenant')=>({invocationId:'invocation',operationId:'write',tenantId,principalId:'user',outcome:'attempt'});
/** A stand-in database for the sequence counters: assigns the next sequence on the WITH ... INSERT statement and reports the counter. */
function database(state){
 const inserts=[];
 return {inserts,query:async(sql)=>{
  if(sql.startsWith('SELECT sequence FROM'))return {rows:state.counter===undefined?[]:[{sequence:state.counter}],rowCount:state.counter===undefined?0:1};
  if(sql.startsWith('WITH assigned')){state.counter=(state.counter??0)+1;inserts.push(state.counter);return {rows:[{sequence:state.counter}],rowCount:1};}
  throw Error('unexpected query '+sql.slice(0,30));
 }};
}
const directory=()=>join(mkdtempSync(join(tmpdir(),'audit-anchor-')),'anchor');
const cleanup=dir=>rmSync(join(dir,'..'),{recursive:true,force:true});

test('the file sequence anchor stores durable high-water marks by key and never lowers them',async()=>{
 const dir=directory();
 try{
  const anchor=createFileSequenceAnchor(dir);
  assert.equal(await anchor.read('a'),0);await anchor.advance('a',4);await anchor.advance('a',2);assert.equal(await anchor.read('a'),4);await anchor.advance('b',1);assert.equal(await anchor.read('b'),1);
  assert.deepEqual(readdirSync(dir).sort(),['a.sequence','b.sequence']);assert.equal(await createFileSequenceAnchor(dir).read('a'),4);
  for(const bad of ['../x','a/b','','.hidden',null,undefined])assert.throws(()=>anchor.read(bad),/Invalid anchor name/);
  for(const bad of [-1,1.5,Number.NaN,'3'])await assert.rejects(anchor.advance('a',bad),/Invalid anchor value/);
  writeFileSync(join(dir,'a.sequence'),'garbage');await assert.rejects(anchor.read('a'),/Corrupt anchor/);
  assert.match(capabilityAuditAnchorKey('tenant/with slash and ünï'),/^capability-audit-[a-f0-9]{64}$/,'tenant IDs are hashed into a safe key');
 }finally{cleanup(dir);}
});

test('the capability audit refuses to record when its sequence went back below the anchored mark',async()=>{
 const dir=directory(),state={};
 try{
  const db=database(state),anchor=createFileSequenceAnchor(dir),audit=new PostgresCapabilityAudit({query:db.query,clock:()=>1,sequenceAnchor:anchor});
  for(const tenant of ['tenant','a/b with spaces'])for(let n=0;n<3;n++){state.counter=n;await audit.record(event(tenant));}
  state.counter=3;assert.equal(readFileSync(join(dir,capabilityAuditAnchorKey('tenant')+'.sequence'),'utf8'),'3\n');
  // A restore puts the counter back to 1: the next record is refused and nothing is inserted.
  const before=db.inserts.length;state.counter=1;await assert.rejects(audit.record(event()),/Audit log was rolled back/);assert.equal(db.inserts.length,before);
  // Another tenant is unaffected by the first tenant's anchor.
  state.counter=3;await audit.record(event('a/b with spaces'));assert.equal(state.counter,4);
  // A counter ahead of a lagging anchor is accepted and the anchor is caught up.
  rmSync(join(dir,capabilityAuditAnchorKey('tenant')+'.sequence'));state.counter=7;await audit.record(event());assert.equal(await anchor.read(capabilityAuditAnchorKey('tenant')),8);
  // A missing counter row (empty database) with a positive anchor is a rollback.
  state.counter=undefined;await assert.rejects(audit.record(event()),/rolled back/);
 }finally{cleanup(dir);}
});

test('the authentication-failure audit refuses to record after a rollback and an unreadable anchor fails closed',async()=>{
 const dir=directory(),state={};
 try{
  const db=database(state),anchor=createFileSequenceAnchor(dir),audit=new PostgresAuthenticationFailureAudit({query:db.query,clock:()=>1,sequenceAnchor:anchor});
  for(let n=0;n<3;n++)await audit.record({reason:'unauthenticated'});
  assert.equal(await anchor.read(authenticationFailureAnchorKey),3);
  state.counter=1;await assert.rejects(audit.record({reason:'unauthenticated'}),/Audit log was rolled back/);assert.equal(db.inserts.length,3);
  writeFileSync(join(dir,authenticationFailureAnchorKey+'.sequence'),'garbage');await assert.rejects(audit.record({reason:'unauthenticated'}),/Audit sequence anchor unavailable/);
 }finally{cleanup(dir);}
});

test('an anchor that cannot advance is reported but does not fail the record, a throwing handler changes nothing, and invalid anchors are rejected',async()=>{
 const state={},db=database(state),reported=[];
 const down=Error('anchor down');
 const flaky=new PostgresCapabilityAudit({query:db.query,clock:()=>1,sequenceAnchor:{read:()=>0,advance:()=>{throw down;}},onAnchorError:error=>reported.push(error)});
 await flaky.record(event());assert.equal(state.counter,1,'the event was recorded although the anchor could not be advanced');assert.deepEqual(reported,[down],'the failure was reported');
 const throwing=new PostgresCapabilityAudit({query:db.query,clock:()=>1,sequenceAnchor:{read:()=>0,advance:()=>{throw down;}},onAnchorError:()=>{throw Error('handler failed');}});
 await throwing.record(event());assert.equal(state.counter,2,'a failing handler does not break recording');
 const failures=new PostgresAuthenticationFailureAudit({query:db.query,clock:()=>1,sequenceAnchor:{read:()=>0,advance:()=>Promise.reject(down)},onAnchorError:error=>reported.push(error)});
 await failures.record({reason:'unauthenticated'});assert.equal(reported.length,3,'one report for the first store, and two for the second (the catch-up before recording and the advance after it)');
 for(const read of [()=>{throw Error('down');},()=>-1,()=>1.5,()=>'2',()=>undefined]){
  const audit=new PostgresCapabilityAudit({query:db.query,clock:()=>1,sequenceAnchor:{read,advance:()=>{}}});await assert.rejects(audit.record(event()),/Audit sequence anchor unavailable/);
 }
 for(const bad of [{},{read:()=>1},{advance:()=>{}},null,'anchor']){
  assert.throws(()=>new PostgresCapabilityAudit({query:db.query,sequenceAnchor:bad}),/Invalid capability audit configuration/);
  assert.throws(()=>new PostgresAuthenticationFailureAudit({query:db.query,sequenceAnchor:bad}),/Invalid authentication audit configuration/);
 }
 const plain=new PostgresCapabilityAudit({query:db.query,clock:()=>1});const before=state.counter;await plain.record(event());assert.equal(state.counter,before+1,'without an anchor behaviour is unchanged');
});
