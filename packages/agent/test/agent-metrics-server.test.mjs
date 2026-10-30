import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {request} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteAgentRuns,SqliteAgentRunMetrics,createAgentMetricsServer} from '../dist/index.js';

const scope={tenantId:'tenant-secret',agentId:'agent-secret'},actor={tenantId:'tenant-secret',principalId:'reader'},token='private-scrape-token';
function setup(authorize=()=>true){const dir=mkdtempSync(join(tmpdir(),'agent-metrics-http-')),path=join(dir,'runs.sqlite'),runs=new SqliteAgentRuns(path);runs.create(scope,'run-secret',{definitionVersion:1,maxAttempts:1,deadline:1000},0);return {dir,runs,metrics:new SqliteAgentRunMetrics(path,{scope,authorize})};}
async function start(server){server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${server.address().port}`;}
async function stop(server,s){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));s.metrics.close();s.runs.close();rmSync(s.dir,{recursive:true,force:true});}

test('agent metrics endpoint authenticates and authorizes a fixed scoped snapshot',async()=>{
 const s=setup(who=>who.principalId==='reader'),server=createAgentMetricsServer({metrics:s.metrics,authenticate:req=>req.headers.authorization===`Bearer ${token}`?actor:req.headers.authorization==='Bearer denied'?{...actor,principalId:'denied'}:undefined,timeoutMs:500,maxPending:2}),base=await start(server);
 try{assert.equal((await fetch(base+'/metrics')).status,401);assert.equal((await fetch(base+'/metrics',{headers:{authorization:'Bearer denied'}})).status,403);assert.equal((await fetch(base+'/other')).status,404);assert.equal((await fetch(base+'/metrics',{method:'POST'})).status,404);const response=await fetch(base+'/metrics',{headers:{authorization:`Bearer ${token}`}});assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/version=0\.0\.4/);assert.equal(response.headers.get('cache-control'),'no-store');const text=await response.text();assert.match(text,/app_mixer_agent_runs\{status="queued",archived="false"\} 1/);for(const secret of [token,scope.tenantId,scope.agentId,'run-secret','reader'])assert.equal(text.includes(secret),false);}finally{await stop(server,s);}
});

test('timed-out authentication is aborted and consumes its slot until it settles',async()=>{
 const s=setup();let finish,signal,calls=0;const gate=new Promise(resolve=>finish=resolve),server=createAgentMetricsServer({metrics:s.metrics,authenticate:async(_req,s)=>{signal=s;calls++;if(calls===1)await gate;return actor;},timeoutMs:100,maxPending:1}),base=await start(server);
 try{assert.equal((await fetch(base+'/metrics')).status,503);assert.equal(signal.aborted,true);assert.equal((await fetch(base+'/metrics')).status,503);assert.equal(calls,1);finish();for(let i=0;i<100;i++){const response=await fetch(base+'/metrics');if(response.status===200)break;if(i===99)assert.fail('scrape slot was not released');await new Promise(resolve=>setTimeout(resolve,10));}assert.equal(calls,2);}finally{finish();await stop(server,s);}
});

test('stalled authorization is bounded and denied or failed callbacks do not expose details',async()=>{
 let finish,entered,calls=0;const gate=new Promise(resolve=>finish=resolve),ready=new Promise(resolve=>entered=resolve),s=setup(async()=>{calls++;if(calls===1){entered();await gate;}return true;}),server=createAgentMetricsServer({metrics:s.metrics,authenticate:()=>actor,timeoutMs:100,maxPending:1}),base=await start(server);
 try{const pending=fetch(base+'/metrics');await ready;assert.equal((await pending).status,503);assert.equal((await fetch(base+'/metrics')).status,503);finish();for(let i=0;i<100;i++){const response=await fetch(base+'/metrics');if(response.status===200)break;if(i===99)assert.fail('scrape slot was not released');await new Promise(resolve=>setTimeout(resolve,10));}assert.ok(calls>=3);}finally{finish();await stop(server,s);}
 const other=setup(),failed=createAgentMetricsServer({metrics:other.metrics,authenticate:()=>{throw Error('private credential');},timeoutMs:100,maxPending:1}),url=await start(failed);try{const response=await fetch(url+'/metrics');assert.equal(response.status,401);assert.doesNotMatch(await response.text(),/private/);}finally{await stop(failed,other);}
});

test('client disconnect aborts authentication without opening another pending slot',async()=>{
 const s=setup();let finish,entered,signal;const gate=new Promise(resolve=>finish=resolve),ready=new Promise(resolve=>entered=resolve),server=createAgentMetricsServer({metrics:s.metrics,authenticate:async(_req,abort)=>{signal=abort;entered();await gate;return actor;},timeoutMs:1000,maxPending:1}),base=await start(server);
 try{const req=request(base+'/metrics');req.on('error',()=>{});req.end();await ready;req.destroy();for(let i=0;i<100&&!signal.aborted;i++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(signal.aborted,true);assert.equal((await fetch(base+'/metrics')).status,503);finish();}finally{finish();await stop(server,s);}
});
