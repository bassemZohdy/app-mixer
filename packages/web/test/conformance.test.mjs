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

test('catalog text length follows Unicode code points at the renderer boundary', async () => {
  const catalog=await load('../catalog/v1/catalog.json');
  const validate=new Ajv2020({strict:false}).compile(catalog.components.Text);
  const doc={createElement:()=>new Element(doc)},host=doc.createElement(),renderer=new A2UIRenderer(host);
  renderer.apply({version:'v0.9.1',createSurface:{surfaceId:'main',catalogId:APP_MIXER_CATALOG}});
  const limit='\u{1F600}'.repeat(10000),above=limit+'a';
  assert.equal(validate({text:limit}),true);assert.equal(validate({text:above}),false);
  const update=text=>({version:'v0.9.1',updateComponents:{surfaceId:'main',components:[{id:'root',component:'Text',text}]}});
  renderer.apply(update(limit));assert.equal(host.children[0].children[0].textContent,limit);
  assert.throws(()=>renderer.apply(update(above)));assert.equal(host.children[0].children[0].textContent,limit);
});

test('catalog identifiers use Unicode code point limits in actual component references', async () => {
  const catalog=await load('../catalog/v1/catalog.json'),ajv=new Ajv2020({strict:false});
  const card=ajv.compile(catalog.components.Card),row=ajv.compile(catalog.components.Row);
  const identifier='\u{1F600}'.repeat(256),tooLong=identifier+'x';
  assert.equal(card({child:identifier}),true);assert.equal(card({child:tooLong}),false);
  assert.equal(row({children:[identifier]}),true);assert.equal(row({children:[tooLong]}),false);
  const doc={createElement:()=>new Element(doc)},host=doc.createElement(),renderer=new A2UIRenderer(host);
  const message=(kind,payload)=>({version:'v0.9.1',[kind]:payload});
  renderer.apply(message('createSurface',{surfaceId:'main',catalogId:APP_MIXER_CATALOG}));
  renderer.apply(message('updateComponents',{surfaceId:'main',components:[{id:'root',component:'Card',child:identifier},{id:identifier,component:'Text',text:'Safe'}]}));
  assert.equal(host.children[0].children[0].children[0].textContent,'Safe');
  assert.throws(()=>renderer.apply(message('updateComponents',{surfaceId:'main',components:[{id:'root',component:'Card',child:tooLong}]})));
  assert.equal(host.children[0].children[0].children[0].textContent,'Safe');
});

test('catalog permits root bindings for text and button context', async () => {
  const catalog=await load('../catalog/v1/catalog.json'),ajv=new Ajv2020({strict:false});
  const text=ajv.compile(catalog.components.Text),button=ajv.compile(catalog.components.Button);
  assert.equal(text({text:{path:''}}),true);assert.equal(text({text:{path:'/'}}),true);assert.equal(text({text:{path:'relative'}}),false);
  const action=path=>({child:'label',action:{event:{name:'go',context:{root:{path}}}}});
  assert.equal(button(action('')),true);assert.equal(button(action('/')),true);assert.equal(button(action('relative')),false);
  const doc={createElement:()=>new Element(doc)},host=doc.createElement();let emitted;
  const renderer=new A2UIRenderer(host,basicRegistry(),event=>{emitted=event;});
  const message=(kind,payload)=>({version:'v0.9.1',[kind]:payload});
  renderer.apply(message('createSurface',{surfaceId:'main',catalogId:APP_MIXER_CATALOG}));
  renderer.apply(message('updateDataModel',{surfaceId:'main',value:'Root value'}));
  renderer.apply(message('updateComponents',{surfaceId:'main',components:[{id:'root',component:'Button',...action('')},{id:'label',component:'Text',text:{path:''}}]}));
  const rendered=host.children[0].children[0];assert.equal(rendered.children[0].textContent,'Root value');rendered.listeners.click();assert.equal(emitted.action.context.root,'Root value');
});

test('catalog accepts non-root field paths containing line breaks', async () => {
  const catalog=await load('../catalog/v1/catalog.json'),validate=new Ajv2020({strict:false}).compile(catalog.components.TextField);
  const field=path=>({label:'Name',value:{path}});
  for(const path of ['/\n','/\r','/\u2028','/\u2029'])assert.equal(validate(field(path)),true,path);
  for(const path of ['','/','relative'])assert.equal(validate(field(path)),false,path);
  const doc={createElement:()=>new Element(doc)},host=doc.createElement(),renderer=new A2UIRenderer(host);
  const message=(kind,payload)=>({version:'v0.9.1',[kind]:payload});
  renderer.apply(message('createSurface',{surfaceId:'main',catalogId:APP_MIXER_CATALOG}));
  renderer.apply(message('updateDataModel',{surfaceId:'main',value:{'\n':'Ada'}}));
  renderer.apply(message('updateComponents',{surfaceId:'main',components:[{id:'root',component:'TextField',...field('/\n')}]}));
  assert.equal(host.children[0].children[0].children[1].value,'Ada');
});
