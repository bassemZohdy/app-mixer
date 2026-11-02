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

test('development agent proposes and approves description changes after schema migration',async()=>{
 const repo=new ApplicationStore({id:'demo',schemaVersion:1,revision:0,pages:[{id:'home',title:'Home',route:'/',components:[]}]});repo.migrateDraft(0,2);const planes=createDevelopmentPlanes(repo,developer,token);try{const url=await start(planes.proposal),control=await start(planes.control);let prompt;const model={async *stream(messages){prompt=messages[0].content;yield JSON.stringify({patches:[{op:'setPageDescription',pageId:'home',description:'A useful home page'}]});}},agent=new DevelopmentAgent(model,createProposalClient(`${url}/proposals`,token)),draft=repo.getDraft(),proposal=await agent.propose('Describe the home page',draft);assert.equal(draft.schemaVersion,2);assert.match(prompt,/setPageDescription/);assert.match(prompt,/description,components/);assert.match(prompt,/Input.*label,path/);assert.equal(proposal.preview.pages[0].description,'A useful home page');assert.equal(repo.getDraft().pages[0].description,'');const response=await fetch(`${control}/proposals/${proposal.id}/approve`,{method:'POST',headers:{authorization:`Bearer ${developer}`}});assert.equal(response.status,200);assert.equal(repo.getDraft().pages[0].description,'A useful home page');assert.equal(repo.getPublished(),undefined);await assert.rejects(agent.propose('unsupported',{...draft,schemaVersion:3}),/Invalid development request/);
 }finally{await stop(planes.control);await stop(planes.proposal);}
});

test('migrated draft flows through development UI, approval, publication and workspace',{timeout:30000},async()=>{
 const {runInNewContext}=await import('node:vm'),{mkdtemp,rm}=await import('node:fs/promises'),{join}=await import('node:path'),{tmpdir}=await import('node:os'),{pathToFileURL}=await import('node:url'),{JSDOM}=await import('jsdom'),{createProject}=await import('../../cli/dist/index.js'),{A2UIRenderer,APP_MIXER_CATALOG,basicRegistry}=await import('../../web/dist/index.js'),dir=await mkdtemp(join(tmpdir(),'development-v2-flow-'));const repo=new ApplicationStore({id:'demo',schemaVersion:1,revision:0,pages:[{id:'home',title:'Home',route:'/',components:[]}]});repo.migrateDraft(0,2);let developmentAgent,dom;const planes=createDevelopmentPlanes(repo,developer,token,(instruction,draft)=>developmentAgent.propose(instruction,draft));try{const pp=await start(planes.proposal),cp=await start(planes.control),model={async *stream(){yield JSON.stringify({patches:[{op:'setPageDescription',pageId:'home',description:'Reviewed page details'},{op:'addComponent',pageId:'home',component:{id:'name',type:'Input',props:{label:'Name',path:'/name'}}},{op:'addComponent',pageId:'home',component:{id:'greeting',type:'Text',props:{path:'/name'}}}]});}};developmentAgent=new DevelopmentAgent(model,createProposalClient(`${pp}/proposals`,token));const html=await (await fetch(`${cp}/development`)).text();dom=new JSDOM(html);const document=dom.window.document,script=html.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/^\s*import [^;]+;\s*/gm,'');runInNewContext(script,{document,A2UIRenderer,APP_MIXER_CATALOG,basicRegistry,installedExtensions:[],fetch:(path,options)=>fetch(new URL(path,cp),options)});const wait=async predicate=>{for(let i=0;i<200&&!predicate();i++)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(predicate());};document.getElementById('token').value=developer;document.getElementById('instruction').value='Add a name field';document.getElementById('generate').click();await wait(()=>!document.getElementById('approve').disabled);const preview=document.getElementById('rendered-preview');assert.match(preview.textContent,/Reviewed page details/);assert.ok(preview.querySelector('input'));assert.equal(repo.getDraft().pages[0].description,'');assert.equal(repo.getPublished(),undefined);document.getElementById('approve').click();await wait(()=>!document.getElementById('publish').disabled);assert.equal(repo.getDraft().pages[0].description,'Reviewed page details');assert.equal(repo.getPublished(),undefined);document.getElementById('publish').click();await wait(()=>document.getElementById('status').textContent.startsWith('Published version'));const publication=repo.getPublished().definition;assert.equal(publication.schemaVersion,2);const target=await createProject('sample-app',dir),{prepareWorkspace}=await import(pathToFileURL(join(target,'workspace.mjs')).href),prepared=prepareWorkspace(publication),host=document.createElement('main');document.body.appendChild(host);const renderer=new A2UIRenderer(host,prepared.registry);renderer.apply({version:'v0.9.1',createSurface:{surfaceId:'main',catalogId:APP_MIXER_CATALOG}});renderer.apply({version:'v0.9.1',updateComponents:{surfaceId:'main',components:prepared.components}});assert.match(host.textContent,/Reviewed page details/);const input=host.querySelector('input');input.value='Ada';input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));assert.match(host.textContent,/Ada/);
 }finally{dom?.window.close();await stop(planes.control);await stop(planes.proposal);await rm(dir,{recursive:true,force:true});}
});

test('development proposal keeps the model snapshot revision when the caller mutates its draft',async()=>{
 const draft={id:'demo',schemaVersion:1,revision:4,pages:[]};let unblock,started,prompt,submitted;const gate=new Promise(resolve=>unblock=resolve),ready=new Promise(resolve=>started=resolve),model={async *stream(messages){prompt=messages[0].content;started();await gate;yield JSON.stringify({patches:[{op:'setPageTitle',pageId:'home',title:'Changed'}]});}},agent=new DevelopmentAgent(model,async(baseRevision,patches)=>{submitted={baseRevision,patches};return {id:'proposal',baseRevision,status:'pending',preview:{}};});try{const pending=agent.propose('Rename page',draft);await ready;draft.revision=5;draft.schemaVersion=2;draft.pages.push({id:'other'});unblock();const result=await pending;assert.equal(result.baseRevision,4);assert.equal(submitted.baseRevision,4);assert.match(prompt,/"revision":4/);assert.match(prompt,/"schemaVersion":1/);assert.doesNotMatch(prompt,/setPageDescription/);
 }finally{unblock?.();}
});

test('changed repository rejects an old proposal even if the supplied draft object is mutated',async()=>{
 const repo=new ApplicationStore({id:'demo',schemaVersion:1,revision:0,pages:[{id:'home',title:'Home',route:'/',components:[]}]}),planes=createDevelopmentPlanes(repo,developer,token);let unblock,started;const gate=new Promise(resolve=>unblock=resolve),ready=new Promise(resolve=>started=resolve);try{const url=await start(planes.proposal),draft=repo.getDraft(),agent=new DevelopmentAgent({async *stream(){started();await gate;yield JSON.stringify({patches:[{op:'setPageTitle',pageId:'home',title:'Stale'}]});}},createProposalClient(`${url}/proposals`,token));const pending=agent.propose('Rename page',draft);await ready;repo.apply(0,[{op:'setPageTitle',pageId:'home',title:'Concurrent'}]);draft.revision=1;unblock();await assert.rejects(pending,/Proposal service rejected/);assert.equal(repo.getDraft().revision,1);assert.equal(repo.getDraft().pages[0].title,'Concurrent');assert.equal(repo.getPublished(),undefined);
 }finally{unblock?.();await stop(planes.control);await stop(planes.proposal);}
});
