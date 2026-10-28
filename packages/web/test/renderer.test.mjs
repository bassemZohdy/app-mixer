import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {A2UIRenderer, A2UIJsonLines, BASIC_CATALOG, APP_MIXER_CATALOG, ComponentRegistry, basicRegistry} from '../dist/index.js';

class Element {
  constructor(tag, doc) { this.tagName=tag; this.ownerDocument=doc; this.children=[]; this.style={}; this.dataset={}; this.textContent=''; this.parent=null; this.listeners={}; this.value=''; this.selectionStart=0; this.selectionEnd=0; }
  appendChild(child) { child.parent=this; this.children.push(child); return child; }
  replaceChildren(...children) { this.children=[]; for(const child of children) this.appendChild(child); }
  remove() { if(this.parent) this.parent.children=this.parent.children.filter(child => child !== this); }
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
