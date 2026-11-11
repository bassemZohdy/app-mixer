import test from 'node:test';
import assert from 'node:assert/strict';
import {PostgresPublicationReleaseRegistry} from '../dist/index.js';

const scope={tenantId:'tenant',applicationId:'app',environment:'prod'},digest='a'.repeat(64);
/** A stand-in for the database: a floor value (or no row) and the answer to the allow query. */
function database(state){
 const calls=[];
 return {calls,query:async(sql,args)=>{
  calls.push(sql.slice(0,40));
  if(sql.startsWith('SELECT minimum_version'))return {rows:state.floor===undefined?[]:[{minimum_version:state.floor}],rowCount:state.floor===undefined?0:1};
  if(sql.startsWith('SELECT 1 AS allowed'))return {rows:state.allowed?[{allowed:1}]:[],rowCount:state.allowed?1:0};
  if(sql.startsWith('INSERT INTO app_mixer_release_floors')){state.floor=Math.max(state.floor??0,args[3]);return {rows:[{minimum_version:state.floor}],rowCount:1};}
  throw Error('unexpected query '+sql.slice(0,30));
 }};
}

test('a floor anchor must have read and advance functions',()=>{
 const db=database({});
 for(const bad of [{},{read:()=>1},{advance:()=>{}},null,'anchor'])assert.throws(()=>new PostgresPublicationReleaseRegistry({query:db.query,floorAnchor:bad}),/Invalid publication release configuration/);
 assert.doesNotThrow(()=>new PostgresPublicationReleaseRegistry({query:db.query}));
});

test('a database floor below the anchored floor is refused as a rolled-back database',async()=>{
 const state={floor:3,allowed:true},db=database(state),anchored=new Map([['tenant/app/prod',4]]);
 const releases=new PostgresPublicationReleaseRegistry({query:db.query,floorAnchor:{read:s=>anchored.get(`${s.tenantId}/${s.applicationId}/${s.environment}`)??0,advance:()=>{}}});
 await assert.rejects(releases.isAllowed(scope,3,digest),/Release floor was rolled back/);
 assert.ok(!db.calls.some(sql=>sql.startsWith('SELECT 1 AS allowed')),'the allow query is not reached when the floor went back');
 state.floor=undefined;await assert.rejects(releases.isAllowed(scope,3,digest),/rolled back/,'a missing floor row is below a positive anchor');
});

test('a matching or higher database floor is accepted and a lagging anchor is caught up',async()=>{
 const state={floor:5,allowed:true},db=database(state),anchored=new Map(),advances=[];
 const releases=new PostgresPublicationReleaseRegistry({query:db.query,floorAnchor:{read:s=>anchored.get(s.tenantId)??0,advance:(s,floor)=>{advances.push(floor);anchored.set(s.tenantId,floor);}}});
 assert.equal(await releases.isAllowed(scope,5,digest),true);assert.deepEqual(advances,[5],'the anchor was behind and is advanced to the database floor');
 assert.equal(await releases.isAllowed(scope,5,digest),true);assert.deepEqual(advances,[5],'no advance when they agree');
 state.allowed=false;assert.equal(await releases.isAllowed(scope,4,digest),false,'the normal floor and allowlist check still applies');
 state.floor=undefined;anchored.set('tenant',0);assert.equal(await releases.isAllowed(scope,1,digest),false,'a fresh database with a zero anchor is not a rollback');
});

test('an unreadable or invalid anchor fails closed and an anchor failure on advance does not fail the advance',async()=>{
 const state={floor:2,allowed:true},db=database(state);
 for(const read of [()=>{throw Error('anchor down');},()=>Promise.reject(Error('anchor down')),()=>-1,()=>1.5,()=>'2',()=>undefined]){
  const releases=new PostgresPublicationReleaseRegistry({query:db.query,floorAnchor:{read,advance:()=>{}}});
  await assert.rejects(releases.isAllowed(scope,2,digest),/Release floor anchor unavailable/);
 }
 const flaky=new PostgresPublicationReleaseRegistry({query:db.query,floorAnchor:{read:()=>0,advance:()=>{throw Error('anchor down');}}});
 assert.equal(await flaky.advanceFloor(scope,7),7,'the database advance is returned even if the anchor could not be advanced');
 assert.equal(state.floor,7);
 const advances=[];const tracking=new PostgresPublicationReleaseRegistry({query:db.query,floorAnchor:{read:()=>0,advance:(s,floor)=>{advances.push([s.environment,floor]);}}});
 await tracking.advanceFloor(scope,9);assert.deepEqual(advances,[['prod',9]],'advanceFloor mirrors the new floor to the anchor');
 const without=new PostgresPublicationReleaseRegistry({query:db.query});assert.equal(await without.isAllowed(scope,9,digest),true,'without an anchor behaviour is unchanged');
});
