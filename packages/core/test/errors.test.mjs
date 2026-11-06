import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {readdirSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {ApplicationStore,AppMixerError,httpStatus,refusalStatus,createControlPlane} from '../dist/index.js';

const token='t'.repeat(32),auth={authorization:'Bearer '+token,'content-type':'application/json'};

test('expected refusals carry a code, keep their message and cause, and map to one status each',()=>{
 const cause=new Error('database detail'),error=new AppMixerError('conflict','Revision conflict',{cause});
 assert.ok(error instanceof Error);assert.equal(error.code,'conflict');assert.equal(error.name,'AppMixerError');assert.equal(error.message,'Revision conflict');assert.equal(error.cause,cause);
 assert.deepEqual(['invalid','denied','not_found','conflict','limit','unavailable'].map(code=>httpStatus(new AppMixerError(code,'x'))),[400,403,404,409,429,503]);
 for(const other of [new Error('Revision conflict'),'text',null,undefined,{code:'conflict'}])assert.equal(httpStatus(other),undefined,'httpStatus only maps AppMixerError');
 assert.equal(refusalStatus(new Error('Data revision conflict')),409);assert.equal(refusalStatus(new Error('Capability forbidden')),403);assert.equal(refusalStatus(new Error('Data schema guard unavailable')),503);assert.equal(refusalStatus(new AppMixerError('denied','x')),403);
 for(const other of [new Error('Revision conflict!'),new Error('constructor'),new Error('__proto__'),'text',null])assert.equal(refusalStatus(other),undefined);
});

test('every AppMixerError thrown in core uses a code that maps to a status',()=>{
 const dir=fileURLToPath(new URL('../src/',import.meta.url));let sites=0;
 for(const name of readdirSync(dir).filter(file=>file.endsWith('.ts')))for(const match of readFileSync(join(dir,name),'utf8').matchAll(/new AppMixerError\('([a-z_]+)'/g)){sites++;assert.notEqual(httpStatus(new AppMixerError(match[1],'x')),undefined,`${name}: unknown code ${match[1]}`);}
 assert.ok(sites>=70,'the mapped refusals are thrown as AppMixerError ('+sites+' sites)');
});

test('the control plane maps by code, with only documented plain messages as legacy',async()=>{
 class Store extends ApplicationStore{apply(){throw new Error('Revision conflict');}}
 const failing=createControlPlane(new Store({id:'demo',schemaVersion:1,revision:0,pages:[]}),token);failing.listen(0,'127.0.0.1');await once(failing,'listening');
 const real=createControlPlane(new ApplicationStore({id:'demo',schemaVersion:1,revision:0,pages:[]}),token);real.listen(0,'127.0.0.1');await once(real,'listening');
 try{
  const body=JSON.stringify({baseRevision:0,patches:[{op:'addPage',page:{id:'home',title:'Home',route:'/',components:[]}}]}),post=(server,value=body)=>fetch(`http://127.0.0.1:${server.address().port}/draft/patches`,{method:'POST',headers:auth,body:value});
  // Host repositories have always reported these refusals by message, so a plain Error with exactly a documented message keeps its status; anything else is internal.
  const plain=await post(failing);assert.equal(plain.status,409);assert.deepEqual(await plain.json(),{error:'Revision conflict'});
  const odd=createControlPlane(new class extends ApplicationStore{apply(){throw new Error('Revision conflict (internal detail)');}}({id:'demo',schemaVersion:1,revision:0,pages:[]}),token);odd.listen(0,'127.0.0.1');await once(odd,'listening');
  try{const internal=await post(odd);assert.equal(internal.status,500);assert.deepEqual(await internal.json(),{error:'Internal server error'});}finally{odd.close();}
  assert.equal((await post(real)).status,200);
  const conflict=await post(real);assert.equal(conflict.status,409);assert.deepEqual(await conflict.json(),{error:'Revision conflict'});
  assert.equal((await post(real,JSON.stringify({baseRevision:1,patches:[{op:'setPageTitle',pageId:'missing',title:'x'}]}))).status,400);
 }finally{failing.close();real.close();}
});

test('the capability server maps expected refusals by code, honours documented legacy messages and hides everything else',async()=>{
 const {CapabilityRegistry,createCapabilityServer}=await import('../dist/index.js');
 const registry=new CapabilityRegistry(()=>{});
 const refuse=(id,make)=>registry.register({operationId:id,method:'POST',path:'/'+id},{authorize:()=>true,validate:()=>true,execute:()=>{throw make();}});
 refuse('coded',()=>new AppMixerError('conflict','Version moved'));refuse('unavailable',()=>new AppMixerError('unavailable','Guard offline'));refuse('legacy',()=>new Error('Data revision conflict'));refuse('boom',()=>new Error('database exploded: secret'));refuse('lookalike',()=>new Error('Data revision conflict, retry later: secret'));
 const server=createCapabilityServer(registry,()=>({tenantId:'t',principalId:'p'}),()=>{});server.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  const call=async id=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/capabilities/${id}/invoke`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer x'},body:JSON.stringify({origin:'ui',input:{}})});return [response.status,await response.json()];};
  assert.deepEqual(await call('coded'),[409,{error:'Version moved'}]);
  assert.deepEqual(await call('unavailable'),[503,{error:'Guard offline'}]);
  assert.deepEqual(await call('legacy'),[409,{error:'Data revision conflict'}]);
  assert.deepEqual(await call('boom'),[500,{error:'Capability invocation failed'}]);
  assert.deepEqual(await call('lookalike'),[500,{error:'Capability invocation failed'}],'only exact documented messages are honoured, so internal detail is not echoed');
  assert.deepEqual(await call('missing'),[404,{error:'Capability not found'}]);
 }finally{server.closeAllConnections();server.close();}
});
