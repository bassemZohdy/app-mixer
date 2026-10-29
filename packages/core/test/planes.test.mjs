import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createControlPlane, createDataPlane, SqliteApplicationStore, createExtensionPublicationGuard, DevelopmentProposals } from '../dist/index.js';

const token = 'a-strong-local-token-at-least-32-characters';
const auth = {authorization: `Bearer ${token}`};
async function start(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
async function stop(server) { if (server?.listening) await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve())); }
const post = (value, extra = {}) => ({method:'POST', headers:{...auth, 'content-type':'application/json', ...extra}, body:JSON.stringify(value)});

test('planes isolate drafts from published runtime and survive control shutdown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'app-mixer-planes-'));
  const path = join(dir, 'definitions.sqlite');
  const initial = {id:'demo', schemaVersion:1, revision:0, pages:[]};
  const controlStore = new SqliteApplicationStore(path, initial);
  const dataStore = new SqliteApplicationStore(path, initial);
  const control = createControlPlane(controlStore, token);
  const data = createDataPlane(dataStore);
  try {
    const cp = await start(control), dp = await start(data);
    assert.equal((await fetch(`${cp}/draft`)).status, 401);
    assert.equal((await fetch(`${dp}/application`)).status, 404);
    assert.equal((await fetch(`${dp}/draft`, {headers:auth})).status, 404);
    const page = {id:'home', title:'Home', route:'/', components:[]};
    let response = await fetch(`${cp}/draft/patches`, post({baseRevision:0, patches:[{op:'addPage',page}]}));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).revision, 1);
    assert.equal((await fetch(`${cp}/preview`, {headers:auth})).status, 200);
    assert.equal((await fetch(`${dp}/application`)).status, 404);
    assert.equal((await fetch(`${cp}/publish`, post({expectedRevision:0}))).status, 409);
    assert.equal((await fetch(`${cp}/publish`, post({expectedRevision:1}))).status, 201);
    response = await fetch(`${cp}/draft/patches`, post({baseRevision:1,patches:[{op:'setPageTitle',pageId:'home',title:'Draft'}]}));
    assert.equal(response.status, 200);
    assert.equal((await (await fetch(`${dp}/application`)).json()).definition.pages[0].title, 'Home');
    assert.equal((await fetch(`${dp}/application/versions/1`)).status, 200);
    assert.equal((await fetch(`${dp}/publish`, post({expectedRevision:2}))).status, 404);
    await stop(control);
    assert.equal((await (await fetch(`${dp}/application`)).json()).version, 1);
  } finally {
    await stop(control); await stop(data); controlStore.close(); dataStore.close();
    await rm(dir, {recursive:true, force:true});
  }
});

test('control plane rejects malformed and unauthorized mutations atomically', async () => {
  const store = new SqliteApplicationStore(':memory:', {id:'demo', schemaVersion:1, revision:0, pages:[]});
  const control = createControlPlane(store, token);
  try {
    const url = await start(control);
    assert.throws(() => createControlPlane(store, 'short'), /token/);
    assert.equal((await fetch(`${url}/publish`, {method:'POST', headers:{'content-type':'application/json'},body:'{"expectedRevision":0}'})).status, 401);
    assert.equal((await fetch(`${url}/draft/patches`, post({baseRevision:0,patches:[{op:'addPage',page:{id:'x'}}]}))).status, 400);
    assert.equal((await fetch(`${url}/draft/patches`, post({baseRevision:0,patches:[{op:'unknown'}]}))).status, 400);
    assert.equal((await fetch(`${url}/draft/patches`, {method:'POST',headers:auth,body:'x'})).status, 415);
    assert.equal((await fetch(`${url}/draft/patches`, {method:'POST',headers:{...auth,'content-type':'application/json'},body:'{'})).status, 400);
    assert.equal((await fetch(`${url}/draft/patches`, {method:'POST', headers:{...auth,'content-type':'application/json'}, body:' '.repeat(1024 * 1024 + 1)})).status, 413);
    assert.equal((await (await fetch(`${url}/draft`, {headers:auth})).json()).revision, 0);
  } finally { await stop(control); store.close(); }
});

test('extension references flow through proposals and require a publication guard',async()=>{
 const initial={id:'demo',schemaVersion:1,revision:0,pages:[]};
 const ref={id:'sample.extension',version:'1.0.0',scope:'application'};
 const manifest={manifestVersion:1,...ref,runtimeVersions:['0.1.0'],renderers:['react'],components:[],tools:[],providers:[],permissions:[]};
 const host={runtimeVersion:'0.1.0',renderer:'react',approved:[{...ref,permissions:[]}]};
 const guard=createExtensionPublicationGuard([manifest],host,()=>({components:[],tools:[],providers:[]}));
 for(const policy of [undefined,guard]) {
  const store=new SqliteApplicationStore(':memory:',initial,policy),control=createControlPlane(store,token),proposals=new DevelopmentProposals(store);
  try {
   const url=await start(control);
   const proposal=proposals.propose(0,[{op:'setExtensions',extensions:[ref]}]);assert.deepEqual(proposal.preview.extensions,[ref]);
   proposals.approve(proposal.id);
   assert.equal((await fetch(`${url}/draft/patches`,post({baseRevision:1,patches:[{op:'setExtensions',extensions:[{...ref,version:'bad'}]}]}))).status,400);
   const response=await fetch(`${url}/publish`,post({expectedRevision:1}));
   assert.equal(response.status,policy?201:409);
   if(policy)assert.deepEqual((await response.json()).definition.extensions,[ref]);else assert.equal(store.getPublished(),undefined);
  } finally {await stop(control);store.close();}
 }
});
