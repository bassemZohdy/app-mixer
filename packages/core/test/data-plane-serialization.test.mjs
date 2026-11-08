// The Data Plane serializes a publication once per request (the ETag is the digest of the body it sends), and not at
// all after the first request when the host promises its publications never change.
import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {createDataPlane} from '../dist/index.js';

const definition={id:'demo',schemaVersion:1,revision:0,pages:[{id:'home',route:'/',title:'Home',components:[]}]};
function counted(){const publication={version:3,definition,toJSON(){publication.serialized++;return {version:3,definition};},serialized:0};return publication;}
async function serve(options,publication){
 const plane=createDataPlane({getPublished:version=>version===undefined||version===3?publication:undefined},options);plane.listen(0,'127.0.0.1');await once(plane,'listening');
 return {base:`http://127.0.0.1:${plane.address().port}`,close:()=>new Promise(resolve=>{plane.closeAllConnections();plane.close(resolve);})};
}

test('a publication is serialized once per request, and the ETag is the digest of the body',async()=>{
 const publication=counted(),server=await serve({},publication);
 try{
  const response=await fetch(server.base+'/application'),body=await response.text();
  assert.equal(response.status,200);assert.equal(publication.serialized,1,'one serialization for the body and the ETag');
  assert.equal(response.headers.get('etag'),'"'+createHash('sha256').update(body).digest('hex')+'"');
  assert.deepEqual(JSON.parse(body),{version:3,definition});
  const again=await fetch(server.base+'/application',{headers:{'if-none-match':response.headers.get('etag')}});assert.equal(again.status,304);assert.equal(publication.serialized,2);
 }finally{await server.close();}
});

test('immutable publications are serialized once and served from memory afterwards',async()=>{
 const publication=counted(),server=await serve({immutablePublications:true},publication);
 try{
  const first=await fetch(server.base+'/application'),body=await first.text();
  for(let i=0;i<5;i++){const next=await fetch(server.base+'/application');assert.equal(await next.text(),body);assert.equal(next.headers.get('etag'),first.headers.get('etag'));}
  assert.equal((await fetch(server.base+'/application',{headers:{'if-none-match':first.headers.get('etag')}})).status,304);
  assert.equal(publication.serialized,1,'serialized once for six full responses and a 304');
  assert.equal((await fetch(server.base+'/application/versions/3')).status,200);assert.equal((await fetch(server.base+'/application/versions/9')).status,404);
 }finally{await server.close();}
});

test('the option must be a boolean',()=>{
 for(const bad of ['yes',1,null])assert.throws(()=>createDataPlane({getPublished(){return undefined;}},{immutablePublications:bad}),/Invalid data plane configuration/);
});
