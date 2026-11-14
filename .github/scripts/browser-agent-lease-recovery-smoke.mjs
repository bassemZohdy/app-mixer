import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createProject} from '../../packages/cli/dist/index.js';
import {CapabilityRegistry,createCapabilityServer} from '../../packages/core/dist/index.js';
import {SqliteAgentRuns,SqliteAgentLeaseRecoveryHistory,registerAgentExpiredLeaseDiscovery,registerAgentLeaseRecovery,registerAgentLeaseRecoveryHistory} from '../../packages/agent/dist/index.js';

const dir=await mkdtemp(join(tmpdir(),'app-mixer-lease-browser-'));
const path=join(dir,'runs.sqlite'),runs=new SqliteAgentRuns(path),scope={tenantId:'tenant',agentId:'agent'},actor={tenantId:'tenant',principalId:'operator'},token='capability-secret-at-least-thirty-two-characters',registry=new CapabilityRegistry(()=>{});
let history,upstream,app,browser,timer,results;
let resolveResult,rejectResult;
const result=new Promise((resolve,reject)=>{resolveResult=resolve;rejectResult=reject;});
try{
 const create=(target,id)=>{const queued=runs.create(target,id,{definitionVersion:1,maxAttempts:2,deadline:1000},0);return runs.claim(target,id,queued.revision,'worker',50,10,10);};
 create(scope,'a-other');const targetRun=create(scope,'run');create({...scope,tenantId:'other'},'run');
 history=new SqliteAgentLeaseRecoveryHistory(path,{scope,authorize:()=>true});
 registerAgentExpiredLeaseDiscovery(registry,{runs,scope,operationId:'lease-list',path:'/lease-list',limit:1,cursorKey:randomBytes(32),clock:()=>100,authorize:()=>true});
 registerAgentLeaseRecovery(registry,{runs,scope,runId:'run',operationId:'lease-recover',path:'/lease-recover',clock:()=>100,authorize:()=>true});
 registerAgentLeaseRecoveryHistory(registry,{history,scope,operationId:'lease-history',path:'/lease-history',limit:10,authorize:()=>true});
 upstream=createCapabilityServer(registry,req=>req.headers.authorization===`Bearer ${token}`?actor:undefined,()=>{});upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 results=createServer(async(req,res)=>{const parts=[];for await(const part of req)parts.push(part);res.writeHead(204);res.end();resolveResult(Buffer.concat(parts).toString('utf8'));});results.listen(0,'127.0.0.1');await once(results,'listening');
 const target=await createProject('lease-browser',dir);
 const fixture=`<!doctype html><body><main></main><script type="module">
 import {mountAgentLeaseRecovery} from '/offline-runtime.mjs';
 const report=message=>fetch('http://127.0.0.1:${results.address().port}/result',{method:'POST',mode:'no-cors',body:message});
 const wait=async predicate=>{for(let i=0;i<500;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,20));}throw Error('Timed out: '+document.body.textContent);};
 try{
  const original=window.fetch;let lose=true;window.fetch=async(...args)=>{const response=await original(...args);if(lose&&String(args[0]).endsWith('/lease-recover')){lose=false;if(response.status!==200)throw Error('Recovery returned '+response.status);throw Error('response lost');}return response;};
  const root=document.querySelector('main'),button=text=>[...root.querySelectorAll('button')].find(element=>element.textContent===text),check=(value,message)=>{if(!value)throw Error(message);};
  mountAgentLeaseRecovery(root,{discoveryOperation:'lease-list',recoveryOperation:'lease-recover',historyOperation:'lease-history',runId:'run'});
  const input=root.querySelector('input');check(button('Mark lease uncertain').disabled,'Recovery initially enabled');button('Browse expired leases').click();await wait(()=>root.textContent.includes('Target not on this page'));button('Next lease page').click();await wait(()=>root.textContent.includes('revision ${targetRun.revision}'));
  input.value='case-1';input.dispatchEvent(new Event('input',{bubbles:true}));check(!button('Mark lease uncertain').disabled,'Recovery not enabled after review');button('Mark lease uncertain').click();await wait(()=>root.textContent.includes('Recovery outcome unknown'));check(button('Mark lease uncertain').disabled,'Recovery enabled after lost response');check(button('I reviewed the lease and history').disabled,'Review enabled too early');
  button('Browse expired leases').click();await wait(()=>root.textContent.includes('No expired lease for this run was found.'));check(button('I reviewed the lease and history').disabled,'History was not required');button('View recovery history').click();await wait(()=>root.textContent.includes('case-1'));check(!button('I reviewed the lease and history').disabled,'Review did not become available');button('I reviewed the lease and history').click();check(button('Mark lease uncertain').disabled,'Recovered lease can be submitted twice');check(root.textContent.includes('Verify the worker and external effects'),'Safety guidance missing');
  await report('pass');
 }catch(error){await report('fail:'+String(error));}
 </script></body>`;
 await writeFile(join(target,'index.html'),fixture);
 app=spawn(process.execPath,['server.mjs'],{cwd:target,env:{...process.env,PORT:'0',CONNECT_ORIGINS:`http://127.0.0.1:${results.address().port}`,CAPABILITY_URL:`http://127.0.0.1:${upstream.address().port}/capabilities/`,CAPABILITY_TOKEN:token},stdio:['ignore','pipe','pipe']});
 const url=await new Promise((resolve,reject)=>{let output='',errors='';app.stderr.on('data',chunk=>errors+=chunk);app.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match)resolve(match[0]);});app.once('error',reject);app.once('exit',code=>reject(Error(`Server exited ${code}: ${errors}`)));});
 browser=spawn(process.env.CHROME_BIN||'google-chrome',['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',`--user-data-dir=${join(dir,'profile')}`,url],{stdio:['ignore','ignore','pipe']});browser.stderr.resume();browser.once('error',rejectResult);browser.once('exit',code=>rejectResult(Error(`Browser exited before reporting: ${code}`)));timer=setTimeout(()=>rejectResult(Error('Lease recovery browser test timed out')),30000);
 assert.equal(await result,'pass');assert.equal(runs.get(scope,'run').status,'uncertain');assert.equal(runs.get(scope,'run').attempts,1);assert.equal(runs.get({...scope,tenantId:'other'},'run').status,'running');assert.equal((await history.list({tenantId:'tenant',principalId:'auditor'})).items.length,1);
}finally{
 clearTimeout(timer);for(const process of [browser,app])if(process&&process.exitCode===null&&process.signalCode===null){const stopped=once(process,'exit');process.kill();await stopped;}for(const server of [results,upstream])if(server?.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}history?.close();runs.close();await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200});
}
