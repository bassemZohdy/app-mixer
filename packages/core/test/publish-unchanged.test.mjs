import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { ApplicationStore, SqliteApplicationStore, createControlPlane } from '../dist/index.js';

const token = 'developer-token-at-least-32-characters-long';
async function start(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; }
async function stop(server) { if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
const post = (body, authorization = `Bearer ${token}`) => ({method:'POST', headers:{authorization, 'content-type':'application/json'}, body:JSON.stringify(body)});

const initial = () => ({id:'demo', schemaVersion:1, revision:0, pages:[{id:'home', route:'/', title:'Home', components:[{id:'intro', type:'Text', props:{text:'Welcome'}}]}]});
const stores = {
  'in-memory store': guard => new ApplicationStore(initial(), guard),
  'SQLite store': guard => new SqliteApplicationStore(':memory:', initial(), guard),
};

for (const [name, create] of Object.entries(stores)) {
  test(`FIX-029: publishing an unchanged draft again returns the same version and adds none (${name})`, () => {
    const store = create();
    try {
      const first = store.publish(0);
      assert.equal(first.version, 1);
      for (let attempt = 0; attempt < 3; attempt++) assert.deepEqual(store.publish(0), first);
      assert.equal(store.getPublished().version, 1);
      assert.equal(store.getPublished(2), undefined);
      assert.equal(store.getPublicationProvenance(2), undefined);
      assert.equal(store.getPublicationProvenance(1).kind, 'publish');
      assert.throws(() => store.publish(1), /Revision conflict/, 'a stale revision is still a conflict');
      // A changed draft is a new version, and repeating that publish adds none either.
      store.apply(0, [{op:'setPageTitle', pageId:'home', title:'Start'}]);
      const second = store.publish(1);
      assert.equal(second.version, 2); assert.equal(second.definition.pages[0].title, 'Start');
      assert.deepEqual(store.publish(1), second);
      assert.equal(store.getPublished().version, 2);
      assert.equal(store.getPublished(3), undefined);
      assert.equal(store.getPublished(1).definition.pages[0].title, 'Home');
    } finally { store.close?.(); }
  });

  test(`FIX-029: publishing the same draft after a rollback still creates a version (${name})`, () => {
    const store = create();
    try {
      store.publish(0);
      store.apply(0, [{op:'setPageTitle', pageId:'home', title:'Start'}]);
      assert.equal(store.publish(1).version, 2);
      const rolledBack = store.rollback(1, 2);
      assert.equal(rolledBack.version, 3); assert.equal(rolledBack.definition.pages[0].title, 'Home');
      // The draft did not change, but the latest publication is no longer that draft.
      const again = store.publish(1);
      assert.equal(again.version, 4); assert.equal(again.definition.pages[0].title, 'Start');
      assert.deepEqual(store.getPublicationProvenance(4), {version:4, kind:'publish', previousVersion:3, definitionSha256:store.getPublicationProvenance(2).definitionSha256});
      assert.deepEqual(store.publish(1), again);
      assert.equal(store.getPublished(5), undefined);
    } finally { store.close?.(); }
  });

  test(`FIX-029: the Control Plane answers 201 for a new version and 200 for an unchanged draft (${name})`, async () => {
    const store = create(), control = createControlPlane(store, token);
    try {
      const url = await start(control);
      const first = await fetch(`${url}/publish`, post({expectedRevision:0}));
      assert.equal(first.status, 201);
      const created = await first.json();
      assert.equal(created.version, 1);
      const repeated = await fetch(`${url}/publish`, post({expectedRevision:0}));
      assert.equal(repeated.status, 200);
      assert.deepEqual(await repeated.json(), created);
      assert.equal((await fetch(`${url}/publish`, post({expectedRevision:0}, 'Bearer wrong-token-of-at-least-32-characters'))).status, 401);
      assert.equal((await fetch(`${url}/publish`, post({expectedRevision:3}))).status, 409);
      assert.equal(store.getPublished().version, 1);
      assert.equal((await fetch(`${url}/draft/patches`, post({baseRevision:0, patches:[{op:'setPageTitle', pageId:'home', title:'Start'}]}))).status, 200);
      const second = await fetch(`${url}/publish`, post({expectedRevision:1}));
      assert.equal(second.status, 201); assert.equal((await second.json()).version, 2);
      assert.equal((await fetch(`${url}/rollback`, post({sourceVersion:1, expectedVersion:2}))).status, 201);
      const afterRollback = await fetch(`${url}/publish`, post({expectedRevision:1}));
      assert.equal(afterRollback.status, 201); assert.equal((await afterRollback.json()).version, 4);
      assert.equal((await fetch(`${url}/publish`, post({expectedRevision:1}))).status, 200);
      assert.equal(store.getPublished().version, 4);
    } finally { await stop(control); store.close?.(); }
  });

  test(`FIX-029: an unchanged draft is still refused when the publication guard no longer allows it (${name})`, () => {
    let allowed = true;
    const store = create(() => { if (!allowed) throw Error('Guard refused'); return true; });
    try {
      assert.equal(store.publish(0).version, 1);
      allowed = false;
      assert.throws(() => store.publish(0), /Guard refused/);
      allowed = true;
      assert.equal(store.publish(0).version, 1);
      assert.equal(store.getPublished(2), undefined);
    } finally { store.close?.(); }
  });
}
