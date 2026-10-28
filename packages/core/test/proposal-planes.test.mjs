import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { ApplicationStore,createDevelopmentPlanes } from '../dist/index.js';
const developer='developer-token-at-least-32-characters-long';
const agent='agent-token-at-least-32-characters-long';
async function start(server){server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${server.address().port}`;}
async function stop(server){if(server.listening)await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
const auth=token=>({authorization:`Bearer ${token}`});
const post=(token,body)=>({method:'POST',headers:{...auth(token),'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});

test('agent can propose but only developer can approve and publish',async()=>{
  const repo=new ApplicationStore({id:'demo',schemaVersion:1,revision:0,pages:[]});
  assert.throws(()=>createDevelopmentPlanes(repo,developer,developer),/must differ/);
  const planes=createDevelopmentPlanes(repo,developer,agent);
  try{
    const cp=await start(planes.control), pp=await start(planes.proposal);
    const page={id:'home',route:'/',title:'Home',components:[]};
    const created=await fetch(`${pp}/proposals`,post(agent,{baseRevision:0,patches:[{op:'addPage',page}]}));
    assert.equal(created.status,201);const proposal=await created.json();
    assert.equal(proposal.preview.pages[0].title,'Home');assert.equal(repo.getDraft().pages.length,0);
    assert.equal((await fetch(`${cp}/proposals/${proposal.id}`,{headers:auth(agent)})).status,401);
    assert.equal((await fetch(`${cp}/proposals/${proposal.id}/approve`,post(agent))).status,401);
    assert.equal((await fetch(`${pp}/proposals/${proposal.id}/approve`,post(agent))).status,404);
    assert.equal((await fetch(`${pp}/publish`,post(agent,{expectedRevision:0}))).status,404);
    assert.equal((await fetch(`${cp}/proposals/${proposal.id}`,{headers:auth(developer)})).status,200);
    const approved=await fetch(`${cp}/proposals/${proposal.id}/approve`,post(developer));
    assert.equal(approved.status,200);assert.equal((await approved.json()).status,'approved');
    assert.equal(repo.getPublished(),undefined);
    assert.equal((await fetch(`${cp}/proposals/${proposal.id}/approve`,post(developer))).status,409);
    assert.equal((await fetch(`${cp}/publish`,post(developer,{expectedRevision:1}))).status,201);
    assert.equal(repo.getPublished().definition.pages[0].title,'Home');
  }finally{await stop(planes.control);await stop(planes.proposal);}
});

test('stale and malformed proposals fail without changing the draft',async()=>{
  const repo=new ApplicationStore({id:'demo',schemaVersion:1,revision:0,pages:[]});
  const planes=createDevelopmentPlanes(repo,developer,agent);
  try{
    const cp=await start(planes.control),pp=await start(planes.proposal);
    assert.equal((await fetch(`${pp}/proposals`,post(agent,{baseRevision:0,patches:[{op:'unknown'}]}))).status,400);
    const page={id:'home',route:'/',title:'Home',components:[]};
    const p=await (await fetch(`${pp}/proposals`,post(agent,{baseRevision:0,patches:[{op:'addPage',page}]}))).json();
    await fetch(`${cp}/draft/patches`,post(developer,{baseRevision:0,patches:[{op:'addPage',page:{...page,id:'other',route:'/other'}}]}));
    assert.equal((await fetch(`${cp}/proposals/${p.id}/approve`,post(developer))).status,409);
    assert.equal(repo.getDraft().pages[0].id,'other');
    assert.equal(repo.getPublished(),undefined);
    assert.equal((await fetch(`${cp}/proposals/${p.id}/reject`,post(developer))).status,200);
  }finally{await stop(planes.control);await stop(planes.proposal);}
});
