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

test('developer UI requests a model proposal, reviews it, approves and publishes separately',async()=>{
  const {runInNewContext}=await import('node:vm');
  const repo=new ApplicationStore({id:'demo',schemaVersion:1,revision:0,pages:[]});
  let developmentAgent;
  const planes=createDevelopmentPlanes(repo,developer,token,(instruction,draft)=>developmentAgent.propose(instruction,draft));
  try{
    const pp=await start(planes.proposal),cp=await start(planes.control);
    const model={async *stream(){yield JSON.stringify({patches:[{op:'addPage',page:{id:'home',title:'Generated',route:'/',components:[]}}]});}};
    developmentAgent=new DevelopmentAgent(model,createProposalClient(`${pp}/proposals`,token));
    const html=await (await fetch(`${cp}/development`)).text();
    const script=html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];assert.ok(script);
    const executable=script.replace(/^\s*import [^;]+;\s*/gm,'');
    const {A2UIRenderer,APP_MIXER_CATALOG,basicRegistry}=await import('../../web/dist/index.js');
    const ids=['instruction','generate','token','proposal-id','status','patch','preview','rendered-preview','load','approve','reject','publish'];
    const elements=Object.fromEntries(ids.map(id=>[id,{value:'',textContent:'',disabled:false,listeners:{},addEventListener(event,handler){this.listeners[event]=handler;}}]));
    elements.token.value=developer;elements.instruction.value='Create a page';
    const document={body:{dataset:{}},getElementById:id=>elements[id],createElement:()=>element()};
    function element(){return {ownerDocument:document,children:[],style:{},dataset:{},textContent:'',appendChild(child){this.children.push(child);},replaceChildren(...children){this.children=children;}};}
    Object.assign(elements['rendered-preview'],element());
    runInNewContext(executable,{document,A2UIRenderer,APP_MIXER_CATALOG,basicRegistry,installedExtensions:[],fetch:(path,options)=>fetch(new URL(path,cp),options)});
    await elements.generate.listeners.click();
    assert.match(elements.preview.textContent,/Generated/);
    assert.equal(repo.getDraft().revision,0);assert.equal(repo.getPublished(),undefined);
    await elements.approve.listeners.click();
    assert.equal(repo.getDraft().revision,1);assert.equal(repo.getPublished(),undefined);
    await elements.publish.listeners.click();
    assert.equal(repo.getPublished().definition.pages[0].title,'Generated');
  }finally{await stop(planes.control);await stop(planes.proposal);}
});

test('the development agent proposes against schema version 2 drafts with the version 2 operations',async()=>{
  const repo=new ApplicationStore({id:'demo',schemaVersion:2,revision:0,pages:[{id:'home',title:'Home',description:'',route:'/',components:[]}]});
  const planes=createDevelopmentPlanes(repo,developer,token);
  try{
    const url=await start(planes.proposal),prompts=[];
    const model={async *stream(messages){prompts.push(messages[0].content);yield JSON.stringify({patches:[{op:'setPageDescription',pageId:'home',description:'Start here'}]});}};
    const agent=new DevelopmentAgent(model,createProposalClient(`${url}/proposals`,token));
    const proposal=await agent.propose('Describe the home page',repo.getDraft());
    assert.equal(proposal.preview.pages[0].description,'Start here');assert.match(prompts[0],/setPageDescription/);assert.match(prompts[0],/setExtensions/);assert.match(prompts[0],/Extension with extensionId and name/);
    const v1=new DevelopmentAgent(model,async()=>{throw Error('not reached');});
    await assert.rejects(v1.propose('x',{id:'demo',schemaVersion:3,revision:0,pages:[]}),/Invalid development request/);
    prompts.length=0;await assert.rejects(v1.propose('x',{id:'demo',schemaVersion:1,revision:0,pages:[]}),/not reached/);assert.doesNotMatch(prompts[0],/setPageDescription|setExtensions/,'version 1 drafts keep the basic operation list');
  }finally{await stop(planes.control);await stop(planes.proposal);}
});
