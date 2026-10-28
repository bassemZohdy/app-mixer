import test from 'node:test';
import assert from 'node:assert/strict';
import {ApplicationStore,CachedPublishedRepository,PublishedDefinitionCache} from '../dist/index.js';
const scope={tenantId:'tenant-a',authorizationKey:'permissions-v1',applicationId:'demo',schemaVersion:1};
const initial={id:'demo',schemaVersion:1,revision:0,pages:[]};

test('version cache isolates scopes, clones values, expires and invalidates',()=>{
  let now=0,loads=0;const cache=new PublishedDefinitionCache(10,10,()=>now),value={version:1,definition:initial};
  const load=()=>{loads++;return value;};
  const first=cache.get(scope,1,load);first.definition.id='tampered';
  assert.equal(cache.get(scope,1,load).definition.id,'demo');assert.equal(loads,1);
  cache.get({...scope,tenantId:'tenant-b'},1,load);cache.get({...scope,authorizationKey:'other'},1,load);assert.equal(loads,3);
  now=11;cache.get(scope,1,load);assert.equal(loads,4);
  cache.invalidate(scope,1);cache.get(scope,1,load);assert.equal(loads,5);
  assert.throws(()=>cache.get({...scope,schemaVersion:2},1,load),/Incompatible/);
});

test('latest checks the source after publication and can recover after cache clear',()=>{
  const repo=new ApplicationStore(initial),cache=new PublishedDefinitionCache();
  const cached=new CachedPublishedRepository(repo,scope,cache);
  assert.equal(cached.getPublished(),undefined);repo.publish(0);assert.equal(cached.getPublished().version,1);
  repo.apply(0,[{op:'addPage',page:{id:'home',title:'Home',route:'/',components:[]}}]);repo.publish(1);
  assert.equal(cached.getPublished().version,2);assert.equal(cached.getPublished(1).definition.pages.length,0);
  cache.clear();assert.equal(cached.getPublished().definition.pages[0].title,'Home');
});

test('data plane serves cached immutable versions and fresh latest publications',async()=>{
  const {createDataPlane}=await import('../dist/index.js');const {once}=await import('node:events');
  const repo=new ApplicationStore(initial), cache=new PublishedDefinitionCache(), cached=new CachedPublishedRepository(repo,scope,cache);
  repo.publish(0);const server=createDataPlane(cached);server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const url=`http://127.0.0.1:${server.address().port}`;
    assert.equal((await (await fetch(`${url}/application`)).json()).version,1);
    repo.apply(0,[{op:'addPage',page:{id:'home',title:'Home',route:'/',components:[]}}]);repo.publish(1);
    assert.equal((await (await fetch(`${url}/application`)).json()).version,2);
    assert.equal((await (await fetch(`${url}/application/versions/1`)).json()).definition.pages.length,0);
    cache.clear();assert.equal((await (await fetch(`${url}/application`)).json()).version,2);
  }finally{await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
