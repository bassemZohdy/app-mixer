import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SqliteAgentRuns,SqliteAgentApprovals,createAgentApprovalServer} from '../dist/index.js';

test('review server validates disconnect cancellation configuration',()=>{
 assert.throws(()=>createAgentApprovalServer({authenticate:()=>undefined,resolve:()=>undefined,abortOnDisconnect:'yes'}),/Invalid approval server/);
});

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

test('review server bounds stalled approval policy and never commits a late decision',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'review-bounded-')),path=join(dir,'db'),scope={tenantId:'tenant',agentId:'agent'},service={tenantId:'tenant',principalId:'service'},runs=new SqliteAgentRuns(path);let release,entered,signal,block=true;
 const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>entered=resolve);let run=runs.create(scope,'run',{definitionVersion:1,maxAttempts:3,deadline:1000},0);run=runs.claim(scope,'run',run.revision,'worker',100,10);
 const approvals=new SqliteAgentApprovals(path,{scope,runId:'run',clock:()=>10,timeoutMs:100,maxPending:1,authorize:async(actor,access,_approval,current)=>{if(actor.principalId==='reviewer'&&access==='decide'&&block){signal=current;entered();await gate;}return true;}});
 await approvals.request(service,run.leaseToken,'action','pay',{amount:10},90);const server=createAgentApprovalServer({authenticate:()=>({tenantId:'tenant',principalId:'reviewer'}),resolve:()=>approvals});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const base=`http://127.0.0.1:${server.address().port}`,url=base+'/api/agents/agent/runs/run/approvals/action/decision',post=()=>fetch(url,{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({decision:'approved'})});
  const pending=post();await ready;assert.equal((await pending).status,503);assert.equal(signal.aborted,true);assert.equal((await post()).status,503);
  block=false;release();await new Promise(resolve=>setImmediate(resolve));assert.equal((await approvals.get(service,'action')).status,'pending');assert.equal((await post()).status,200);assert.deepEqual((await approvals.history(service,'action')).map(event=>event.event),['requested','approved']);
 }finally{release();await new Promise(resolve=>server.close(resolve));approvals.close();runs.close();rmSync(dir,{recursive:true,force:true});}
});

test('review server reports a changed approval without deciding it',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'review-race-')),path=join(dir,'db'),scope={tenantId:'tenant',agentId:'agent'},service={tenantId:'tenant',principalId:'service'},runs=new SqliteAgentRuns(path);let release,entered;const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>entered=resolve);
 let run=runs.create(scope,'run',{definitionVersion:1,maxAttempts:3,deadline:1000},0);run=runs.claim(scope,'run',run.revision,'worker',100,10);
 const approvals=new SqliteAgentApprovals(path,{scope,runId:'run',clock:()=>10,authorize:async(actor,access,approval)=>{if(actor.principalId==='reviewer'&&access==='decide'&&approval.operationId==='unknown'){entered();await gate;}return true;}}),server=createAgentApprovalServer({authenticate:()=>({tenantId:'tenant',principalId:'reviewer'}),resolve:()=>approvals});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const base=`http://127.0.0.1:${server.address().port}`,pending=fetch(base+'/api/agents/agent/runs/run/approvals/action/decision',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({decision:'approved'})});await ready;
  await approvals.request(service,run.leaseToken,'action','pay',{amount:10},90);release();assert.equal((await pending).status,409);assert.equal((await approvals.get(service,'action')).status,'pending');
 }finally{release();await new Promise(resolve=>server.close(resolve));approvals.close();runs.close();rmSync(dir,{recursive:true,force:true});}
});

test('review server applies one deadline across a slow approval listing',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'review-list-deadline-')),path=join(dir,'db'),scope={tenantId:'tenant',agentId:'agent'},service={tenantId:'tenant',principalId:'service'},runs=new SqliteAgentRuns(path);let slow=true;
 let run=runs.create(scope,'run',{definitionVersion:1,maxAttempts:3,deadline:1000},0);run=runs.claim(scope,'run',run.revision,'worker',100,10);
 const approvals=new SqliteAgentApprovals(path,{scope,runId:'run',clock:()=>10,timeoutMs:250,maxPending:1,authorize:async(actor,access)=>{if(slow&&actor.principalId==='reviewer'&&access==='read')await new Promise(resolve=>setTimeout(resolve,100));return true;}});
 for(const action of ['a','b','c'])await approvals.request(service,run.leaseToken,action,'pay',{action},90);
 const server=createAgentApprovalServer({authenticate:()=>({tenantId:'tenant',principalId:'reviewer'}),resolve:()=>approvals});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const url=`http://127.0.0.1:${server.address().port}/api/agents/agent/runs/run/approvals`,response=await fetch(url);assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'Review unavailable'});
  slow=false;await new Promise(resolve=>setTimeout(resolve,120));const retry=await fetch(url);assert.equal(retry.status,200);assert.equal((await retry.json()).items.length,3);
 }finally{await new Promise(resolve=>server.close(resolve));approvals.close();runs.close();rmSync(dir,{recursive:true,force:true});}
});

test('review server can cancel a pending decision when the reviewer disconnects',{timeout:10000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'review-disconnect-')),path=join(dir,'db'),scope={tenantId:'tenant',agentId:'agent'},service={tenantId:'tenant',principalId:'service'},runs=new SqliteAgentRuns(path);let release,entered,aborted,block=true;
 const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>entered=resolve),cancelled=new Promise(resolve=>aborted=resolve);let run=runs.create(scope,'run',{definitionVersion:1,maxAttempts:3,deadline:1000},0);run=runs.claim(scope,'run',run.revision,'worker',100,10);
 const approvals=new SqliteAgentApprovals(path,{scope,runId:'run',clock:()=>10,timeoutMs:1000,maxPending:1,authorize:async(actor,access,_approval,signal)=>{if(actor.principalId==='reviewer'&&access==='decide'&&block){signal.addEventListener('abort',aborted,{once:true});entered();await gate;}return true;}}),observer=new SqliteAgentApprovals(path,{scope,runId:'run',clock:()=>10,authorize:()=>true});
 await approvals.request(service,run.leaseToken,'action','pay',{amount:10},90);const options={authenticate:()=>({tenantId:'tenant',principalId:'reviewer'}),resolve:()=>approvals,abortOnDisconnect:true},server=createAgentApprovalServer(options);options.abortOnDisconnect=false;await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const base=`http://127.0.0.1:${server.address().port}`,url=base+'/api/agents/agent/runs/run/approvals/action/decision',controller=new AbortController(),post=signal=>fetch(url,{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({decision:'approved'}),signal});
  const pending=post(controller.signal).catch(()=>undefined);await ready;controller.abort();await pending;await cancelled;assert.equal((await observer.get(service,'action')).status,'pending');assert.equal((await post()).status,503);
  block=false;release();await new Promise(resolve=>setImmediate(resolve));assert.equal((await observer.get(service,'action')).status,'pending');assert.equal((await post()).status,200);assert.deepEqual((await observer.history(service,'action')).map(event=>event.event),['requested','approved']);
 }finally{release();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));observer.close();approvals.close();runs.close();rmSync(dir,{recursive:true,force:true});}
});

test('review disconnect fences late authentication and store resolution',{timeout:15000},async()=>{
 for(const phase of ['authenticate','resolve']){
  const dir=mkdtempSync(join(tmpdir(),'review-early-disconnect-')),path=join(dir,'db'),scope={tenantId:'tenant',agentId:'agent'},service={tenantId:'tenant',principalId:'service'},runs=new SqliteAgentRuns(path);let release,entered,closed,resolveCalls=0,decisionCalls=0;
  const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>entered=resolve),socketClosed=new Promise(resolve=>closed=resolve);let run=runs.create(scope,'run',{definitionVersion:1,maxAttempts:3,deadline:1000},0);run=runs.claim(scope,'run',run.revision,'worker',100,10);
  const approvals=new SqliteAgentApprovals(path,{scope,runId:'run',clock:()=>10,authorize:(_actor,access)=>{if(access==='decide')decisionCalls++;return true;}});await approvals.request(service,run.leaseToken,'action','pay',{amount:10},90);
  const server=createAgentApprovalServer({abortOnDisconnect:true,authenticate:async req=>{req.socket.once('close',closed);if(phase==='authenticate'){entered();await gate;}return {tenantId:'tenant',principalId:'reviewer'};},resolve:async()=>{resolveCalls++;if(phase==='resolve'){entered();await gate;}return approvals;}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
   const base=`http://127.0.0.1:${server.address().port}`,controller=new AbortController(),pending=fetch(base+'/api/agents/agent/runs/run/approvals/action/decision',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({decision:'approved'}),signal:controller.signal}).catch(()=>undefined);
   await ready;controller.abort();await pending;await socketClosed;release();await new Promise(resolve=>setImmediate(resolve));assert.equal(decisionCalls,0);if(phase==='authenticate')assert.equal(resolveCalls,0);assert.equal((await approvals.get(service,'action')).status,'pending');
  }finally{release();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));approvals.close();runs.close();rmSync(dir,{recursive:true,force:true});}
 }
});

test('review page renders untrusted input as text and keeps the reviewed run bound to its decision',async()=>{
 const {JSDOM}=await import('jsdom');const server=createAgentApprovalServer({authenticate:()=>undefined,resolve:()=>undefined});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;let dom;const requests=[];
 try{const html=await (await fetch(base+'/review')).text();dom=new JSDOM(html,{url:base+'/review',runScripts:'dangerously',beforeParse(window){window.fetch=async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>options.method==='POST'?{}:{items:[{actionId:'action',operationId:'pay',input:{value:'<img src=x onerror=alert(1)>'},status:'pending',definitionVersion:1,expiresAt:1000,requestedBy:'service'}]}}}}});
 const waitFor=async condition=>{for(let i=0;i<100&&!condition();i++)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(condition());};const document=dom.window.document;document.querySelector('#agent').value='agent';document.querySelector('#run').value='original';document.querySelector('#token').value='token';document.querySelector('#load').click();await waitFor(()=>document.querySelector('pre'));assert.equal(document.querySelector('pre').textContent.includes('<img'),true);assert.equal(document.querySelector('pre img'),null);document.querySelector('#run').value='different';[...document.querySelectorAll('article button')].find(button=>button.textContent==='Approve').click();await waitFor(()=>requests.length>=2);assert.equal(requests[1].url,'/api/agents/agent/runs/original/approvals/action/decision');assert.equal(requests[1].options.headers.authorization,'Bearer token');
 }finally{dom?.window.close();await new Promise(resolve=>server.close(resolve));}
});


test('notice API discovers scoped requests and records acknowledgement only for authenticated reviewers',async()=>{
 const {SqliteAgentNotices}=await import('../dist/index.js'),dir=mkdtempSync(join(tmpdir(),'review-notices-')),path=join(dir,'db'),scope={tenantId:'tenant',agentId:'agent'},runs=new SqliteAgentRuns(path);let run=runs.create(scope,'run',{definitionVersion:1,maxAttempts:3,deadline:1000},0);run=runs.claim(scope,'run',run.revision,'worker',100,10);const approvals=new SqliteAgentApprovals(path,{scope,runId:'run',clock:()=>10,authorize:()=>true}),notices=new SqliteAgentNotices(path,{scope,clock:()=>10,authorize:()=>true});await approvals.request({tenantId:'tenant',principalId:'service'},run.leaseToken,'action','pay',{amount:10},90);
 const server=createAgentApprovalServer({authenticate:req=>req.headers.authorization==='Bearer valid'?{tenantId:'tenant',principalId:'reviewer'}:undefined,resolve:()=>approvals,resolveNotices:()=>notices});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`,url=base+'/api/agents/agent/notices',headers={authorization:'Bearer valid'};try{assert.equal((await fetch(url)).status,401);const list=await (await fetch(url,{headers})).json();assert.equal(list.items[0].runId,'run');const post={method:'POST',headers:{...headers,origin:base,'content-type':'application/json'},body:'{}'};assert.equal((await fetch(url+'/1/ack',{...post,headers:{...post.headers,origin:'https://evil.example'}})).status,403);assert.equal((await fetch(url+'/1/ack',{...post,body:'{"principalId":"forged"}'})).status,400);assert.equal((await fetch(url+'/1/ack',post)).status,200);assert.equal((await (await fetch(url,{headers})).json()).items[0].acknowledgedAt,10);}finally{await new Promise(resolve=>server.close(resolve));notices.close();approvals.close();runs.close();rmSync(dir,{recursive:true,force:true})}
});

test('notice review renders safely and opens the selected run',async()=>{
 const {JSDOM}=await import('jsdom');const server=createAgentApprovalServer({authenticate:()=>undefined,resolve:()=>undefined});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`,requests=[];let dom;try{const html=await (await fetch(base+'/review')).text();dom=new JSDOM(html,{url:base+'/review',runScripts:'dangerously',beforeParse(window){window.fetch=async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>url.includes('/notices')?{items:[{id:1,kind:'approval_requested',runId:'run',subjectId:'<img onerror=alert(1)>',actionable:true,acknowledgedAt:null}]}:{items:[]}}}}});const doc=dom.window.document;doc.querySelector('#agent').value='agent';doc.querySelector('#token').value='token';doc.querySelector('#loadNotices').click();for(let i=0;i<100&&!doc.querySelector('#notices article');i++)await new Promise(resolve=>setTimeout(resolve,10));const article=doc.querySelector('#notices article');assert.ok(article);assert.equal(article.querySelector('img'),null);assert.match(article.textContent,/<img/);doc.querySelector('#agent').value='different';[...article.querySelectorAll('button')].find(b=>b.textContent==='Review approvals').click();for(let i=0;i<100&&requests.length<2;i++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(requests[1].url,'/api/agents/agent/runs/run/approvals');}finally{dom?.window.close();await new Promise(resolve=>server.close(resolve))}
});

test('notice review disconnect cancels acknowledgement and keeps the policy slot occupied',{timeout:10000},async()=>{
 const {SqliteAgentNotices}=await import('../dist/index.js'),dir=mkdtempSync(join(tmpdir(),'notice-disconnect-')),path=join(dir,'db'),scope={tenantId:'tenant',agentId:'agent'},runs=new SqliteAgentRuns(path);let release,entered,policyAborted,block=true;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve),aborted=new Promise(resolve=>policyAborted=resolve);
 let run=runs.create(scope,'run',{definitionVersion:1,maxAttempts:3,deadline:1000},0);run=runs.claim(scope,'run',run.revision,'worker',100,10);const approvals=new SqliteAgentApprovals(path,{scope,runId:'run',clock:()=>10,authorize:()=>true}),notices=new SqliteAgentNotices(path,{scope,clock:()=>10,timeoutMs:1000,maxPending:1,authorize:async(_actor,action,_notice,signal)=>{if(action==='acknowledge'&&block){entered();signal.addEventListener('abort',policyAborted,{once:true});await gate;}return true;}}),observer=new SqliteAgentNotices(path,{scope,clock:()=>10,authorize:()=>true});await approvals.request({tenantId:'tenant',principalId:'service'},run.leaseToken,'action','pay',{},90);
 const server=createAgentApprovalServer({authenticate:()=>({tenantId:'tenant',principalId:'reviewer'}),resolve:()=>approvals,resolveNotices:()=>notices,abortOnDisconnect:true});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`,url=base+'/api/agents/agent/notices/1/ack',post={method:'POST',headers:{origin:base,'content-type':'application/json'},body:'{}'},controller=new AbortController();
 try{const pending=fetch(url,{...post,signal:controller.signal});await started;controller.abort();await assert.rejects(pending);await aborted;assert.equal((await fetch(url,post)).status,503);assert.equal((await observer.list({tenantId:'tenant',principalId:'reviewer'})).items[0].acknowledgedAt,null);block=false;release();await new Promise(resolve=>setImmediate(resolve));assert.equal((await fetch(url,post)).status,200);}finally{release();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));observer.close();notices.close();approvals.close();runs.close();rmSync(dir,{recursive:true,force:true});}
});

test('disconnect signals authentication and store lookup for both review routes',{timeout:15000},async()=>{
 for(const route of ['approvals','notices'])for(const phase of ['authenticate','resolve']){
  let entered,aborted,release,resolveCalls=0,policyCalls=0;const ready=new Promise(resolve=>entered=resolve),cancelled=new Promise(resolve=>aborted=resolve),gate=new Promise(resolve=>release=resolve);
  const wait=async signal=>{assert.ok(signal instanceof AbortSignal);signal.addEventListener('abort',aborted,{once:true});entered();await gate;throw Error('late failure');};
  const server=createAgentApprovalServer({abortOnDisconnect:true,authenticate:async(_req,signal)=>{if(phase==='authenticate')await wait(signal);return {tenantId:'tenant',principalId:'reviewer'};},resolve:async(_scope,_run,signal)=>{resolveCalls++;if(phase==='resolve')await wait(signal);policyCalls++;return undefined;},resolveNotices:async(_scope,signal)=>{resolveCalls++;if(phase==='resolve')await wait(signal);policyCalls++;return undefined;}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{const base=`http://127.0.0.1:${server.address().port}`,path=route==='approvals'?'/api/agents/agent/runs/run/approvals':'/api/agents/agent/notices',controller=new AbortController(),request=fetch(base+path,{signal:controller.signal}).catch(()=>undefined);await ready;controller.abort();await request;await cancelled;assert.equal(policyCalls,0);if(phase==='authenticate')assert.equal(resolveCalls,0);release();await new Promise(resolve=>setImmediate(resolve));assert.equal(policyCalls,0);}finally{release();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 }
});
