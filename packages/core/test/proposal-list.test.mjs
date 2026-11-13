import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import { ApplicationStore, createDevelopmentPlanes } from '../dist/index.js';
import { DEVELOPMENT_UI } from '../dist/development-ui.js';
import { A2UIRenderer, APP_MIXER_CATALOG, basicRegistry } from '../../web/dist/index.js';
const developer = 'developer-token-at-least-32-characters-long';
const agent = 'agent-token-at-least-32-characters-long';
async function start(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; }
async function stop(server) { if (server.listening) await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
const auth = token => ({ authorization: `Bearer ${token}` });
const post = (token, body) => ({ method: 'POST', headers: { ...auth(token), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const page = id => ({ id, route: '/' + id, title: id, components: [] });
const wait = async predicate => { for (let i = 0; i < 200 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(predicate()); };

test('FEAT-036 GET /proposals lists id, base revision and status for the developer token only', async () => {
  const repo = new ApplicationStore({ id: 'demo', schemaVersion: 1, revision: 0, pages: [] });
  const planes = createDevelopmentPlanes(repo, developer, agent);
  try {
    const cp = await start(planes.control), pp = await start(planes.proposal);
    const empty = await fetch(`${cp}/proposals`, { headers: auth(developer) });
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { proposals: [] });
    const first = await (await fetch(`${pp}/proposals`, post(agent, { baseRevision: 0, patches: [{ op: 'addPage', page: page('home') }] }))).json();
    const second = await (await fetch(`${pp}/proposals`, post(agent, { baseRevision: 0, patches: [{ op: 'addPage', page: page('about') }] }))).json();
    assert.equal((await fetch(`${cp}/proposals/${first.id}/approve`, post(developer))).status, 200);
    const listed = await fetch(`${cp}/proposals`, { headers: auth(developer) });
    assert.equal(listed.status, 200);
    assert.deepEqual((await listed.json()).proposals.sort((a, b) => a.id.localeCompare(b.id)), [
      { id: first.id, baseRevision: 0, status: 'approved' },
      { id: second.id, baseRevision: 0, status: 'pending' }
    ].sort((a, b) => a.id.localeCompare(b.id)));
    assert.equal((await fetch(`${cp}/proposals`, { headers: auth(agent) })).status, 401);
    assert.equal((await fetch(`${cp}/proposals`)).status, 401);
    assert.equal((await fetch(`${pp}/proposals`, { headers: auth(agent) })).status, 404);
  } finally { await stop(planes.control); await stop(planes.proposal); }
});

test('FEAT-036 the review page loads a proposal chosen from the list and shows action results beside the buttons', async () => {
  const repo = new ApplicationStore({ id: 'demo', schemaVersion: 1, revision: 0, pages: [] });
  const planes = createDevelopmentPlanes(repo, developer, agent);
  try {
    const cp = await start(planes.control), pp = await start(planes.proposal);
    const one = await (await fetch(`${pp}/proposals`, post(agent, { baseRevision: 0, patches: [{ op: 'addPage', page: page('home') }] }))).json();
    const two = await (await fetch(`${pp}/proposals`, post(agent, { baseRevision: 0, patches: [{ op: 'addPage', page: page('about') }] }))).json();
    const dom = new JSDOM(DEVELOPMENT_UI), document = dom.window.document;
    const script = DEVELOPMENT_UI.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/^\s*import [^;]+;\s*/gm, '');
    runInNewContext(script, { document, A2UIRenderer, APP_MIXER_CATALOG, basicRegistry, installedExtensions: [], fetch: (path, options) => fetch(new URL(path, cp), options) });
    const el = id => document.getElementById(id);
    el('token').value = developer;
    el('refresh-proposals').click();
    await wait(() => el('proposal-list').options.length >= 3);
    const values = [...el('proposal-list').options].map(option => option.value);
    assert.ok(values.includes(one.id) && values.includes(two.id));
    const chosen = [...el('proposal-list').options].find(option => option.value === two.id);
    assert.match(chosen.textContent, /pending/);
    assert.match(chosen.textContent, /revision 0/);
    el('proposal-list').value = two.id;
    el('proposal-list').dispatchEvent(new dom.window.Event('change'));
    await wait(() => !el('approve').disabled);
    assert.equal(el('proposal-id').value, two.id);
    assert.match(el('patch').textContent, /about/);
    el('approve').click();
    await wait(() => /approved/i.test(el('action-result').textContent));
    assert.equal(el('publish').nextElementSibling, el('action-result'));
    el('publish').click();
    await wait(() => /Published version 1/.test(el('action-result').textContent));
    el('proposal-list').value = one.id;
    el('proposal-list').dispatchEvent(new dom.window.Event('change'));
    await wait(() => !el('reject').disabled);
    el('reject').click();
    await wait(() => /rejected/i.test(el('action-result').textContent));
    el('refresh-proposals').click();
    await wait(() => [...el('proposal-list').options].some(option => option.value === one.id && /rejected/.test(option.textContent)));
  } finally { await stop(planes.control); await stop(planes.proposal); }
});
