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
      {id:'root',component:'Card',child:'layout'},
      {id:'layout',component:'Column',children:['row','save']},
      {id:'row',component:'Row',children:['name','field'],justify:'center'},
      {id:'name',component:'Text',text:{path:'/user/name'}},
      {id:'field',component:'TextField',label:'Name',value:{path:'/user/name'}},
      {id:'save',component:'Button',child:'label',action:{event:{name:'submit',context:{name:{path:'/user/name'}}}}},
      {id:'label',component:'Text',text:'Save'}
    ]}}
  ];
  for(const message of messages) {
    assert.equal(validateServer(message),true,JSON.stringify(validateServer.errors));
    renderer.apply(message);
  }
  host.children[0].children[0].children[0].children[1].listeners.click();
  assert.equal(validateClient(action),true,JSON.stringify(validateClient.errors));
  assert.equal(action.action.context.name,'Ada');
  assert.ok(!Number.isNaN(Date.parse(action.action.timestamp)));
  const deletion={version,deleteSurface:{surfaceId}};
  assert.equal(validateServer(deletion),true,JSON.stringify(validateServer.errors));
  renderer.apply(deletion);
  assert.equal(validateServer({version,updateComponents:{surfaceId,components:[]}}),false);
  assert.equal(validateServer({...deletion,unexpected:true}),false);
});

test('a data update elsewhere does not overwrite text that is being composed with an input method', () => {
  // While an input method is composing (compositionstart ... compositionend) the field holds text that is not yet in the data model.
  const doc={createElement:() => new Element(doc)}; const host=doc.createElement(); const writes=[];
  const renderer = new A2UIRenderer(host,basicRegistry(),message => writes.push(message));
  const version='v0.9.1', surfaceId='main';
  for(const message of [
    {version,createSurface:{surfaceId,catalogId:APP_MIXER_CATALOG}},
    {version,updateDataModel:{surfaceId,value:{name:'Ada',other:'x'}}},
    {version,updateComponents:{surfaceId,components:[
      {id:'root',component:'Column',children:['name','other']},
      {id:'name',component:'TextField',label:'Name',value:{path:'/name'}},
      {id:'other',component:'Text',text:{path:'/other'}}
    ]}}
  ])renderer.apply(message);
  const find=element => element.listeners.compositionstart ? element : element.children.map(find).find(Boolean);
  const input=find(host);
  assert.ok(input,'the text field was rendered');assert.equal(input.value,'Ada');
  input.listeners.compositionstart();input.value='Adaに';
  renderer.apply({version,updateDataModel:{surfaceId,path:'/other',value:'y'}});
  assert.equal(input.value,'Adaに','the composition survives an unrelated update');
  // When composition ends the text is committed to the data model and later updates apply as usual.
  input.listeners.compositionend();
  renderer.apply({version,updateDataModel:{surfaceId,path:'/name',value:'Grace'}});
  assert.equal(input.value,'Grace','after composition ends, a data update changes the field again');
});
