import test from 'node:test';
import assert from 'node:assert/strict';
import {A2UIRenderer, A2UIJsonLines, BASIC_CATALOG, ComponentRegistry, basicRegistry} from '../dist/index.js';

class Element {
  constructor(tag, doc) { this.tagName=tag; this.ownerDocument=doc; this.children=[]; this.style={}; this.dataset={}; this.textContent=''; this.parent=null; }
  appendChild(child) { child.parent=this; this.children.push(child); return child; }
  replaceChildren(...children) { this.children=[]; for(const child of children) this.appendChild(child); }
  remove() { if(this.parent) this.parent.children=this.parent.children.filter(child => child !== this); }
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
