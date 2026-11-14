import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {A2UIRenderer, A2UIJsonLines, BASIC_CATALOG, APP_MIXER_CATALOG, ComponentRegistry, basicRegistry} from '../dist/index.js';

class Element {
  constructor(tag, doc) { this.tagName=tag; this.ownerDocument=doc; this.children=[]; this.style={}; this.dataset={}; this.attributes={}; this.textContent=''; this.parent=null; this.listeners={}; this.value=''; this.selectionStart=0; this.selectionEnd=0; }
  setAttribute(name,value) { this.attributes[name]=String(value); }
  getAttribute(name) { return this.attributes[name]??null; }
  appendChild(child) { child.parent=this; this.children.push(child); return child; }
  replaceChildren(...children) { this.children=[]; for(const child of children) this.appendChild(child); }
  remove() { if(this.parent) this.parent.children=this.parent.children.filter(child => child !== this); }
  replaceWith(next) { const parent=this.parent; if(!parent) return; parent.children[parent.children.indexOf(this)]=next; next.parent=parent; this.parent=null; }
  addEventListener(type, fn) { this.listeners[type]=fn; }
  dispatch(type) { this.listeners[type]?.(); }
  focus() { this.focused=true; this.ownerDocument.activeElement=this; }
  setSelectionRange(start,end) { this.selectionStart=start; this.selectionEnd=end; }
}
const setup = () => { const doc={createElement:tag => new Element(tag,doc)}; const host=doc.createElement('main'); return {host,renderer:new A2UIRenderer(host)}; };
const create = id => ({version:'v0.9.1',createSurface:{surfaceId:id,catalogId:BASIC_CATALOG}});
const components = (id, value) => ({version:'v0.9.1',updateComponents:{surfaceId:id,components:value}});
const data = (id, value, path='/') => ({version:'v0.9.1',updateDataModel:{surfaceId:id,path,value}});

test('renders and updates surfaces from basic A2UI messages without HTML execution', () => {
  const {host,renderer}=setup(); renderer.apply(create('main')); renderer.apply(data('main',{person:{name:'Ada'}}));
  renderer.apply(components('main',[
    {id:'root',component:'Card',child:'layout'},
    {id:'layout',component:'Column',children:['title','bound']},
    {id:'title',component:'Text',text:'<img src=x onerror=alert(1)>',variant:'h1'},
    {id:'bound',component:'Text',text:{path:'/person/name'}}
  ]));
  const layout=host.children[0].children[0].children[0];
  assert.equal(layout.children[0].textContent,'<img src=x onerror=alert(1)>');
  assert.equal(layout.children[1].textContent,'Ada');
  renderer.apply(data('main','Grace','/person/name'));
  assert.equal(host.children[0].children[0].children[0].children[1].textContent,'Grace');
  renderer.apply({version:'v0.9.1',deleteSurface:{surfaceId:'main'}});
  assert.equal(host.children.length,0);
});

test('rejects invalid updates without replacing the previous UI', () => {
  const {host,renderer}=setup(); renderer.apply(create('main'));
  renderer.apply(components('main',[{id:'root',component:'Text',text:'Safe'}]));
  assert.throws(() => renderer.apply(components('main',[{id:'root',component:'Unknown'}])),/Unsupported component/);
  assert.equal(host.children[0].children[0].textContent,'Safe');
  assert.throws(() => renderer.apply(components('main',[{id:'root',component:'Text',text:'x',action:{}}])),/Unsupported Text property/);
  assert.throws(() => renderer.apply(components('main',[{id:'root',component:'Column',children:['root']}])),/Cyclic/);
  assert.equal(host.children[0].children[0].textContent,'Safe');
  assert.throws(() => renderer.apply(data('main','x','/__proto__/polluted')),/Unsafe/);
  assert.throws(() => renderer.apply(create('main')),/already exists/);
  assert.throws(() => renderer.apply({version:'v0.8',deleteSurface:{surfaceId:'main'}}),/version/);
  assert.throws(() => renderer.apply(components('missing',[])),/Unknown surface/);
  assert.throws(() => renderer.apply(components('main',[])),/Invalid components/);
  assert.throws(() => renderer.apply({...create('other'), extra:true}),/Invalid A2UI message/);
});

test('supports incremental child definitions and independent surfaces', () => {
  const {host,renderer}=setup(); renderer.apply(create('a')); renderer.apply(create('b'));
  renderer.apply(components('a',[{id:'root',component:'Row',children:['later'],justify:'spaceBetween',align:'center'}]));
  renderer.apply(components('b',[{id:'root',component:'Text',text:'Other'}]));
  renderer.apply(components('a',[{id:'later',component:'Text',text:'Loaded'}]));
  assert.equal(host.children[0].children[0].style.justifyContent,'space-between');
  assert.equal(host.children[0].children[0].style.alignItems,'center');
  assert.equal(host.children[0].children[0].children[0].textContent,'Loaded');
  assert.equal(host.children[1].children[0].textContent,'Other');
  assert.throws(() => new ComponentRegistry().register('x',()=>{}).register('x',()=>{}),/duplicate/);
  assert.ok(basicRegistry().get('Text'));
});

test('heading-styled button labels are presentational while standalone headings retain semantics',()=>{
 const {host,renderer}=setup();renderer.apply(create('main'));
 renderer.apply(components('main',[{id:'root',component:'Column',children:['title','button']},{id:'title',component:'Text',text:'Title',variant:'h2'},{id:'button',component:'Button',child:'nested',action:{event:{name:'go'}}},{id:'nested',component:'Row',children:['title']} ]));
 const root=host.children[0].children[0],heading=root.children[0],label=root.children[1].children[0].children[0];
 assert.equal(heading.tagName,'h2');assert.equal(heading.getAttribute('role'),null);assert.equal(label.tagName,'h2');assert.equal(label.textContent,'Title');assert.equal(label.getAttribute('role'),'presentation');
});


test('frames fragmented JSONL messages in order and rejects oversized lines', () => {
  const {host,renderer} = setup();
  const stream = new A2UIJsonLines(renderer);
  const lines = JSON.stringify(create('main')) + '\r\n' + JSON.stringify(components('main',[{id:'root',component:'Text',text:'Streamed'}]));
  for (let i=0; i<lines.length; i+=7) stream.write(lines.slice(i,i+7));
  stream.finish();
  assert.equal(host.children[0].children[0].textContent,'Streamed');
  assert.throws(() => stream.write('x'), /closed/);
  const limited = new A2UIJsonLines(renderer, 4);
  assert.throws(() => limited.write('12345'), /too long/);
  assert.throws(() => limited.write(''), /closed/);
});


test('updates text field bindings and dispatches explicit action context', () => {
  const doc={createElement:tag => new Element(tag,doc)}; const host=doc.createElement('main');
  const actions=[]; const renderer=new A2UIRenderer(host,basicRegistry(),message=>actions.push(message));
  renderer.apply(create('main')); renderer.apply(data('main',{form:{name:'Ada', secret:'not-shared'}}));
  renderer.apply(components('main',[
    {id:'root',component:'Column',children:['field','display','submit']},
    {id:'field',component:'TextField',label:'Name',value:{path:'/form/name'}},
    {id:'display',component:'Text',text:{path:'/form/name'}},
    {id:'submit',component:'Button',child:'caption',action:{event:{name:'save',context:{name:{path:'/form/name'}}}}},
    {id:'caption',component:'Text',text:'Save'}
  ]));
  let root=host.children[0].children[0];
  const field=root.children[0].children[1]; field.value='Grace'; field.focus(); field.setSelectionRange(5,5); field.dispatch('input');
  root=host.children[0].children[0];
  assert.equal(root.children[1].textContent,'Grace');
  assert.equal(root.children[0].children[1].focused,true);
  root.children[2].dispatch('click');
  assert.equal(actions.length,1);
  assert.equal(actions[0].action.name,'save');
  assert.equal(actions[0].action.sourceComponentId,'submit');
  assert.deepEqual(actions[0].action.context,{name:'Grace'});
  assert.equal(actions[0].version,'v0.9.1');
  const composing=root.children[0].children[1];
  composing.dispatch('compositionstart'); composing.value='日本'; composing.dispatch('input');
  assert.equal(host.children[0].children[0].children[1].textContent,'Grace');
  composing.dispatch('compositionend');
  assert.equal(host.children[0].children[0].children[1].textContent,'日本');
});


test('buttons are disabled without an action handler', () => {
  const {host,renderer}=setup(); renderer.apply(create('main'));
  renderer.apply(components('main',[{id:'root',component:'Button',child:'label',action:{event:{name:'send'}}},{id:'label',component:'Text',text:'Send'}]));
  assert.equal(host.children[0].children[0].disabled,true);
});

test('custom registry validators run for disconnected components before commit', () => {
  const doc={createElement:tag=>new Element(tag,doc)},host=doc.createElement('main');
  const registry=new ComponentRegistry();
  registry.register('Custom',(c,_child,_data,document)=>{const node=document.createElement('p');node.textContent=c.text;return node;},c=>{if(typeof c.text!=='string')throw Error('Invalid custom text');});
  const renderer=new A2UIRenderer(host,registry);renderer.apply(create('main'));
  renderer.apply(components('main',[{id:'root',component:'Custom',text:'Safe'}]));
  assert.throws(()=>renderer.apply(components('main',[{id:'root',component:'Custom',text:'Changed'},{id:'unused',component:'Custom',text:42}])),/Invalid custom text/);
  assert.equal(host.children[0].children[0].textContent,'Safe');
});

test('only current buttons dispatch after component replacement and surface recreation', () => {
  const doc={createElement:tag => new Element(tag,doc)}; const host=doc.createElement('main');
  const actions=[]; const renderer=new A2UIRenderer(host,basicRegistry(),message=>actions.push(message));
  const button=name=>[{id:'root',component:'Button',child:'label',action:{event:{name}}},{id:'label',component:'Text',text:name}];
  renderer.apply(create('main'));renderer.apply(components('main',button('old')));
  const original=host.children[0].children[0];
  renderer.apply(data('main',{value:'updated'}));original.dispatch('click');
  assert.deepEqual(actions.map(message=>message.action.name),['old']);
  assert.throws(()=>renderer.apply(components('main',[{id:'root',component:'Button'}])));
  original.dispatch('click');assert.equal(actions.length,2);
  renderer.apply(components('main',button('new')));
  const current=host.children[0].children[0];original.dispatch('click');current.dispatch('click');
  assert.deepEqual(actions.map(message=>message.action.name),['old','old','new']);
  renderer.apply({version:'v0.9.1',deleteSurface:{surfaceId:'main'}});renderer.apply(create('main'));
  renderer.apply(components('main',button('replacement')));current.dispatch('click');
  assert.equal(actions.length,3);host.children[0].children[0].dispatch('click');
  assert.equal(actions.at(-1).action.name,'replacement');
});


test('data model upserts nested paths and array deletion preserves indices', () => {
  const {host,renderer}=setup(); renderer.apply(create('main'));
  renderer.apply(components('main',[{id:'root',component:'Text',text:{path:'/user/name'}}]));
  renderer.apply(data('main','Ada','/user/name'));
  assert.equal(host.children[0].children[0].textContent,'Ada');
  renderer.apply(data('main',{items:['first','second']}));
  renderer.apply(components('main',[{id:'root',component:'Text',text:{path:'/items/1'}}]));
  renderer.apply({version:'v0.9.1',updateDataModel:{surfaceId:'main',path:'/items/0'}});
  assert.equal(host.children[0].children[0].textContent,'second');
});


test('rejects oversized expanded trees without replacing existing UI', () => {
  const {host,renderer}=setup(); renderer.apply(create('main'));
  renderer.apply(components('main',[{id:'root',component:'Text',text:'Safe'}]));
  const nodes = [{id:'root',component:'Column',children:['n0','n0']}];
  for (let i=0;i<13;i++) nodes.push({id:`n${i}`,component:'Column',children:[`n${i+1}`,`n${i+1}`]});
  nodes.push({id:'n13',component:'Text',text:'leaf'});
  assert.throws(() => renderer.apply(components('main',nodes)), /tree too large/);
  assert.equal(host.children[0].children[0].textContent,'Safe');
});


test('versioned catalog identifies exactly the built-in registered components', async () => {
  const catalog=JSON.parse(await readFile(new URL('../catalog/v1/catalog.json',import.meta.url),'utf8'));
  assert.equal(catalog.catalogId,APP_MIXER_CATALOG);
  assert.equal(catalog.$id,APP_MIXER_CATALOG);
  assert.deepEqual(Object.keys(catalog.components).sort(),['Button','Card','Column','Row','Text','TextField']);
  const registry=basicRegistry();
  for(const name of Object.keys(catalog.components)) assert.ok(registry.get(name));
  const {renderer}=setup();
  renderer.apply({version:'v0.9.1',createSurface:{surfaceId:'custom',catalogId:APP_MIXER_CATALOG}});
});

test('incremental missing layout references retain their web flex slot until resolved', async()=>{
  const fixture=JSON.parse(await readFile(new URL('../../../adapters/flutter/assets/incremental-missing-child.json',import.meta.url),'utf8'));
  for(const mode of fixture.modes){
    const {host,renderer}=setup();renderer.apply(fixture.create);
    renderer.apply(components('main',[...fixture.children,{...fixture.root,justify:mode}]));
    let row=host.children[0].children[0];
    assert.equal(row.style.justifyContent,({spaceBetween:'space-between',spaceAround:'space-around',spaceEvenly:'space-evenly'})[mode]);
    assert.deepEqual(row.children.map(child=>child.tagName),['p','span','p']);
    assert.equal(row.children[1].textContent,'');
    renderer.apply(components('main',[fixture.resolve]));
    row=host.children[0].children[0];
    assert.deepEqual(row.children.map(child=>child.tagName),['p','p','p']);
    assert.equal(row.children[1].textContent,'Middle');
  }
});

// TASK-002.2.2
test('every rendered component carries its ID and variant as stable hooks',()=>{
 const {host,renderer}=setup();
 renderer.apply({version:'v0.9.1',createSurface:{surfaceId:'main',catalogId:APP_MIXER_CATALOG}});
 renderer.apply({version:'v0.9.1',updateDataModel:{surfaceId:'main',value:{form:{name:'Ada'}}}});
 renderer.apply({version:'v0.9.1',updateComponents:{surfaceId:'main',components:[
  {id:'root',component:'Column',children:['title','field','buy']},{id:'title',component:'Text',text:'Hi',variant:'h2'},
  {id:'field',component:'TextField',label:'Name',value:{path:'/form/name'},variant:'longText'},
  {id:'buy',component:'Button',variant:'primary',child:'buyLabel',action:{event:{name:'buy'}}},{id:'buyLabel',component:'Text',text:'Buy'}]}});
 const surface=host.children[0],root=surface.children[0],[title,field,buy]=root.children;
 assert.equal(root.dataset.componentId,'root');assert.equal(root.dataset.variant,undefined);
 assert.deepEqual([title.dataset.componentId,title.dataset.variant],['title','h2']);
 assert.deepEqual([field.dataset.componentId,field.dataset.variant],['field','longText']);
 assert.deepEqual([buy.dataset.componentId,buy.dataset.variant],['buy','primary']);assert.equal(buy.children[0].dataset.componentId,'buyLabel');
});

test('Text bound to a finite number or a boolean shows its JSON spelling; anything else shows nothing',()=>{
 const {host,renderer}=setup();
 renderer.apply({version:'v0.9.1',createSurface:{surfaceId:'main',catalogId:APP_MIXER_CATALOG}});
 renderer.apply({version:'v0.9.1',updateDataModel:{surfaceId:'main',value:{count:3,ratio:2.5,off:false,on:true,none:null,list:[1],nested:{a:1},text:'plain'}}});
 const paths=['/count','/ratio','/off','/on','/none','/list','/nested','/text','/missing'];
 renderer.apply({version:'v0.9.1',updateComponents:{surfaceId:'main',components:[{id:'root',component:'Column',children:paths.map((_,index)=>'t'+index)},...paths.map((path,index)=>({id:'t'+index,component:'Text',text:{path}}))]}});
 assert.deepEqual([...host.children[0].children[0].children].map(node=>node.textContent),['3','2.5','false','true','','','','plain','']);
});

const shape=element=>({tag:element.tagName,text:element.textContent,value:element.value,data:{...element.dataset},children:element.children.map(shape)});
const counting=()=>{const doc={created:0,createElement(tag){doc.created++;return new Element(tag,doc);}};return doc;};
const surfaceMessages=(data)=>[{version:'v0.9.1',createSurface:{surfaceId:'main',catalogId:APP_MIXER_CATALOG}},{version:'v0.9.1',updateDataModel:{surfaceId:'main',value:data}},{version:'v0.9.1',updateComponents:{surfaceId:'main',components:[
 {id:'root',component:'Column',children:['title','count','field','save']},{id:'title',component:'Text',text:{path:'/form/name'},variant:'h2'},{id:'count',component:'Text',text:{path:'/stats/count'}},
 {id:'field',component:'TextField',label:'Name',value:{path:'/form/name'}},{id:'save',component:'Button',child:'saveLabel',action:{event:{name:'save',context:{name:{path:'/form/name'}}}}},{id:'saveLabel',component:'Text',text:'Save'}]}}];
test('a data-only update patches bound nodes in place and matches a full render',()=>{
 const doc=counting(),host=doc.createElement('main'),renderer=new A2UIRenderer(host);
 const messages=surfaceMessages({form:{name:'Ada'},stats:{count:1}});for(const message of messages)renderer.apply(message);
 const root=host.children[0].children[0],input=root.children[2].children[1],created=doc.created;
 let data={form:{name:'Ada'},stats:{count:1}};
 for(const [path,value] of [['/form/name','Grace'],['/stats/count',2],['/stats/count',true],['/form/name','Lin'],['/stats/count',null],['/form/name',undefined]]){
  renderer.apply({version:'v0.9.1',updateDataModel:{surfaceId:'main',path,value}});
  const [section,key]=path.slice(1).split('/');data={...data,[section]:{...data[section]}};if(value===undefined)delete data[section][key];else data[section][key]=value;
  const fresh=counting(),freshHost=fresh.createElement('main'),freshRenderer=new A2UIRenderer(freshHost);for(const message of surfaceMessages(data))freshRenderer.apply(message);
  assert.deepEqual(shape(host),shape(freshHost),`after ${path}=${String(value)}`);
 }
 assert.equal(doc.created,created,'no element was created by data-only updates');assert.equal(host.children[0].children[0],root,'the surface keeps its root');assert.equal(root.children[2].children[1],input,'the field keeps its input node');
});
test('a surface with a custom component is rebuilt on data updates',()=>{
 const registry=basicRegistry().register('Badge',(c,_child,data,doc)=>{const element=doc.createElement('span');element.textContent='badge:'+JSON.stringify(data);return element;});
 const doc=counting(),host=doc.createElement('main'),renderer=new A2UIRenderer(host,registry);
 renderer.apply({version:'v0.9.1',createSurface:{surfaceId:'main',catalogId:APP_MIXER_CATALOG}});renderer.apply({version:'v0.9.1',updateDataModel:{surfaceId:'main',value:{n:1}}});
 renderer.apply({version:'v0.9.1',updateComponents:{surfaceId:'main',components:[{id:'root',component:'Column',children:['badge']},{id:'badge',component:'Badge'}]}});
 const created=doc.created;renderer.apply({version:'v0.9.1',updateDataModel:{surfaceId:'main',path:'/n',value:2}});
 assert.ok(doc.created>created,'the custom component may read any data, so the surface is rebuilt');assert.equal(host.children[0].children[0].children[0].textContent,'badge:{"n":2}');
});
test('the renderer benchmark shows the incremental path beating a rebuild on a 1,000-component surface',async()=>{
 const {spawnSync}=await import('node:child_process'),{fileURLToPath}=await import('node:url'),script=fileURLToPath(new URL('../../../scripts/bench-renderer.mjs',import.meta.url));
 const run=spawnSync(process.execPath,['--no-warnings',script,'20'],{encoding:'utf8',timeout:120000});assert.equal(run.status,0,run.stderr);
 const [incremental,rebuild]=run.stdout.trim().split('\n').map(line=>JSON.parse(line));assert.deepEqual([incremental.mode,rebuild.mode],['incremental','rebuild']);assert.ok(incremental.components>=998);
 assert.ok(incremental.perUpdateMs*3<rebuild.perUpdateMs,`incremental ${incremental.perUpdateMs} ms against rebuild ${rebuild.perUpdateMs} ms per update`);
});
