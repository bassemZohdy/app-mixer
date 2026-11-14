import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplicationStore, SqliteApplicationStore, createControlPlane, createDevelopmentPlanes } from '../dist/index.js';

const developer = 'developer-token-at-least-32-characters-long';
const agent = 'agent-token-at-least-32-characters-long';
async function start(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; }
async function stop(server) { if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
const post = (token, body) => ({method:'POST', headers:{authorization:`Bearer ${token}`, 'content-type':'application/json'}, ...(body === undefined ? {} : {body:JSON.stringify(body)})});
const refuses = (action, pattern) => assert.throws(action, error => { assert.match(error.message, pattern); return true; });
const send = async (url, token, body) => { const response = await fetch(url, post(token, body)); return [response.status, (await response.json()).error]; };

const definition = (...components) => ({id:'demo', schemaVersion:1, revision:0, pages:[{id:'home', route:'/', title:'Home', components:[{id:'intro', type:'Text', props:{text:'Welcome'}}, ...components]}]});
// What the renderers refuse: the workspace then shows only an error.
const unrenderable = [
  {name:'an Input with a relative path', component:{id:'name', type:'Input', props:{label:'Your name', path:'name'}}, message:/^Invalid component "name" on page "home": Input property path /},
  {name:'a Text with both text and path', component:{id:'greeting', type:'Text', props:{text:'Hello', path:'/greeting'}}, message:/^Invalid component "greeting" on page "home": Text property text /},
  {name:'a Card with an unknown property', component:{id:'status', type:'Card', props:{title:'Status', colour:'red'}}, message:/^Invalid component "status" on page "home": Card property "colour" /},
];
const stores = {
  'in-memory store': initial => new ApplicationStore(initial),
  'SQLite store': initial => new SqliteApplicationStore(':memory:', initial),
};

for (const [storeName, create] of Object.entries(stores)) {
  test(`FIX-027: a patch that adds an unrenderable component returns 400 naming the component and property (${storeName})`, async () => {
    const store = create(definition()), control = createControlPlane(store, developer);
    try {
      const url = await start(control);
      for (const {name, component, message} of unrenderable) {
        const [status, error] = await send(`${url}/draft/patches`, developer, {baseRevision:0, patches:[{op:'addComponent', pageId:'home', component}]});
        assert.equal(status, 400, name); assert.match(error, message, name);
        const [pageStatus, pageError] = await send(`${url}/draft/patches`, developer, {baseRevision:0, patches:[{op:'addPage', page:{id:'more', route:'/more', title:'More', components:[component]}}]});
        assert.equal(pageStatus, 400, name); assert.match(pageError, /on page "more": /, name);
        // The whole batch is refused, not only the unrenderable component.
        assert.equal((await send(`${url}/draft/patches`, developer, {baseRevision:0, patches:[{op:'setPageTitle', pageId:'home', title:'Changed'}, {op:'addComponent', pageId:'home', component}]}))[0], 400, name);
      }
      const [status, error] = await send(`${url}/draft/patches`, developer, {baseRevision:0, patches:[{op:'setComponentProps', pageId:'home', componentId:'intro', props:{path:'greeting'}}]});
      assert.equal(status, 400); assert.match(error, /^Invalid component "intro" on page "home": Text property path /);
      assert.deepEqual(store.getDraft(), definition());
    } finally { await stop(control); store.close?.(); }
  });

  test(`FIX-027: publishing a stored draft that holds an unrenderable component returns 400 (${storeName})`, async () => {
    for (const {name, component, message} of unrenderable) {
      const store = create(definition(component)), control = createControlPlane(store, developer);
      try {
        const url = await start(control);
        assert.equal((await send(`${url}/publish`, developer, {expectedRevision:7}))[0], 409, 'a stale revision is still a conflict');
        const [status, error] = await send(`${url}/publish`, developer, {expectedRevision:0});
        assert.equal(status, 400, name); assert.match(error, message, name);
        assert.equal(store.getPublished(), undefined, name);
        // The stored draft still opens and is repaired by removing the component; then it publishes.
        assert.deepEqual(store.getDraft(), definition(component));
        assert.equal((await fetch(`${url}/draft/patches`, post(developer, {baseRevision:0, patches:[{op:'removeComponent', pageId:'home', componentId:component.id}]}))).status, 200, name);
        assert.equal((await fetch(`${url}/publish`, post(developer, {expectedRevision:1}))).status, 201, name);
        assert.deepEqual(store.getPublished().definition.pages[0].components, definition().pages[0].components);
      } finally { await stop(control); store.close?.(); }
    }
  });

  test(`FIX-027: a Table stays a valid draft component and is refused at publish (${storeName})`, async () => {
    const store = create(definition()), control = createControlPlane(store, developer);
    try {
      const url = await start(control);
      assert.equal((await fetch(`${url}/draft/patches`, post(developer, {baseRevision:0, patches:[{op:'addComponent', pageId:'home', component:{id:'orders', type:'Table', props:{title:'Orders'}}}]}))).status, 200);
      const [status, error] = await send(`${url}/publish`, developer, {expectedRevision:1});
      assert.equal(status, 400); assert.match(error, /^Invalid component "orders" on page "home": Table /);
      assert.equal(store.getPublished(), undefined);
      assert.equal((await fetch(`${url}/draft/patches`, post(developer, {baseRevision:1, patches:[{op:'removeComponent', pageId:'home', componentId:'orders'}]}))).status, 200);
      assert.equal((await fetch(`${url}/publish`, post(developer, {expectedRevision:2}))).status, 201);
    } finally { await stop(control); store.close?.(); }
  });
}

test('FIX-027: a proposal that carries an unrenderable component returns 400 and never becomes pending', async () => {
  const repo = new ApplicationStore(definition());
  const planes = createDevelopmentPlanes(repo, developer, agent);
  try {
    const pp = await start(planes.proposal), cp = await start(planes.control);
    for (const {name, component, message} of unrenderable) {
      const [status, error] = await send(`${pp}/proposals`, agent, {baseRevision:0, patches:[{op:'addComponent', pageId:'home', component}]});
      assert.equal(status, 400, name); assert.match(error, message, name);
    }
    assert.deepEqual(repo.getDraft(), definition());
    // A Table can be proposed and approved into the draft; publishing it is what is refused.
    const created = await fetch(`${pp}/proposals`, post(agent, {baseRevision:0, patches:[{op:'addComponent', pageId:'home', component:{id:'orders', type:'Table'}}]}));
    assert.equal(created.status, 201);
    assert.equal((await fetch(`${cp}/proposals/${(await created.json()).id}/approve`, post(developer))).status, 200);
    const [status, error] = await send(`${cp}/publish`, developer, {expectedRevision:1});
    assert.equal(status, 400); assert.match(error, /Table /);
    assert.equal(repo.getPublished(), undefined);
  } finally { await stop(planes.control); await stop(planes.proposal); }
});

test('FIX-027: approving a proposal returns 400 when the repository refuses its component, whatever the preview showed', async () => {
  // A host repository whose getDraft is a copy that already holds the unrenderable component, so the preview does not add it; the draft that approval writes to does not hold it.
  for (const {name, component, message} of unrenderable) {
    const valid = {id:component.id, type:'Text', props:{text:'ok'}};
    const repo = new ApplicationStore(definition(valid)), copy = definition(component);
    const planes = createDevelopmentPlanes({getDraft:() => structuredClone(copy), apply:(revision, patches) => repo.apply(revision, patches), publish:revision => repo.publish(revision), getPublished:version => repo.getPublished(version)}, developer, agent);
    try {
      const pp = await start(planes.proposal), cp = await start(planes.control);
      const patches = [{op:'removeComponent', pageId:'home', componentId:component.id}, {op:'addComponent', pageId:'home', component}];
      const created = await fetch(`${pp}/proposals`, post(agent, {baseRevision:0, patches}));
      assert.equal(created.status, 201, name);
      const [status, error] = await send(`${cp}/proposals/${(await created.json()).id}/approve`, developer);
      assert.equal(status, 400, name); assert.match(error, message, name);
      assert.deepEqual(repo.getDraft(), definition(valid), name);
    } finally { await stop(planes.control); await stop(planes.proposal); }
  }
});

test('FIX-027: a SQLite store whose saved draft holds an unrenderable component opens, accepts removeComponent and other repairs, and refuses new ones', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'app-mixer-component-validation-'));
  const path = join(dir, 'definitions.sqlite'), [input, text, card] = unrenderable.map(item => item.component);
  let store;
  try {
    store = new SqliteApplicationStore(path, definition(input, text, card)); store.close();
    store = new SqliteApplicationStore(path, definition());
    assert.deepEqual(store.getDraft(), definition(input, text, card), 'the saved draft is read as it was stored');
    refuses(() => store.publish(0), unrenderable[0].message);
    // A change that leaves the stored components alone is accepted; one that adds or rewrites an unrenderable component is not.
    assert.equal(store.apply(0, [{op:'setPageTitle', pageId:'home', title:'Start'}]).revision, 1);
    assert.throws(() => store.apply(1, [{op:'addComponent', pageId:'home', component:{id:'other', type:'Input', props:{label:'Other', path:'other'}}}]), /^AppMixerError: Invalid component "other" on page "home": Input property path /);
    assert.throws(() => store.apply(1, [{op:'setComponentProps', pageId:'home', componentId:'name', props:{label:'Your name', path:'still-relative'}}]), /Invalid component "name" on page "home": Input property path /);
    assert.equal(store.getDraft().revision, 1);
    assert.equal(store.apply(1, [{op:'removeComponent', pageId:'home', componentId:'name'}]).revision, 2);
    refuses(() => store.publish(2), unrenderable[1].message);
    assert.equal(store.apply(2, [{op:'setComponentProps', pageId:'home', componentId:'greeting', props:{path:'/greeting', variant:'h2'}}, {op:'setComponentProps', pageId:'home', componentId:'status', props:{title:'Status', text:'Ready'}}]).revision, 3);
    store.close(); store = new SqliteApplicationStore(path, definition());
    assert.equal(store.publish(3).version, 1);
    assert.deepEqual(store.getPublished().definition.pages[0].components.map(component => component.id), ['intro', 'greeting', 'status']);
  } finally { try { store?.close(); } catch { /* already closed */ } await rm(dir, {recursive:true, force:true}); }
});

test('FIX-027: each property rule of Text, Input and Card names the property, and what the renderers accept is still accepted', () => {
  const refused = [
    [{type:'Input'}, /Input property label /],
    [{type:'Input', props:{label:'x'}}, /Input property path /],
    [{type:'Input', props:{label:1, path:'/x'}}, /Input property label /],
    [{type:'Input', props:{label:'x', path:''}}, /Input property path /],
    [{type:'Input', props:{label:'x', path:'/'}}, /Input property path /],
    [{type:'Input', props:{label:'x', path:'/__proto__/x'}}, /Input property path /],
    [{type:'Input', props:{label:'x', path:'/bad~2escape'}}, /Input property path /],
    [{type:'Input', props:{label:'x', path:'/x', variant:'other'}}, /Input property variant /],
    [{type:'Input', props:{label:'x', path:'/x', extra:true}}, /Input property "extra" /],
    [{type:'Text', props:{path:'greeting'}}, /Text property path /],
    [{type:'Text', props:{path:7}}, /Text property path /],
    [{type:'Text', props:{path:'/a~x'}}, /Text property path /],
    [{type:'Text', props:{path:'/constructor'}}, /Text property path /],
    [{type:'Text', props:{path:'/a', variant:'h9'}}, /Text property variant /],
    [{type:'Text', props:{path:'/a', extra:1}}, /Text property "extra" /],
    [{type:'Card', props:{title:5}}, /Card property title /],
    [{type:'Card', props:{text:true}}, /Card property text /],
    [{type:'Card', props:{title:'a', text:'b', extra:'c'}}, /Card property "extra" /],
  ];
  for (const [component, message] of refused) {
    const store = new ApplicationStore(definition());
    assert.throws(() => store.apply(0, [{op:'addComponent', pageId:'home', component:{id:'x', ...component}}]), message, JSON.stringify(component));
    assert.equal(store.getDraft().revision, 0);
  }
  const accepted = [
    {type:'Input', props:{label:'Name', path:'/name'}},
    {type:'Input', props:{label:'', path:'/profile/notes~1more', variant:'longText'}},
    {type:'Input', props:{label:'Name', path:'/name', variant:'shortText'}},
    {type:'Text'},
    {type:'Text', props:{}},
    {type:'Text', props:{text:'Static'}},
    {type:'Text', props:{text:42}},
    {type:'Text', props:{path:'/greeting'}},
    {type:'Text', props:{path:'/', variant:'caption'}},
    {type:'Text', props:{path:'/a/b~0c', variant:'h1'}},
    {type:'Card'},
    {type:'Card', props:{}},
    {type:'Card', props:{title:'Status'}},
    {type:'Card', props:{title:'Status', text:'Ready'}},
    {type:'Table', props:{anything:'goes until a renderer maps it'}},
  ];
  const store = new ApplicationStore(definition());
  const draft = store.apply(0, accepted.map((component, index) => ({op:'addComponent', pageId:'home', component:{id:'c' + index, ...component}})));
  assert.equal(draft.pages[0].components.length, accepted.length + 1);
  const long = 'x'.repeat(10001), stored = new ApplicationStore(definition({id:'long', type:'Card', props:{title:long}}, {id:'longer', type:'Text', props:{text:long}}));
  assert.throws(() => stored.publish(0), /Invalid component "long" on page "home": Card property title /);
  stored.apply(0, [{op:'removeComponent', pageId:'home', componentId:'long'}]);
  assert.throws(() => stored.publish(1), /Invalid component "longer" on page "home": Text property text /);
});
