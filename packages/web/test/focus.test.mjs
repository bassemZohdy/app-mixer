import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {A2UIRenderer,APP_MIXER_CATALOG} from '../dist/index.js';

const message=(kind,payload)=>({version:'v0.9.1',[kind]:payload});
test('external data updates preserve the focused field and clamp its selection',()=>{
 const dom=new JSDOM('<!doctype html><main></main>',{pretendToBeVisual:true}),doc=dom.window.document,renderer=new A2UIRenderer(doc.querySelector('main'));
 try{
  for(const surfaceId of ['main','other']){
   renderer.apply(message('createSurface',{surfaceId,catalogId:APP_MIXER_CATALOG}));
   renderer.apply(message('updateDataModel',{surfaceId,value:{name:'Ada Lovelace',note:'one'}}));
   renderer.apply(message('updateComponents',{surfaceId,components:[{id:'root',component:'Column',children:['field','note']},{id:'field',component:'TextField',label:surfaceId,value:{path:'/name'}},{id:'note',component:'Text',text:{path:'/note'}}]}));
  }
  const input=()=>doc.querySelectorAll('input')[0],other=()=>doc.querySelectorAll('input')[1];
  input().focus();input().setSelectionRange(4,11,'backward');
  renderer.apply(message('updateDataModel',{surfaceId:'main',path:'/note',value:'two'}));
  assert.equal(doc.activeElement,input());assert.equal(input().value,'Ada Lovelace');assert.deepEqual([input().selectionStart,input().selectionEnd,input().selectionDirection],[4,11,'backward']);
  renderer.apply(message('updateDataModel',{surfaceId:'main',path:'/name',value:'Hi'}));
  assert.equal(doc.activeElement,input());assert.equal(input().value,'Hi');assert.deepEqual([input().selectionStart,input().selectionEnd,input().selectionDirection],[2,2,'backward']);
  const kept=input();renderer.apply(message('updateDataModel',{surfaceId:'other',path:'/name',value:'Else'}));assert.equal(doc.activeElement,kept);assert.equal(input(),kept);assert.equal(other().value,'Else');
  assert.throws(()=>renderer.apply(message('updateDataModel',{surfaceId:'main',path:'/__proto__/polluted',value:'bad'})));assert.equal(doc.activeElement,kept);assert.equal(input().value,'Hi');
 }finally{dom.window.close();}
});

test('repeated field references remain editable and retain the focused occurrence',()=>{
 const dom=new JSDOM('<!doctype html><main></main>',{pretendToBeVisual:true}),doc=dom.window.document,renderer=new A2UIRenderer(doc.querySelector('main'));
 try{
  renderer.apply(message('createSurface',{surfaceId:'main',catalogId:APP_MIXER_CATALOG}));
  renderer.apply(message('updateDataModel',{surfaceId:'main',value:{name:'Ada'}}));
  renderer.apply(message('updateComponents',{surfaceId:'main',components:[{id:'root',component:'Column',children:['field','field']},{id:'field',component:'TextField',label:'Name',value:{path:'/name'}}]}));
  let [first,second]=doc.querySelectorAll('input');first.focus();first.value='Grace';first.setSelectionRange(2,2);first.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
  [first,second]=doc.querySelectorAll('input');assert.equal(first.value,'Grace');assert.equal(second.value,'Grace');assert.equal(doc.activeElement,first);assert.equal(first.selectionStart,2);
  const stale=first;second.focus();second.value='Lin';second.setSelectionRange(1,1);second.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
  [first,second]=doc.querySelectorAll('input');assert.equal(first.value,'Lin');assert.equal(second.value,'Lin');assert.equal(doc.activeElement,second);assert.equal(second.selectionStart,1);
  stale.value='Stale';stale.dispatchEvent(new dom.window.Event('input',{bubbles:true}));assert.equal(doc.querySelectorAll('input')[0].value,'Lin');
  renderer.apply(message('updateComponents',{surfaceId:'main',components:[{id:'root',component:'Column',children:['group','group']},{id:'group',component:'Column',children:['field']}]}));
  [first,second]=doc.querySelectorAll('input');first.focus();first.value='Nested';first.setSelectionRange(3,3);first.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
  [first,second]=doc.querySelectorAll('input');assert.equal(first.value,'Nested');assert.equal(second.value,'Nested');assert.equal(doc.activeElement,first);assert.equal(first.selectionStart,3);
 }finally{dom.window.close();}
});

test('external data updates wait for text composition without losing model changes',()=>{
 const dom=new JSDOM('<!doctype html><main></main>',{pretendToBeVisual:true}),doc=dom.window.document,actions=[],renderer=new A2UIRenderer(doc.querySelector('main'),undefined,action=>actions.push(action));
 try{
  renderer.apply(message('createSurface',{surfaceId:'main',catalogId:APP_MIXER_CATALOG}));
  renderer.apply(message('updateDataModel',{surfaceId:'main',value:{name:'Ada',note:'old'}}));
  renderer.apply(message('updateComponents',{surfaceId:'main',components:[
   {id:'root',component:'Column',children:['field','note','button']},
   {id:'field',component:'TextField',label:'Name',value:{path:'/name'}},
   {id:'note',component:'Text',text:{path:'/note'}},
   {id:'button',component:'Button',child:'label',action:{event:{name:'save',context:{note:{path:'/note'}}}}},
   {id:'label',component:'Text',text:'Save'}
  ]}));
  const input=doc.querySelector('input');input.focus();input.dispatchEvent(new dom.window.CompositionEvent('compositionstart',{bubbles:true}));
  input.value='日本';input.dispatchEvent(new dom.window.InputEvent('input',{bubbles:true,isComposing:true}));
  renderer.apply(message('updateDataModel',{surfaceId:'main',path:'/note',value:'new'}));
  renderer.apply(message('updateDataModel',{surfaceId:'main',path:'/name',value:'remote'}));
  assert.equal(doc.querySelector('input'),input);assert.equal(doc.activeElement,input);assert.equal(input.value,'日本');
  doc.querySelector('button').click();assert.equal(actions[0].action.context.note,'new');
  assert.throws(()=>renderer.apply(message('updateDataModel',{surfaceId:'main',path:'/__proto__/x',value:1})));
  input.dispatchEvent(new dom.window.CompositionEvent('compositionend',{bubbles:true}));
  assert.equal(doc.querySelector('input').value,'日本');assert.equal(doc.activeElement,doc.querySelector('input'));
  assert.ok([...doc.querySelectorAll('p')].some(node=>node.textContent==='new'));
 }finally{dom.window.close();}
});
