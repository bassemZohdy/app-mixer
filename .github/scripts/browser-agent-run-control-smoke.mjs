import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createProject} from '../../packages/cli/dist/index.js';
import {CapabilityRegistry,createCapabilityServer} from '../../packages/core/dist/index.js';
import {SqliteAgentRuns,SqliteAgentRunControlHistory,registerAgentRunInspection,registerAgentRunControl,registerAgentRunControlHistory} from '../../packages/agent/dist/index.js';

const dir=await mkdtemp(join(tmpdir(),'app-mixer-control-browser-'));
const path=join(dir,'runs.sqlite'),runs=new SqliteAgentRuns(path),scope={tenantId:'tenant',agentId:'agent'},actor={tenantId:'tenant',principalId:'operator'},token='capability-secret-at-least-thirty-two-characters',registry=new CapabilityRegistry(()=>{});
let history,upstream,app,browser,timer,results,resolveResult,rejectResult;
const result=new Promise((resolve,reject)=>{resolveResult=resolve;rejectResult=reject;});
try{
 const config={definitionVersion:1,maxAttempts:2,deadline:1000},other=runs.create(scope,'other',config,0);runs.request(scope,'other',other.revision,'pause',10,{principalId:'operator'});runs.create(scope,'run',config,0);runs.create({...scope,tenantId:'other'},'run',config,0);
 history=new SqliteAgentRunControlHistory(path,{scope,authorize:()=>true});registerAgentRunInspection(registry,{runs,scope,runId:'run',operationId:'inspect-run',path:'/inspect-run',authorize:()=>true});registerAgentRunControl(registry,{runs,scope,runId:'run',operationId:'control-run',path:'/control-run',clock:()=>100,authorize:()=>true});registerAgentRunControlHistory(registry,{history,scope,operationId:'control-history',path:'/control-history',limit:1,authorize:()=>true});
 upstream=createCapabilityServer(registry,req=>req.headers.authorization===`Bearer ${token}`?actor:undefined,()=>{});upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 results=createServer(async(req,res)=>{const parts=[];for await(const part of req)parts.push(part);res.writeHead(204);res.end();resolveResult(Buffer.concat(parts).toString('utf8'));});results.listen(0,'127.0.0.1');await once(results,'listening');
 const target=await createProject('control-browser',dir);
 const fixture=`<!doctype html><body><main></main><script type="module">
 import {mountAgentRunControl} from '/offline-runtime.mjs';
 const report=message=>fetch('http://127.0.0.1:${results.address().port}/result',{method:'POST',mode:'no-cors',body:message});
 const wait=async predicate=>{for(let i=0;i<500;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,20));}throw Error('Timed out: '+document.body.textContent);};
 try{
  const original=window.fetch;let lose=true;window.fetch=async(...args)=>{const response=await original(...args);if(lose&&String(args[0]).endsWith('/control-run')){lose=false;if(response.status!==200)throw Error('Control returned '+response.status);throw Error('response lost');}return response;};
  const root=document.querySelector('main'),button=text=>[...root.querySelectorAll('button')].find(element=>element.textContent===text),check=(value,message)=>{if(!value)throw Error(message);};
  mountAgentRunControl(root,{inspectionOperation:'inspect-run',controlOperation:'control-run',historyOperation:'control-history',runId:'run'});
  check(button('Pause run').disabled,'Control initially enabled');button('Inspect run').click();await wait(()=>root.textContent.includes('Status: queued, revision 1'));check(!button('Pause run').disabled,'Pause unavailable');button('Pause run').click();await wait(()=>root.textContent.includes('Control outcome unknown'));check(button('Resume run').disabled,'Control enabled after lost response');check(button('I reviewed the run and history').disabled,'Review enabled too early');
  button('Inspect run').click();await wait(()=>root.textContent.includes('Status: paused, revision 2'));button('View control history').click();await wait(()=>root.textContent.includes('Continue to the last page'));check(button('I reviewed the run and history').disabled,'Incomplete history accepted');button('Next history page').click();await wait(()=>root.textContent.includes('operator'));check(!button('I reviewed the run and history').disabled,'Review unavailable');button('I reviewed the run and history').click();check(button('Resume run').disabled,'Fresh inspection not required');button('Inspect run').click();await wait(()=>!button('Resume run').disabled);button('Resume run').click();await wait(()=>root.textContent.includes('Run resume request recorded'));button('Inspect run').click();await wait(()=>!button('Cancel run').disabled);check(button('Archive run').disabled,'Nonterminal run can be archived');button('Cancel run').click();await wait(()=>root.textContent.includes('Run cancel request recorded'));button('Inspect run').click();await wait(()=>!button('Archive run').disabled);button('Archive run').click();await wait(()=>root.textContent.includes('Run archive request recorded'));button('Inspect run').click();await wait(()=>root.textContent.includes('archived.'));check(button('Archive run').disabled,'Archived run can be archived twice');
  await report('pass');
 }catch(error){await report('fail:'+String(error));}
 </script></body>`;
 await writeFile(join(target,'index.html'),fixture);
 app=spawn(process.execPath,['server.mjs'],{cwd:target,env:{...process.env,PORT:'0',CONNECT_ORIGINS:`http://127.0.0.1:${results.address().port}`,CAPABILITY_URL:`http://127.0.0.1:${upstream.address().port}/capabilities/`,CAPABILITY_TOKEN:token},stdio:['ignore','pipe','pipe']});
 const url=await new Promise((resolve,reject)=>{let output='',errors='';app.stderr.on('data',chunk=>errors+=chunk);app.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match)resolve(match[0]);});app.once('error',reject);app.once('exit',code=>reject(Error(`Server exited ${code}: ${errors}`)));});
 browser=spawn(process.env.CHROME_BIN||'google-chrome',['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',`--user-data-dir=${join(dir,'profile')}`,url],{stdio:['ignore','ignore','pipe']});browser.stderr.resume();browser.once('error',rejectResult);browser.once('exit',code=>rejectResult(Error(`Browser exited before reporting: ${code}`)));timer=setTimeout(()=>rejectResult(Error('Run control browser test timed out')),30000);
 assert.equal(await result,'pass');assert.equal(runs.get(scope,'run').status,'cancelled');assert.equal(runs.get(scope,'run').archived,true);assert.equal(runs.get(scope,'run').revision,5);assert.equal(runs.get({...scope,tenantId:'other'},'run').status,'queued');const events=(await history.list({tenantId:'tenant',principalId:'auditor'})).items;assert.deepEqual(events.filter(event=>event.runId==='run').map(event=>[event.action,event.principalId]),[['pause','operator'],['resume','operator'],['cancel','operator'],['archive','operator']]);
}finally{
 clearTimeout(timer);for(const process of [browser,app])if(process&&process.exitCode===null&&process.signalCode===null){const stopped=once(process,'exit');process.kill();await stopped;}for(const server of [results,upstream])if(server?.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}history?.close();runs.close();await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200});
}
