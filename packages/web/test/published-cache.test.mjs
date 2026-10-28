import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {ApplicationStore,PublishedDefinitionCache,CachedPublishedRepository,createDataPlane} from '../../core/dist/index.js';
import {ClientPublishedCache} from '../dist/index.js';
const scope={tenantId:'tenant-a',authorizationKey:'permissions-v1',applicationId:'demo',schemaVersion:1};
const initial={id:'demo',schemaVersion:1,revision:0,pages:[]};
const compatible=definition=>Array.isArray(definition.pages);

test('client revalidates against data plane and detects new published version',async()=>{
  const repo=new ApplicationStore(initial),serverCache=new PublishedDefinitionCache(),source=new CachedPublishedRepository(repo,scope,serverCache);repo.publish(0);
  const server=createDataPlane(source);server.listen(0,'127.0.0.1');await once(server,'listening');let statuses=[];
  try{
    const url=`http://127.0.0.1:${server.address().port}/application`;
    const load=async etag=>{const response=await fetch(url,{headers:etag?{'if-none-match':etag}:{},cache:'no-store'});statuses.push(response.status);return response.status===304?{status:304}:{status:response.status,etag:response.headers.get('etag'),publication:await response.json()};};
    const client=new ClientPublishedCache(scope,load,compatible);
    const first=await client.refresh();first.definition.id='tampered';assert.equal((await client.refresh()).definition.id,'demo');assert.deepEqual(statuses,[200,304]);
    repo.apply(0,[{op:'addPage',page:{id:'home',title:'Home',route:'/',components:[]}}]);repo.publish(1);
    assert.equal((await client.refresh()).version,2);assert.equal(statuses.at(-1),200);
    client.setScope({...scope,authorizationKey:'permissions-v2'});await client.refresh();assert.equal(statuses.at(-1),200);
    client.clear();serverCache.clear();assert.equal((await client.refresh()).version,2);
  }finally{await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});

test('scope changes and newer requests prevent stale async responses from populating cache',async()=>{
  let resolveFirst;const first=new Promise(resolve=>{resolveFirst=resolve;});let calls=0;
  const response={status:200,etag:'"'+'a'.repeat(64)+'"',publication:{version:1,definition:initial}};
  const client=new ClientPublishedCache(scope,()=>++calls===1?first:Promise.resolve(response),compatible);
  const pending=client.refresh();client.setScope({...scope,tenantId:'tenant-b'});resolveFirst(response);
  await assert.rejects(pending,/scope changed/);
  assert.equal((await client.refresh()).version,1);
  let release;const delayed=new Promise(resolve=>{release=resolve;});let n=0;
  const other=new ClientPublishedCache(scope,()=>++n===1?delayed:Promise.resolve(response),compatible);
  const old=other.refresh();await other.refresh();release(response);await assert.rejects(old,/superseded/);
});

test('rejects incompatible and unexpected cache responses',async()=>{
  const client=new ClientPublishedCache(scope,async()=>({status:304}),compatible);
  await assert.rejects(client.refresh(),/Unexpected/);
  const bad=new ClientPublishedCache(scope,async()=>({status:200,etag:'"'+'b'.repeat(64)+'"',publication:{version:1,definition:{...initial,id:'other'}}}),compatible);
  await assert.rejects(bad.refresh(),/Incompatible/);
});
