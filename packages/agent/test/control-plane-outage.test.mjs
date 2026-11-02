import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SqliteApplicationStore,createControlPlane,createDataPlane} from '../../core/dist/index.js';
import {SqliteAgentDefinitions,SqliteAgentRuns} from '../dist/index.js';
const scope={tenantId:'tenant',agentId:'operations'},manifest={manifestVersion:1,...scope,name:'Operations',owner:{kind:'organization',id:'org'},administrators:['admin'],servicePrincipalId:'service-account',model:{provider:'local',model:'test'},allowedCapabilities:['lookup'],lifecycle:{enabled:true,maxAttempts:2,runTimeoutMs:10000},quotas:{maxConcurrentRuns:1,maxTokensPerRun:1000,maxRunsPerDay:10}},token='a-strong-local-token-at-least-32-characters';
const start=async server=>{server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${server.address().port}`;};
const stop=async server=>{if(server?.listening){server.closeAllConnections();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}};

test('published data and durable configured agent remain available after control plane shutdown',{timeout:30000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'offline-control-plane-')),appPath=join(dir,'app.sqlite'),runPath=join(dir,'runs.sqlite'),definitionPath=join(dir,'agent.sqlite'),initial={id:'demo',schemaVersion:1,revision:0,pages:[]};let controlStore,dataStore,definitions,runs,control,data,child;
 try{
  controlStore=new SqliteApplicationStore(appPath,initial);dataStore=new SqliteApplicationStore(appPath,initial);control=createControlPlane(controlStore,token);data=createDataPlane(dataStore);const cp=await start(control),dp=await start(data),post=body=>({method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)});let response=await fetch(cp+'/draft/patches',post({baseRevision:0,patches:[{op:'addPage',page:{id:'home',title:'Published',route:'/',components:[]}}]}));assert.equal(response.status,200);assert.equal((await fetch(cp+'/publish',post({expectedRevision:1}))).status,201);
  definitions=new SqliteAgentDefinitions(definitionPath);definitions.save('tenant',manifest,0);definitions.close();definitions=undefined;runs=new SqliteAgentRuns(runPath);runs.create(scope,'one',{definitionVersion:1,maxAttempts:2,deadline:Date.now()+60000});runs.create({...scope,tenantId:'other'},'foreign',{definitionVersion:1,maxAttempts:2,deadline:Date.now()+60000});runs.close();runs=undefined;
  await stop(control);controlStore.close();controlStore=undefined;await assert.rejects(fetch(cp+'/draft',{signal:AbortSignal.timeout(2000)}));assert.equal((await (await fetch(dp+'/application')).json()).definition.pages[0].title,'Published');
  child=fork(fileURLToPath(new URL('./fixtures/offline-control-plane-worker.mjs',import.meta.url)),[runPath,definitionPath,dp],{stdio:['ignore','ignore','pipe','ipc']});let stderr='';child.stderr.on('data',chunk=>stderr+=String(chunk));const message=once(child,'message'),exit=once(child,'exit');const [result]=await Promise.race([message,exit.then(()=>{throw Error('Worker exited before reporting: '+stderr);})]);const [code]=await exit;child=undefined;assert.equal(code,0,stderr);assert.equal(result.error,undefined);assert.deepEqual(result,{status:'succeeded',publicationStatus:200,publicationVersion:1,page:'Published',calls:1,principal:'service-account',auditPrincipals:['service-account','service-account']});runs=new SqliteAgentRuns(runPath);assert.equal(runs.get(scope,'one').status,'succeeded');assert.equal(runs.get({...scope,tenantId:'other'},'foreign').status,'queued');assert.equal((await fetch(dp+'/application')).status,200);
 }finally{if(child&&child.exitCode===null&&child.signalCode===null){const finished=once(child,'exit');child.kill('SIGKILL');await finished;}await stop(control);await stop(data);controlStore?.close();dataStore?.close();definitions?.close();runs?.close();await rm(dir,{recursive:true,force:true});}
});
