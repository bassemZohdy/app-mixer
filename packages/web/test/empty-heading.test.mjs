import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {A2UIRenderer,APP_MIXER_CATALOG} from '../dist/index.js';

function setup(components,value){
 const dom=new JSDOM('<main></main>'),host=dom.window.document.querySelector('main'),renderer=new A2UIRenderer(host);
 renderer.apply({version:'v0.9.1',createSurface:{surfaceId:'s',catalogId:APP_MIXER_CATALOG}});
 if(value!==undefined)renderer.apply({version:'v0.9.1',updateDataModel:{surfaceId:'s',value}});
 renderer.apply({version:'v0.9.1',updateComponents:{surfaceId:'s',components}});
 const update=next=>renderer.apply({version:'v0.9.1',updateDataModel:{surfaceId:'s',value:next}});
 return {host,update,headings:()=>host.querySelectorAll('h1,h2,h3,h4,h5')};
}
const tree=(variant='h3')=>[{id:'root',component:'Column',children:['title','after']},{id:'title',component:'Text',text:{path:'/title'},variant},{id:'after',component:'Text',text:'After'}];

test('FIX-033 a heading Text bound to a missing, null or empty value adds no heading',()=>{
 for(const value of [{},{title:null},{title:''},undefined]){
  const {host,headings}=setup(tree(),value);
  assert.equal(headings().length,0,JSON.stringify(value));
  assert.equal(host.textContent,'After');
 }
 for(const variant of ['h1','h2','h3','h4','h5']){
  const {headings}=setup(tree(variant),{title:''});assert.equal(headings().length,0,variant);
 }
});

test('FIX-033 a heading appears and disappears with its value in a full render and an in-place update',()=>{
 const {host,update,headings}=setup(tree(),{title:''});
 assert.equal(headings().length,0);
 update({title:'Welcome'});
 assert.equal(headings().length,1);assert.equal(headings()[0].tagName,'H3');assert.equal(headings()[0].textContent,'Welcome');
 assert.equal(headings()[0].dataset.componentId,'title');
 assert.equal(host.querySelector('[data-component-id="root"]').children[0],headings()[0],'the heading keeps its place before the next component');
 update({title:'Renamed'});assert.equal(headings().length,1);assert.equal(headings()[0].textContent,'Renamed');
 update({});assert.equal(headings().length,0);
 update({title:'Back'});assert.equal(headings()[0].textContent,'Back');
 const {headings:full}=setup(tree(),{title:'Now'});assert.equal(full().length,1);
});

test('FIX-033 a non-empty literal heading and a body Text are unchanged',()=>{
 const {headings,host}=setup([{id:'root',component:'Column',children:['a','b']},{id:'a',component:'Text',text:'Fixed',variant:'h2'},{id:'b',component:'Text',text:{path:'/x'}}],{});
 assert.equal(headings().length,1);assert.equal(host.querySelectorAll('p').length,1);
});
