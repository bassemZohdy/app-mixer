import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import { A2UIRenderer, APP_MIXER_CATALOG, basicRegistry } from '../dist/index.js';

const load = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
class Element {
  constructor(doc) { this.ownerDocument=doc; this.children=[]; this.style={}; this.dataset={}; this.textContent=''; this.listeners={}; this.value=''; }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children=children; }
  addEventListener(event, fn) { this.listeners[event]=fn; }
  remove() {}
}

test('supported lifecycle and emitted action match pinned upstream A2UI schemas', async () => {
  const [upstream, client, catalog] = await Promise.all([
    load('./fixtures/a2ui-v0.9.1/server_to_client.json'),
    load('./fixtures/a2ui-v0.9.1/client_to_server.json'),
    load('../catalog/v1/catalog.json')
  ]);
  const ajv = new Ajv2020({strict:false, validateFormats:false, allErrors:true});
  const variants = Object.entries(catalog.components).map(([type, schema]) => ({
    ...schema, properties:{id:{type:'string'},component:{const:type},...schema.properties},
    required:['id','component',...schema.required]
  }));
  // Link upstream's catalog references to this project's supported component schemas.
  ajv.addSchema({$id:'https://a2ui.org/specification/v0_9/catalog.json', $defs:{
    anyComponent:{oneOf:variants}, theme:{type:'object'}
  }});
  const validateServer=ajv.compile(upstream), validateClient=ajv.compile(client);
  const doc={createElement:() => new Element(doc)}; const host=doc.createElement();
  let action;
  const renderer = new A2UIRenderer(host,basicRegistry(),message => { action=message; });
  const version='v0.9.1', surfaceId='main';
  const messages = [
    {version,createSurface:{surfaceId,catalogId:APP_MIXER_CATALOG}},
    {version,updateDataModel:{surfaceId,value:{user:{name:'Ada'}}}},
    {version,updateComponents:{surfaceId,components:[
      {id:'root',component:'Column',children:['name','save']},
      {id:'name',component:'Text',text:{path:'/user/name'}},
      {id:'save',component:'Button',child:'label',action:{event:{name:'submit',context:{name:{path:'/user/name'}}}}},
      {id:'label',component:'Text',text:'Save'}
    ]}}
  ];
  for(const message of messages) {
    assert.equal(validateServer(message),true,JSON.stringify(validateServer.errors));
    renderer.apply(message);
  }
  host.children[0].children[0].children[1].listeners.click();
  assert.equal(validateClient(action),true,JSON.stringify(validateClient.errors));
  assert.equal(action.action.context.name,'Ada');
  assert.ok(!Number.isNaN(Date.parse(action.action.timestamp)));
  const deletion={version,deleteSurface:{surfaceId}};
  assert.equal(validateServer(deletion),true,JSON.stringify(validateServer.errors));
  renderer.apply(deletion);
  assert.equal(validateServer({version,updateComponents:{surfaceId,components:[]}}),false);
  assert.equal(validateServer({...deletion,unexpected:true}),false);
});
