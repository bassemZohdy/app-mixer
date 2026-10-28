import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {ApplicationStore,createDevelopmentPlanes} from '../../core/dist/index.js';
import {DevelopmentAgent,createProposalClient} from '../dist/index.js';
const developer='developer-token-at-least-32-characters-long',token='agent-token-at-least-32-characters-long';
async function start(server){server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${server.address().port}`;}
async function stop(server){if(server.listening)await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}

test('development model can propose but cannot modify or publish until developer approval',async()=>{
  const repo=new ApplicationStore({id:'demo',schemaVersion:1,revision:0,pages:[]});
  const planes=createDevelopmentPlanes(repo,developer,token);
  try{
    const url=await start(planes.proposal);
    let prompt;
    const model={async *stream(messages){prompt=messages[0].content;yield '{"patches":[';yield JSON.stringify({op:'addPage',page:{id:'home',title:'Home',route:'/',components:[]}});yield ']}';}};
    const agent=new DevelopmentAgent(model,createProposalClient(`${url}/proposals`,token));
    const proposal=await agent.propose('Create a home page',repo.getDraft());
    assert.match(prompt,/Create a home page/);assert.equal(proposal.status,'pending');
    assert.equal(proposal.preview.pages[0].title,'Home');
    assert.equal(repo.getDraft().pages.length,0);assert.equal(repo.getPublished(),undefined);
    const invalid=new DevelopmentAgent({async *stream(){yield '{"patches":[{"op":"unknown"}]}';}},createProposalClient(`${url}/proposals`,token));
    await assert.rejects(invalid.propose('bad',repo.getDraft()),/rejected/);
    assert.equal(repo.getDraft().pages.length,0);
    const cp=await start(planes.control);
    const approve=await fetch(`${cp}/proposals/${proposal.id}/approve`,{method:'POST',headers:{authorization:`Bearer ${developer}`}});
    assert.equal(approve.status,200);assert.equal(repo.getDraft().pages[0].title,'Home');assert.equal(repo.getPublished(),undefined);
  }finally{await stop(planes.control);await stop(planes.proposal);}
});

test('invalid model outputs and invalid endpoint fail without submitting',async()=>{
  let called=false;const submit=async()=>{called=true;throw Error('should not be called');};
  const draft={id:'demo',schemaVersion:1,revision:0,pages:[]};
  await assert.rejects(new DevelopmentAgent({async *stream(){yield 'not json';}},submit).propose('make page',draft),/not valid JSON/);
  await assert.rejects(new DevelopmentAgent({async *stream(){yield '{"patches":[],"code":"x"}';}},submit).propose('make page',draft),/Invalid model proposal/);
  assert.equal(called,false);
  assert.throws(()=>createProposalClient('https://example.com/proposals',token),/Invalid proposal endpoint/);
});
