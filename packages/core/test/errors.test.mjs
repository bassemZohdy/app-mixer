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
 assert.ok(error instanceof Error);assert.equal(error.code,'conflict');assert.equal(error.name,'AppMixerError');assert.equal(error.message,'Revision conflict');assert.equal(error.cause,cause);assert.deepEqual(Object.keys(error),[],'name and code are not enumerable');assert.equal(JSON.stringify(error),'{}');
 assert.deepEqual(['invalid','denied','not_found','conflict','limit','unavailable'].map(code=>httpStatus(new AppMixerError(code,'x'))),[400,403,404,409,429,503]);
 for(const other of [new Error('Revision conflict'),'text',null,undefined,{code:'conflict'}])assert.equal(httpStatus(other),undefined,'httpStatus only maps AppMixerError');
 assert.equal(refusalStatus(new Error('Data revision conflict')),409);assert.equal(refusalStatus(new Error('Capability forbidden')),403);assert.equal(refusalStatus(new Error('Data schema guard unavailable')),503);assert.equal(refusalStatus(new AppMixerError('denied','x')),403);
 for(const other of [new Error('Revision conflict!'),new Error('constructor'),new Error('__proto__'),'text',null])assert.equal(refusalStatus(other),undefined);
});

test('every AppMixerError thrown in core uses a code that maps to a status',()=>{
 const dir=fileURLToPath(new URL('../src/',import.meta.url));let sites=0;
 for(const name of readdirSync(dir).filter(file=>file.endsWith('.ts')))for(const match of readFileSync(join(dir,name),'utf8').matchAll(/new AppMixerError\('([a-z_]+)'/g)){sites++;assert.notEqual(httpStatus(new AppMixerError(match[1],'x')),undefined,`${name}: unknown code ${match[1]}`);}
 assert.ok(sites>=218,'the mapped refusals are thrown as AppMixerError ('+sites+' sites)');
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

// TASK-002.1.2: the statuses the servers chose by message before error codes existed; a plain Error with exactly one of these messages keeps its status.
const PREVIOUS_STATUS_BY_MESSAGE={
 400:["Duplicate or invalid page","Invalid capability input","Invalid component","Invalid manifest","Invalid migration request","Invalid page description","Invalid promotion package","Invalid proposal","Unknown page","Unknown patch operation"],
 403:["Capability forbidden","Extension approval forbidden","Shared offline key forbidden"],
 404:["Capability not found","Definition read not found","Definition status not found","Delegation not found","Operation not found","Proposal not found","Publication not found","Run inspection not found"],
 409:["Data list changed","Data revision conflict","Data schema version conflict","Definition control conflict","Definition read changed","Definition status changed","Definition write conflict","Delegation conflict","Extension approval revision conflict","Extension compatibility failed","Invalid offline operation state","Invalid operation state","Lease discovery changed","Lease recovery not eligible","Lease recovery stale","Manual start conflict","Migration output conflict","Migration plan conflict","Migration snapshot conflict","Migration would lose page descriptions","No rollout requires recovery","Operation not staged","Proposal is not pending","Publication version conflict","Remote rollout state changed","Revision conflict","Rollback requires an earlier version","Rollout poller already running","Rollout poller requires review","Rollout recovery not verified","Rollout status changed","Run control conflict","Run inspection changed","Shared offline operation in progress","Shared offline outcome uncertain","Shared offline request conflict","Shared offline slot conflict","Staging request conflict","Stale offline recovery","Stale staged recovery","Stale staged verification","Unsupported schema migration"],
 429:["Manual start backlog full","Proposal limit reached"],
 503:["Budget recovery discovery unavailable","Budget recovery unavailable","Data ID prefix listing unavailable","Data capability unavailable","Data list unavailable","Data reverse listing unavailable","Data schema guard unavailable","Definition control history unavailable","Definition control unavailable","Definition history unavailable","Definition read unavailable","Definition status unavailable","Definition write unavailable","Delegation authorization unavailable","Delegation policy unavailable","Extension approval manage unavailable","Extension approval read unavailable","Extension decision policy unavailable","Extension policy unavailable","Extension validation unavailable","Lease discovery unavailable","Lease recovery history unavailable","Lease recovery unavailable","Manual start unavailable","Migration audit unavailable","Migration policy unavailable","Migration rehearsal unavailable","Migration status unavailable","Offline evidence unavailable","Offline listing unavailable","Offline recovery unavailable","Rollout control audit unavailable","Rollout evidence unavailable","Rollout poller unavailable","Rollout recovery unavailable","Rollout status unavailable","Run control history unavailable","Run control unavailable","Run inspection unavailable","Shared cost access unavailable","Shared cost capability unavailable","Staged evidence unavailable","Staged listing unavailable","Staged recovery unavailable","Staged summary unavailable","Staged verification unavailable"]
};
test('every message that used to select a status still selects the same one',()=>{
 let checked=0;
 for(const [status,messages] of Object.entries(PREVIOUS_STATUS_BY_MESSAGE))for(const message of messages){assert.equal(refusalStatus(new Error(message)),Number(status),message);checked++;}
 assert.equal(checked,111);
 for(const lookalike of ['Revision conflict ','revision conflict','Capability forbidden: detail','','constructor','__proto__','toString'])assert.equal(refusalStatus(new Error(lookalike)),undefined,lookalike);
});

// FIX-024: pages that core and agent embed as strings run in a browser, where AppMixerError and AgentError do not exist.
test('FIX-024 no coded-error constructor sits inside embedded browser code',async()=>{
 const found=[];
 for(const pkg of ['core','agent']){
  const dir=fileURLToPath(new URL('../../'+pkg+'/src/',import.meta.url));
  for(const name of readdirSync(dir).filter(file=>file.endsWith('.ts'))){
   const text=readFileSync(join(dir,name),'utf8'),stack=[];let i=0,line=1;
   const constructor=at=>/^new (AppMixerError|AgentError)\(/.test(text.slice(at,at+24));
   while(i<text.length){
    const c=text[i],inCode=stack.length===0||stack.at(-1)==='expr';
    if(c==='\n')line++;
    if(inCode){
     if(c==='/'&&text[i+1]==='/'){while(i<text.length&&text[i]!=='\n')i++;continue;}
     if(c==='/'&&text[i+1]==='*'){i+=2;while(i<text.length&&!(text[i]==='*'&&text[i+1]==='/')){if(text[i]==='\n')line++;i++;}i+=2;continue;}
     if(c==="'"||c==='"'){const quote=c;i++;while(i<text.length&&text[i]!==quote){if(text[i]==='\\')i++;i++;}i++;continue;}
     if(c==='`'){stack.push('template');i++;continue;}
     if(c==='}'&&stack.at(-1)==='expr'){stack.pop();i++;continue;}
     i++;continue;
    }
    if(c==='\\'){i+=2;continue;}
    if(c==='`'){stack.pop();i++;continue;}
    if(c==='$'&&text[i+1]==='{'){stack.push('expr');i+=2;continue;}
    if(constructor(i))found.push(pkg+'/src/'+name+':'+line);
    i++;
   }
  }
 }
 assert.deepEqual(found,[],'server-side error classes referenced by code that is sent to a browser');
 const {DEVELOPMENT_UI}=await import('../dist/development-ui.js');
 assert.ok(!/AppMixerError|AgentError/.test(DEVELOPMENT_UI),'the development review page script uses plain errors');
 assert.match(DEVELOPMENT_UI,/throw Error\('Invalid component'\)/,'the page still refuses an invalid component');
});
