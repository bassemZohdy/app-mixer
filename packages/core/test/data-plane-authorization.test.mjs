import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {ApplicationStore,createDataPlane} from '../dist/index.js';
const initial={id:'demo',schemaVersion:1,revision:0,pages:[]};
test('publication authorization precedes reads and conditional responses while probes remain available',async()=>{
 const store=new ApplicationStore(initial);store.publish(0);let result=true,seen=[];const server=createDataPlane(store,{health:{timeoutMs:100},authorizePublication:async(req,version)=>{seen.push(version);if(result==='error')throw Error('private');return result&&req.headers.authorization==='Bearer allowed';}});server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
 try{assert.equal((await fetch(base+'/health/ready')).status,200);assert.equal((await fetch(base+'/health/live')).status,200);assert.equal(seen.length,0);assert.equal((await fetch(base+'/application')).status,403);const ok=await fetch(base+'/application',{headers:{authorization:'Bearer allowed'}});assert.equal(ok.status,200);const etag=ok.headers.get('etag');assert.equal((await fetch(base+'/application',{headers:{'if-none-match':etag}})).status,403);assert.equal((await fetch(base+'/application',{headers:{'if-none-match':etag,authorization:'Bearer allowed'}})).status,304);assert.equal((await fetch(base+'/application/versions/1',{headers:{authorization:'Bearer allowed'}})).status,200);assert.deepEqual(seen,[undefined,undefined,undefined,undefined,1]);result='error';const failed=await fetch(base+'/application');assert.equal(failed.status,503);assert.doesNotMatch(await failed.text(),/private/);}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
