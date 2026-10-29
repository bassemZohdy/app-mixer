import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SqliteAgentRuns,SqliteAgentApprovals,createAgentApprovalServer} from '../dist/index.js';

test('local review authenticates, scopes and authorizes decisions',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'review-')),path=join(dir,'db'),scope={tenantId:'tenant',agentId:'agent'},service={tenantId:'tenant',principalId:'service'},runs=new SqliteAgentRuns(path);
 let run=runs.create(scope,'run',{definitionVersion:1,maxAttempts:3,deadline:1000},0);run=runs.claim(scope,'run',run.revision,'worker',100,10);
 const approvals=new SqliteAgentApprovals(path,{scope,runId:'run',clock:()=>10,authorize:(actor,access)=>actor.principalId==='service'?access==='request':actor.principalId==='reviewer'});
 await approvals.request(service,run.leaseToken,'action','pay',{amount:10},90);
 const server=createAgentApprovalServer({authenticate:req=>req.headers.authorization==='Bearer valid'?{tenantId:'tenant',principalId:'reviewer'}:req.headers.authorization==='Bearer other'?{tenantId:'other',principalId:'reviewer'}:undefined,resolve:()=>approvals});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`,pathName='/api/agents/agent/runs/run/approvals',headers={authorization:'Bearer valid'},post={method:'POST',headers:{...headers,origin:base,'content-type':'application/json'},body:JSON.stringify({decision:'approved'})};
 try{
  const page=await fetch(base+'/review');assert.equal(page.status,200);assert.match(await page.text(),/Review agent approvals/);assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  assert.equal((await fetch(base+pathName)).status,401);assert.equal((await fetch(base+pathName,{headers:{authorization:'Bearer other'}})).status,404);assert.equal((await fetch(base+pathName,{headers})).status,200);
  const list=await (await fetch(base+pathName,{headers})).json();assert.deepEqual(list.items[0].input,{amount:10});
  assert.equal((await fetch(base+pathName+'/action/decision',{...post,headers:{...post.headers,origin:'https://evil.example'}})).status,403);
  assert.equal((await fetch(base+pathName+'/action/decision',{...post,body:JSON.stringify({decision:'approved',principalId:'forged'})})).status,400);
  const decided=await fetch(base+pathName+'/action/decision',post);assert.equal(decided.status,200);assert.equal((await decided.json()).decidedBy,'reviewer');assert.equal((await fetch(base+pathName+'/action/decision',post)).status,409);
  const history=await (await fetch(base+pathName+'/action/history',{headers})).json();assert.deepEqual(history.events.map(x=>x.event),['requested','approved']);
 }finally{await new Promise(resolve=>server.close(resolve));approvals.close();runs.close();rmSync(dir,{recursive:true,force:true});}
});

test('review page renders untrusted input as text and keeps the reviewed run bound to its decision',async()=>{
 const {JSDOM}=await import('jsdom');const server=createAgentApprovalServer({authenticate:()=>undefined,resolve:()=>undefined});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;let dom;const requests=[];
 try{const html=await (await fetch(base+'/review')).text();dom=new JSDOM(html,{url:base+'/review',runScripts:'dangerously',beforeParse(window){window.fetch=async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>options.method==='POST'?{}:{items:[{actionId:'action',operationId:'pay',input:{value:'<img src=x onerror=alert(1)>'},status:'pending',definitionVersion:1,expiresAt:1000,requestedBy:'service'}]}}}}});
 const waitFor=async condition=>{for(let i=0;i<100&&!condition();i++)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(condition());};const document=dom.window.document;document.querySelector('#agent').value='agent';document.querySelector('#run').value='original';document.querySelector('#token').value='token';document.querySelector('#load').click();await waitFor(()=>document.querySelector('pre'));assert.equal(document.querySelector('pre').textContent.includes('<img'),true);assert.equal(document.querySelector('pre img'),null);document.querySelector('#run').value='different';[...document.querySelectorAll('article button')].find(button=>button.textContent==='Approve').click();await waitFor(()=>requests.length>=2);assert.equal(requests[1].url,'/api/agents/agent/runs/original/approvals/action/decision');assert.equal(requests[1].options.headers.authorization,'Bearer token');
 }finally{dom?.window.close();await new Promise(resolve=>server.close(resolve));}
});

