import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createProject} from '../../packages/cli/dist/index.js';
import {CapabilityRegistry,createCapabilityServer} from '../../packages/core/dist/index.js';
import {SqliteAgentRuns,SqliteAgentTriggers,registerAgentManualStart} from '../../packages/agent/dist/index.js';

const dir=await mkdtemp(join(tmpdir(),'app-mixer-start-browser-'));
const path=join(dir,'runs.sqlite'),runs=new SqliteAgentRuns(path),triggers=new SqliteAgentTriggers(path),scope={tenantId:'tenant',agentId:'agent'},actor={tenantId:'tenant',principalId:'operator'},token='capability-secret-at-least-thirty-two-characters',registry=new CapabilityRegistry(()=>{});
let upstream,app,browser,timer,results,resolveResult,rejectResult;
const result=new Promise((resolve,reject)=>{resolveResult=resolve;rejectResult=reject;});
try{
 const manifest={manifestVersion:1,...scope,name:'Agent',owner:{kind:'organization',id:'org'},administrators:['admin'],servicePrincipalId:'service',model:{provider:'local',model:'model'},allowedCapabilities:[],lifecycle:{enabled:true,maxAttempts:2,runTimeoutMs:1000},quotas:{maxConcurrentRuns:1,maxTokensPerRun:100,maxRunsPerDay:10}};
 registerAgentManualStart(registry,{triggers,scope,sourceId:'manual',operationId:'manual-start',path:'/manual-start',maxPendingRuns:2,clock:()=>100,getDefinition:()=>({version:1,manifest}),authorize:()=>true});
 upstream=createCapabilityServer(registry,req=>req.headers.authorization===`Bearer ${token}`?actor:undefined,()=>{});upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 results=createServer(async(req,res)=>{const parts=[];for await(const part of req)parts.push(part);res.writeHead(204);res.end();resolveResult(Buffer.concat(parts).toString('utf8'));});results.listen(0,'127.0.0.1');await once(results,'listening');
 const target=await createProject('start-browser',dir);
 const fixture=`<!doctype html><body><main></main><script type="module">
 import {mountAgentManualStart} from '/offline-runtime.mjs';
 const report=message=>fetch('http://127.0.0.1:${results.address().port}/result',{method:'POST',mode:'no-cors',body:message});
 const wait=async predicate=>{for(let i=0;i<500;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,20));}throw Error('Timed out: '+document.body.textContent);};
 try{
  const original=window.fetch,calls=[];let lose=true;window.fetch=async(...args)=>{if(String(args[0]).endsWith('/manual-start'))calls.push(JSON.parse(args[1].body));const response=await original(...args);if(lose&&String(args[0]).endsWith('/manual-start')){lose=false;if(response.status!==200)throw Error('Start returned '+response.status);throw Error('response lost');}return response;};
  const root=document.querySelector('main'),button=text=>[...root.querySelectorAll('button')].find(element=>element.textContent===text),check=(value,message)=>{if(!value)throw Error(message);},fill=()=>{const fields=root.querySelectorAll('input');fields[0].value='request-1';fields[1].value='1';for(const field of fields)field.dispatchEvent(new Event('input',{bubbles:true}));};
  const options={startOperation:'manual-start',pendingStorage:sessionStorage,pendingKey:'manual-start'};let view=mountAgentManualStart(root,options);check(button('Start run').disabled,'Empty request accepted');fill();button('Start run').click();await wait(()=>root.textContent.includes('Start outcome unknown'));check([...root.querySelectorAll('input')].every(field=>field.disabled),'Unknown request was not locked');check(button('Start another request').disabled,'New request enabled after unknown response');view.dispose();view=mountAgentManualStart(root,options);check(root.querySelectorAll('input')[0].value==='request-1','Saved identity was not restored');button('Retry same request').click();await wait(()=>root.textContent.includes('Existing run:'));check(JSON.stringify(calls)===JSON.stringify([{requestId:'request-1',definitionVersion:1},{requestId:'request-1',definitionVersion:1}]),'Retry identity changed');button('Start another request').click();check(sessionStorage.getItem('manual-start')===null,'Saved request not cleared');check(button('Start run').disabled,'New request not cleared');
  await report('pass');
 }catch(error){await report('fail:'+String(error));}
 </script></body>`;
 await writeFile(join(target,'index.html'),fixture);
 app=spawn(process.execPath,['server.mjs'],{cwd:target,env:{...process.env,PORT:'0',CAPABILITY_URL:`http://127.0.0.1:${upstream.address().port}/capabilities/`,CAPABILITY_TOKEN:token},stdio:['ignore','pipe','pipe']});
 const url=await new Promise((resolve,reject)=>{let output='',errors='';app.stderr.on('data',chunk=>errors+=chunk);app.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match)resolve(match[0]);});app.once('error',reject);app.once('exit',code=>reject(Error(`Server exited ${code}: ${errors}`)));});
 browser=spawn(process.env.CHROME_BIN||'google-chrome',['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',`--user-data-dir=${join(dir,'profile')}`,url],{stdio:['ignore','ignore','pipe']});browser.stderr.resume();browser.once('error',rejectResult);browser.once('exit',code=>rejectResult(Error(`Browser exited before reporting: ${code}`)));timer=setTimeout(()=>rejectResult(Error('Manual start browser test timed out')),30000);
 assert.equal(await result,'pass');const ids=runs.queuedPage(scope).runIds;assert.equal(ids.length,1);assert.equal(triggers.get(scope,ids[0]).principalId,'operator');assert.equal(runs.queuedPage({...scope,tenantId:'other'}).runIds.length,0);
}finally{
 clearTimeout(timer);for(const process of [browser,app])if(process&&process.exitCode===null&&process.signalCode===null){const stopped=once(process,'exit');process.kill();await stopped;}for(const server of [results,upstream])if(server?.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}triggers.close();runs.close();await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200});
}
