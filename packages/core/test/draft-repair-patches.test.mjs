import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { ApplicationStore, SqliteApplicationStore, DevelopmentProposals, createControlPlane, createDevelopmentPlanes } from '../dist/index.js';

const developer = 'developer-token-at-least-32-characters-long';
const agent = 'agent-token-at-least-32-characters-long';
async function start(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; }
async function stop(server) { if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
const post = (token, body) => ({method:'POST', headers:{authorization:`Bearer ${token}`, 'content-type':'application/json'}, ...(body === undefined ? {} : {body:JSON.stringify(body)})});

const initial = () => ({id:'demo', schemaVersion:1, revision:0, pages:[
  {id:'home', route:'/', title:'Home', components:[
    {id:'intro', type:'Text', props:{text:'Welcome'}},
    {id:'name', type:'Input', props:{label:'Your name', path:'name'}},
    {id:'status', type:'Card', props:{title:'Status', text:'Ready'}},
  ]},
  {id:'about', route:'/about', title:'About', components:[{id:'intro', type:'Text', props:{text:'About us'}}]},
]});
const stores = {
  'in-memory store': () => new ApplicationStore(initial()),
  'SQLite store': () => new SqliteApplicationStore(':memory:', initial()),
};

for (const [name, create] of Object.entries(stores)) {
  test(`FEAT-026: removeComponent, setComponentProps and removePage change only their target (${name})`, () => {
    const store = create();
    try {
      let expected = initial();
      expected.revision = 1; expected.pages[0].components.splice(1, 1);
      assert.deepEqual(store.apply(0, [{op:'removeComponent', pageId:'home', componentId:'name'}]), expected);
      assert.deepEqual(store.getDraft(), expected);

      expected = structuredClone(expected);
      expected.revision = 2; expected.pages[0].components[0].props = {path:'/greeting', variant:'h2'};
      assert.deepEqual(store.apply(1, [{op:'setComponentProps', pageId:'home', componentId:'intro', props:{path:'/greeting', variant:'h2'}}]), expected);
      assert.deepEqual(store.getDraft(), expected, 'the same component id on another page is untouched');

      expected = structuredClone(expected);
      expected.revision = 3; expected.pages.splice(1, 1);
      assert.deepEqual(store.apply(2, [{op:'removePage', pageId:'about'}]), expected);
      assert.deepEqual(store.getDraft(), expected);

      // A removed id and route can be used again, and props can be cleared.
      const page = {id:'about', route:'/about', title:'About again', components:[]};
      const draft = store.apply(3, [{op:'addPage', page}, {op:'addComponent', pageId:'home', component:{id:'name', type:'Input', props:{label:'Your name', path:'/name'}}}, {op:'setComponentProps', pageId:'home', componentId:'status', props:{}}]);
      assert.deepEqual(draft.pages[1], page);
      assert.deepEqual(draft.pages[0].components.map(component => component.id), ['intro', 'status', 'name']);
      assert.deepEqual(draft.pages[0].components[1], {id:'status', type:'Card', props:{}});
    } finally { store.close?.(); }
  });

  test(`FEAT-026: an unknown page or component returns 400 and leaves the draft unchanged (${name})`, async () => {
    const store = create(), control = createControlPlane(store, developer);
    try {
      const url = await start(control);
      const send = async patches => { const response = await fetch(`${url}/draft/patches`, post(developer, {baseRevision:0, patches})); return [response.status, (await response.json()).error]; };
      assert.deepEqual(await send([{op:'removeComponent', pageId:'missing', componentId:'intro'}]), [400, 'Unknown page']);
      assert.deepEqual(await send([{op:'removeComponent', pageId:'about', componentId:'name'}]), [400, 'Unknown component']);
      assert.deepEqual(await send([{op:'setComponentProps', pageId:'missing', componentId:'intro', props:{text:'x'}}]), [400, 'Unknown page']);
      assert.deepEqual(await send([{op:'setComponentProps', pageId:'home', componentId:'missing', props:{text:'x'}}]), [400, 'Unknown component']);
      assert.deepEqual(await send([{op:'removePage', pageId:'missing'}]), [400, 'Unknown page']);
      // Patches are atomic: a valid removal before an unknown target is not kept.
      assert.deepEqual(await send([{op:'removeComponent', pageId:'home', componentId:'name'}, {op:'removePage', pageId:'missing'}]), [400, 'Unknown page']);
      assert.deepEqual(await send([{op:'removePage', pageId:'about'}, {op:'removeComponent', pageId:'about', componentId:'intro'}]), [400, 'Unknown page']);
      assert.deepEqual(store.getDraft(), initial());
      for (const patch of [
        {op:'removeComponent', pageId:'home'},
        {op:'removeComponent', pageId:'home', componentId:''},
        {op:'removeComponent', pageId:'home', componentId:'name', extra:true},
        {op:'setComponentProps', pageId:'home', componentId:'intro'},
        {op:'setComponentProps', pageId:'home', componentId:'intro', props:[]},
        {op:'setComponentProps', pageId:'home', componentId:'intro', props:{text:{nested:true}}},
        {op:'setComponentProps', pageId:'home', componentId:'intro', props:{text:'x'}, type:'Card'},
        {op:'removePage'},
        {op:'removePage', pageId:7},
        {op:'removePage', pageId:'about', extra:true},
      ]) assert.deepEqual(await send([patch]), [400, 'Invalid patch request'], JSON.stringify(patch));
      assert.deepEqual(store.getDraft(), initial());
      assert.equal((await fetch(`${url}/draft/patches`, post(agent, {baseRevision:0, patches:[{op:'removePage', pageId:'about'}]}))).status, 401);
      assert.equal((await fetch(`${url}/draft/patches`, post(developer, {baseRevision:0, patches:[{op:'removeComponent', pageId:'home', componentId:'name'}]}))).status, 200);
      assert.equal((await fetch(`${url}/draft/patches`, post(developer, {baseRevision:0, patches:[{op:'removePage', pageId:'about'}]}))).status, 409);
    } finally { await stop(control); store.close?.(); }
  });
}

test('FEAT-026: the store refuses setComponentProps without a props object', () => {
  const store = new ApplicationStore(initial());
  for (const props of [undefined, null, [], 'text']) assert.throws(() => store.apply(0, [{op:'setComponentProps', pageId:'home', componentId:'intro', props}]), /Invalid component/);
  assert.deepEqual(store.getDraft(), initial());
});

test('FEAT-026: a proposal carrying the repair patches previews and approves', async () => {
  const repo = new ApplicationStore(initial());
  const planes = createDevelopmentPlanes(repo, developer, agent);
  try {
    const cp = await start(planes.control), pp = await start(planes.proposal);
    const patches = [
      {op:'setComponentProps', pageId:'home', componentId:'name', props:{label:'Your name', path:'/name'}},
      {op:'removeComponent', pageId:'home', componentId:'status'},
      {op:'removePage', pageId:'about'},
    ];
    const created = await fetch(`${pp}/proposals`, post(agent, {baseRevision:0, patches}));
    assert.equal(created.status, 201);
    const proposal = await created.json();
    const expected = initial();
    expected.revision = 1; expected.pages.splice(1, 1); expected.pages[0].components.splice(2, 1); expected.pages[0].components[1].props = {label:'Your name', path:'/name'};
    assert.deepEqual(proposal.preview, expected);
    assert.deepEqual(proposal.patches, patches);
    assert.deepEqual(repo.getDraft(), initial(), 'a preview does not change the draft');
    for (const invalid of [[{op:'removeComponent', pageId:'home'}], [{op:'setComponentProps', pageId:'home', componentId:'name', props:{path:['/name']}}], [{op:'removePage', pageId:'about', extra:true}]])
      assert.equal((await fetch(`${pp}/proposals`, post(agent, {baseRevision:0, patches:invalid}))).status, 400);
    assert.equal((await fetch(`${pp}/proposals`, post(agent, {baseRevision:0, patches:[{op:'removePage', pageId:'missing'}]}))).status, 400);
    assert.equal((await fetch(`${cp}/proposals/${proposal.id}/approve`, post(agent))).status, 401);
    const approved = await fetch(`${cp}/proposals/${proposal.id}/approve`, post(developer));
    assert.equal(approved.status, 200);
    assert.equal((await approved.json()).approvedRevision, 1);
    assert.deepEqual(repo.getDraft(), expected);
  } finally { await stop(planes.control); await stop(planes.proposal); }
});

test('FEAT-026: proposals validate the shape of the repair patches', () => {
  const proposals = new DevelopmentProposals(new ApplicationStore(initial()));
  assert.throws(() => proposals.propose(0, [{op:'removeComponent', pageId:'home', componentId:7}]), /Invalid proposal/);
  assert.throws(() => proposals.propose(0, [{op:'setComponentProps', pageId:'home', componentId:'intro', props:null}]), /Invalid proposal/);
  assert.throws(() => proposals.propose(0, [{op:'removePage', pageId:''}]), /Invalid proposal/);
  assert.throws(() => proposals.propose(0, [{op:'removeComponent', pageId:'home', componentId:'missing'}]), /Unknown component/);
  assert.equal(proposals.propose(0, [{op:'removePage', pageId:'about'}]).preview.pages.length, 1);
});
