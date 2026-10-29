import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {JSDOM} from 'jsdom';
import {createProject} from '../dist/index.js';
import {CapabilityRegistry,createCapabilityServer,registerDataCapability,registerDataListCapability,registerStagedCapability,SqliteStagedOperations,SqliteDataProvider} from '../../core/dist/index.js';

const token='capability-secret-at-least-thirty-two-characters';
test('generated app uses an authenticated loopback capability service without exposing its token', {timeout:15000},async()=>{
 const provider=new SqliteDataProvider(':memory:'),staged=new SqliteStagedOperations(':memory:'),events=[],registry=new CapabilityRegistry(event=>events.push(event));let externalCalls=0,failExternal=false;
 const formFields=[{key:'name',label:'Name',type:'string',required:true},{key:'count',label:'Count',type:'integer',min:0},{key:'flag',label:'Flag',type:'boolean'}];
 const common={applicationId:'demo-app',collection:'items',authorize:ctx=>ctx.tenantId==='tenant'&&ctx.principalId==='local',validate:()=>true};
 for(const [operation,method] of [['get','GET'],['put','PUT']])registerDataCapability(registry,provider,{...common,operation,...(operation==='put'?{fields:formFields}:{}),candidate:{operationId:`items.${operation}`,method,path:'/items'}});
 registerDataListCapability(registry,provider,{candidate:{operationId:'items.list',method:'GET',path:'/items'},applicationId:'demo-app',collection:'items',cursorKey:randomBytes(32),authorize:common.authorize,authorizeItem:()=>true});
 registry.register({operationId:'orders.create',method:'POST',path:'/orders'},{authorize:ctx=>ctx.principalId==='local',validate:input=>input.payload.item==='x',execute:()=>{externalCalls++;if(failExternal)throw Error('uncertain result');return {ok:true};}});
 for(const operation of ['stage','get','submit'])registerStagedCapability(registry,registry,staged,{candidate:{operationId:`orders.${operation}`,method:'POST',path:'/stage'},applicationId:'demo-app',externalOperationId:'orders.create',operation,authorize:ctx=>ctx.principalId==='local',validate:()=>true});
 const upstream=createCapabilityServer(registry,req=>req.headers.authorization===`Bearer ${token}`?{tenantId:'tenant',principalId:'local'}:undefined,()=>{});
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const dir=await mkdtemp(join(tmpdir(),'app-mixer-capability-'));let server;
 try {
  const target=await createProject('demo-app',dir);
  server=spawn(process.execPath,['server.mjs'],{cwd:target,env:{...process.env,PORT:'0',CAPABILITY_URL:`http://127.0.0.1:${upstream.address().port}/capabilities/`,CAPABILITY_TOKEN:token},stdio:['ignore','pipe','pipe']});
  const url=await new Promise((resolve,reject)=>{let text='';server.stdout.on('data',chunk=>{text+=chunk;const match=text.match(/http:\/\/127\.0\.0\.1:\d+/);if(match)resolve(match[0]);});server.once('error',reject);server.once('exit',code=>reject(Error(`Server exited: ${code}`)));});
  const call=async(op,input,origin=url)=>{const res=await fetch(`${url}/api/capabilities/${op}`,{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify(input)});return {status:res.status,body:await res.json()};};
  assert.equal((await call('items.put',{id:'x',expectedRevision:null,value:{name:'Ada'}},'https://evil.example')).status,403);
  assert.equal((await call('items.put',{id:'x',expectedRevision:null,value:{name:'Ada'}})).body.result.revision,1);
  assert.deepEqual((await call('items.get',{id:'x'})).body.result.value,{name:'Ada'});
  assert.deepEqual((await call('items.list',{limit:1})).body.result.items.map(item=>item.id),['x']);
  assert.equal((await call('items.put',{id:'x',expectedRevision:1,value:{name:'Ada',count:'wrong'}})).status,400);assert.equal(provider.get({tenantId:'tenant',applicationId:'demo-app'},'items','x').revision,1);
  assert.equal((await call('items.put',{id:'x',expectedRevision:null,value:{name:'Other'}})).status,409);
  const originalFetch=globalThis.fetch;
  try {
   globalThis.fetch=(relative,options)=>originalFetch(new URL(relative,url),{...options,headers:{...options.headers,origin:url}});
   const client=await import(pathToFileURL(join(target,'capabilities.mjs')).href);
   assert.equal((await client.invokeCapability('items.get',{id:'x'})).value.name,'Ada');
   const order=await client.invokeCapability('orders.stage',{payload:{item:'x'},requestKey:'order-1'});assert.equal(externalCalls,0);
   assert.equal((await client.invokeCapability('orders.stage',{payload:{item:'x'},requestKey:'order-1'})).id,order.id);
   assert.deepEqual(await client.invokeCapability('orders.submit',{id:order.id}),{ok:true});assert.equal(externalCalls,1);
   await assert.rejects(client.invokeCapability('items.put',{id:'x',expectedRevision:null,value:{name:'Other'}}),error=>error.status===409);
   await assert.rejects(client.invokeCapability('../escape',{}),/Invalid capability ID/);
   const {createRecordEditor}=await import(pathToFileURL(join(target,'data-editor.mjs')).href);
   const {basicRegistry,A2UIRenderer,APP_MIXER_CATALOG}=await import(pathToFileURL(join(target,'renderer.mjs')).href);
   const dom=new JSDOM('<!doctype html><div id="host"></div>'),document=dom.window.document,registry=basicRegistry(),editor=createRecordEditor({getOperation:'items.get',putOperation:'items.put'});
   registry.register('record-editor',editor.render,editor.validate);const renderer=new A2UIRenderer(document.getElementById('host'),registry);
   renderer.apply({version:'v0.9.1',createSurface:{surfaceId:'main',catalogId:APP_MIXER_CATALOG}});
   renderer.apply({version:'v0.9.1',updateComponents:{surfaceId:'main',components:[{id:'root',component:'record-editor',label:'Item'}]}});
   const field=document.querySelector('input'),textarea=document.querySelector('textarea'),[load,save]=document.querySelectorAll('button'),status=document.querySelector('[role=status]');
   const waitFor=async phrase=>{for(let n=0;n<100&&!status.textContent.includes(phrase);n++)await new Promise(resolve=>setTimeout(resolve,10));assert.match(status.textContent,new RegExp(phrase));};
   field.value='x';field.dispatchEvent(new dom.window.Event('input'));load.click();await waitFor('Record loaded');
   textarea.value=JSON.stringify({name:'Changed'});save.click();await waitFor('Record saved');
   assert.equal(provider.get({tenantId:'tenant',applicationId:'demo-app'},'items','x').value.name,'Changed');
   provider.put({tenantId:'tenant',applicationId:'demo-app'},'items','x',{name:'External'},2);
   textarea.value=JSON.stringify({name:'Unsaved'});save.click();await waitFor('changed elsewhere');
   assert.equal(save.disabled,true);assert.equal(JSON.parse(textarea.value).name,'Unsaved');
   dom.window.close();
   provider.put({tenantId:'tenant',applicationId:'demo-app'},'items','x',{name:'External',count:2,flag:true,extra:'preserve'},3);
   const formDom=new JSDOM('<!doctype html>'),form=schemaEditor();function schemaEditor(){return createRecordEditor({getOperation:'items.get',putOperation:'items.put',fields:formFields}).render({label:'Item'},null,null,formDom.window.document)}formDom.window.document.body.appendChild(form);
   const fields=[...form.querySelectorAll('label')].map(label=>label.querySelector('input,select')),[formLoad,formSave]=form.querySelectorAll('button'),formStatus=form.querySelector('[role=status]');fields[0].value='x';fields[0].dispatchEvent(new formDom.window.Event('input'));formLoad.click();for(let n=0;n<100&&formStatus.textContent!=='Record loaded.';n++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(formStatus.textContent,'Record loaded.');fields[1].value='Updated';fields[1].dispatchEvent(new formDom.window.Event('input'));fields[2].value='3';fields[2].dispatchEvent(new formDom.window.Event('input'));formSave.click();for(let n=0;n<100&&formStatus.textContent!=='Record saved.';n++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(formStatus.textContent,'Record saved.');assert.deepEqual(provider.get({tenantId:'tenant',applicationId:'demo-app'},'items','x').value,{name:'Updated',count:3,flag:true,extra:'preserve'});formDom.window.close();
   const {createStagedEditor}=await import(pathToFileURL(join(target,'staged-editor.mjs')).href);
   const stagedDom=new JSDOM('<!doctype html><div id="host"></div>'),stagedDoc=stagedDom.window.document,stagedRegistry=basicRegistry(),stagedEditor=createStagedEditor({stageOperation:'orders.stage',getOperation:'orders.get',submitOperation:'orders.submit'});
   stagedRegistry.register('staged-editor',stagedEditor.render,stagedEditor.validate);const stagedRenderer=new A2UIRenderer(stagedDoc.getElementById('host'),stagedRegistry);
   stagedRenderer.apply({version:'v0.9.1',createSurface:{surfaceId:'main',catalogId:APP_MIXER_CATALOG}});
   stagedRenderer.apply({version:'v0.9.1',updateComponents:{surfaceId:'main',components:[{id:'root',component:'staged-editor',label:'Order'}]}});
   const stagedPayload=stagedDoc.querySelector('textarea'),stagedId=stagedDoc.querySelector('input'),[stage,newTransaction,check,submit]=stagedDoc.querySelectorAll('button'),stagedStatus=stagedDoc.querySelector('[role=status]');
   const waitStaged=async phrase=>{for(let n=0;n<100&&!stagedStatus.textContent.includes(phrase);n++)await new Promise(resolve=>setTimeout(resolve,10));assert.match(stagedStatus.textContent,new RegExp(phrase));};
   stagedPayload.value=JSON.stringify({item:'x'});stage.click();await waitStaged('Operation staged');assert.equal(externalCalls,1);assert.equal(submit.disabled,false);
   const firstId=stagedId.value;stage.click();for(let n=0;n<100&&stage.disabled;n++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(stage.disabled,false);await waitStaged('Operation staged');assert.equal(stagedId.value,firstId);assert.equal(externalCalls,1);
   submit.click();await waitStaged('Operation succeeded');assert.equal(externalCalls,2);assert.equal(submit.disabled,true);
   stagedId.value=firstId;stagedId.dispatchEvent(new stagedDom.window.Event('input'));check.click();await waitStaged('Operation succeeded');assert.equal(submit.disabled,true);
   failExternal=true;newTransaction.click();assert.equal(stagedId.value,'');stage.click();await waitStaged('Operation staged');assert.notEqual(stagedId.value,firstId);
   submit.click();await waitStaged('outcome may be uncertain');assert.equal(submit.disabled,true);
   check.click();await waitStaged('Operation uncertain');assert.equal(submit.disabled,true);assert.equal(externalCalls,3);

   stagedDom.window.close();

  } finally {globalThis.fetch=originalFetch;}
  assert.equal((await call('missing',{})).status,404);
  assert.ok(events.some(event=>event.outcome==='succeeded'));assert.doesNotMatch(await (await fetch(`${url}/capabilities.mjs`)).text(),new RegExp(token));
  await new Promise((resolve,reject)=>upstream.close(error=>error?reject(error):resolve()));
  assert.equal((await call('items.get',{id:'x'})).status,502);assert.equal((await fetch(`${url}/api/application`)).status,200);
 } finally {
  if(upstream.listening)await new Promise((resolve,reject)=>upstream.close(error=>error?reject(error):resolve()));
  if(server&&server.exitCode===null&&server.signalCode===null){const done=once(server,'exit');server.kill();await done;}
  provider.close();staged.close();await rm(dir,{recursive:true,force:true});
 }
});
