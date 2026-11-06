import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {readdirSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {ApplicationStore,AppMixerError,httpStatus,createControlPlane} from '../dist/index.js';

const token='t'.repeat(32),auth={authorization:'Bearer '+token,'content-type':'application/json'};

test('expected refusals carry a code, keep their message and cause, and map to one status each',()=>{
 const cause=new Error('database detail'),error=new AppMixerError('conflict','Revision conflict',{cause});
 assert.ok(error instanceof Error);assert.equal(error.code,'conflict');assert.equal(error.name,'AppMixerError');assert.equal(error.message,'Revision conflict');assert.equal(error.cause,cause);
 assert.deepEqual(['invalid','not_found','conflict','limit'].map(code=>httpStatus(new AppMixerError(code,'x'))),[400,404,409,429]);
 for(const other of [new Error('Revision conflict'),'text',null,undefined,{code:'conflict'}])assert.equal(httpStatus(other),undefined,'only AppMixerError maps to a status');
});

test('every AppMixerError thrown in core uses a code that maps to a status',()=>{
 const dir=fileURLToPath(new URL('../src/',import.meta.url));let sites=0;
 for(const name of readdirSync(dir).filter(file=>file.endsWith('.ts')))for(const match of readFileSync(join(dir,name),'utf8').matchAll(/new AppMixerError\('([a-z_]+)'/g)){sites++;assert.notEqual(httpStatus(new AppMixerError(match[1],'x')),undefined,`${name}: unknown code ${match[1]}`);}
 assert.ok(sites>=50,'the mapped refusals are thrown as AppMixerError ('+sites+' sites)');
});

test('the control plane maps by code, never by message text',async()=>{
 class Store extends ApplicationStore{apply(){throw new Error('Revision conflict');}}
 const failing=createControlPlane(new Store({id:'demo',schemaVersion:1,revision:0,pages:[]}),token);failing.listen(0,'127.0.0.1');await once(failing,'listening');
 const real=createControlPlane(new ApplicationStore({id:'demo',schemaVersion:1,revision:0,pages:[]}),token);real.listen(0,'127.0.0.1');await once(real,'listening');
 try{
  const body=JSON.stringify({baseRevision:0,patches:[{op:'addPage',page:{id:'home',title:'Home',route:'/',components:[]}}]}),post=(server,value=body)=>fetch(`http://127.0.0.1:${server.address().port}/draft/patches`,{method:'POST',headers:auth,body:value});
  const plain=await post(failing);assert.equal(plain.status,500,'a plain Error is internal even when its text matches a refusal');assert.deepEqual(await plain.json(),{error:'Internal server error'});
  assert.equal((await post(real)).status,200);
  const conflict=await post(real);assert.equal(conflict.status,409);assert.deepEqual(await conflict.json(),{error:'Revision conflict'});
  assert.equal((await post(real,JSON.stringify({baseRevision:1,patches:[{op:'setPageTitle',pageId:'missing',title:'x'}]}))).status,400);
 }finally{failing.close();real.close();}
});
