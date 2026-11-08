import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {copyFileSync,existsSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ApplicationStore,SqliteApplicationStore,createControlPlane,createRemoteControlConnector} from '../dist/index.js';

const definition={id:'demo',schemaVersion:1,revision:0,pages:[{id:'home',route:'/',title:'Home',components:[]}]},token='source-secret-at-least-32-characters-long',actor={tenantId:'t',principalId:'admin'};
async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${server.address().port}`;}
async function close(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
const files=path=>[path,path+'-wal',path+'-shm'];
const copyDb=(from,to)=>{for(const [a,b] of files(from).map((f,i)=>[f,files(to)[i]])){if(existsSync(a))copyFileSync(a,b);else rmSync(b,{force:true});}};

test('a host-held promotion floor detects a restored target database before fetching',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'remote-floor-anchor-')),path=join(dir,'target.sqlite'),saved=join(dir,'saved.sqlite'),source=new ApplicationStore(definition);for(let i=0;i<4;i++)source.publish(0);
 let exports=0;const remote=createControlPlane(source,token);remote.prependListener('request',req=>{if(req.url.startsWith('/promotion/export'))exports++;});const url=await listen(remote);
 const anchor={value:0,fail:false,readFail:false,read:async()=>{if(anchor.readFail)throw Error('anchor down');return anchor.value;},advance:async n=>{if(anchor.fail)throw Error('anchor down');anchor.value=Math.max(anchor.value,n);}};
 const events=[];let target=new SqliteApplicationStore(path,definition);
 const connect=()=>createRemoteControlConnector({sourceOrigin:url,sourceToken:token,sourceEnvironment:'development',targetEnvironment:'production',applicationId:'demo',repository:target,allowLoopbackHttp:true,authorize:()=>true,audit:event=>events.push(event.phase),requireAdvancingSource:true,promotionFloorAnchor:anchor});
 try{
  let connector=connect();
  assert.equal((await connector.importPublication({actor,sourceVersion:1,expectedVersion:0})).version,1);assert.equal(anchor.value,1);
  target.close();copyDb(path,saved);target=new SqliteApplicationStore(path,definition);connector=connect();
  assert.equal((await connector.importPublication({actor,sourceVersion:2,expectedVersion:1})).version,2);assert.equal(anchor.value,2);
  // Restore the target to its state after the first import: its own floor goes back to 1 and would accept source version 2 again.
  target.close();copyDb(saved,path);target=new SqliteApplicationStore(path,definition);connector=connect();assert.equal(target.getPromotionFloor('development','production'),1);
  const before=exports;events.length=0;
  await assert.rejects(connector.importPublication({actor,sourceVersion:2,expectedVersion:1}),/Promotion floor rollback detected/);
  assert.equal(exports,before,'nothing is fetched from the source');assert.deepEqual(events,['attempt','floor_rejected']);assert.equal(target.getPublished().version,1);
  // Back on the real database, an already imported version is refused without fetching it.
  target.close();rmSync(path,{force:true});rmSync(path+'-wal',{force:true});rmSync(path+'-shm',{force:true});
  target=new SqliteApplicationStore(path,definition);connector=connect();
  await assert.rejects(connector.importPublication({actor,sourceVersion:2,expectedVersion:0}),/Promotion floor rollback detected/,'a replaced, empty target is also detected');
 }finally{target.close();await close(remote);rmSync(dir,{recursive:true,force:true});}
});

test('the promotion floor anchor catches up after a failed advance and fails closed when unreadable',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'remote-floor-anchor-')),path=join(dir,'target.sqlite'),source=new ApplicationStore(definition);for(let i=0;i<3;i++)source.publish(0);
 const remote=createControlPlane(source,token),url=await listen(remote),target=new SqliteApplicationStore(path,definition);
 const anchor={value:0,fail:false,readValue:undefined,readFail:false,read:async()=>{if(anchor.readFail)throw Error('anchor down');return anchor.readValue??anchor.value;},advance:async n=>{if(anchor.fail)throw Error('anchor down');anchor.value=Math.max(anchor.value,n);}};
 const base={sourceOrigin:url,sourceToken:token,sourceEnvironment:'development',targetEnvironment:'production',applicationId:'demo',repository:target,allowLoopbackHttp:true,authorize:()=>true,audit:()=>{}};
 try{
  for(const bad of [{promotionFloorAnchor:anchor},{requireAdvancingSource:true,promotionFloorAnchor:{read:async()=>0}},{requireAdvancingSource:true,promotionFloorAnchor:null}])assert.throws(()=>createRemoteControlConnector({...base,...bad}),/Invalid remote control configuration/);
  assert.throws(()=>createRemoteControlConnector({...base,repository:{promote:target.promote.bind(target),promoteAdvancing:target.promoteAdvancing.bind(target)},requireAdvancingSource:true,promotionFloorAnchor:anchor}),/Invalid remote control configuration/,'the repository must expose its retained floor');
  const connector=createRemoteControlConnector({...base,requireAdvancingSource:true,promotionFloorAnchor:anchor});
  anchor.fail=true;assert.equal((await connector.importPublication({actor,sourceVersion:1,expectedVersion:0})).version,1,'a committed import is not undone by an anchor outage');assert.equal(anchor.value,0);
  anchor.fail=false;await assert.rejects(connector.importPublication({actor,sourceVersion:1,expectedVersion:1}),/not newer than the promotion floor/);assert.equal(anchor.value,1,'the next import pushes the retained floor to the anchor');
  anchor.readFail=true;await assert.rejects(connector.importPublication({actor,sourceVersion:2,expectedVersion:1}),/Promotion floor unavailable/);anchor.readFail=false;
  for(const value of [-1,1.5,'2',Number.MAX_SAFE_INTEGER+1]){anchor.readValue=value;await assert.rejects(connector.importPublication({actor,sourceVersion:2,expectedVersion:1}),/Invalid promotion floor/);}anchor.readValue=undefined;
  assert.equal((await connector.importPublication({actor,sourceVersion:3,expectedVersion:1})).version,2);assert.equal(anchor.value,3);
 }finally{target.close();await close(remote);rmSync(dir,{recursive:true,force:true});}
});

test('a failing promotion floor anchor is reported to the host instead of being swallowed',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'remote-floor-anchor-')),path=join(dir,'target.sqlite'),source=new ApplicationStore(definition);for(let i=0;i<3;i++)source.publish(0);
 const remote=createControlPlane(source,token),url=await listen(remote),target=new SqliteApplicationStore(path,definition);
 const anchor={value:0,fail:false,read:async()=>anchor.value,advance:async n=>{if(anchor.fail)throw Error('anchor down');anchor.value=Math.max(anchor.value,n);}};
 const base={sourceOrigin:url,sourceToken:token,sourceEnvironment:'development',targetEnvironment:'production',applicationId:'demo',repository:target,allowLoopbackHttp:true,authorize:()=>true,audit:()=>{},requireAdvancingSource:true,promotionFloorAnchor:anchor};
 try{
  assert.throws(()=>createRemoteControlConnector({...base,onAnchorError:'log'}),/Invalid remote control configuration/);
  const reported=[];const connector=createRemoteControlConnector({...base,onAnchorError:error=>{reported.push(error.message);throw Error('a failing callback must not matter');}});
  anchor.fail=true;assert.equal((await connector.importPublication({actor,sourceVersion:1,expectedVersion:0})).version,1);
  assert.deepEqual(reported,['anchor down'],'the failed advance after a committed import is reported');
  // The next import finds the retained floor ahead of the anchor, fails to advance it again and reports that too.
  await assert.rejects(connector.importPublication({actor,sourceVersion:1,expectedVersion:1}),/not newer than the promotion floor/);
  assert.deepEqual(reported,['anchor down','anchor down']);
  anchor.fail=false;assert.equal((await connector.importPublication({actor,sourceVersion:2,expectedVersion:1})).version,2);assert.equal(anchor.value,2);assert.equal(reported.length,2);
 }finally{target.close();await close(remote);rmSync(dir,{recursive:true,force:true});}
});
