import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {createReactNativeA2UIComponent,APP_MIXER_CATALOG} from '../../packages/native/dist/index.js';
if(!process.env.REACT_SMOKE_DEPS)throw Error('REACT_SMOKE_DEPS is required');
const require=createRequire(resolve(process.env.REACT_SMOKE_DEPS,'package.json'));
const {JSDOM}=require('jsdom');const dom=new JSDOM('<!doctype html><div id="app"></div>',{url:'http://localhost/',pretendToBeVisual:true});
globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.HTMLElement=dom.window.HTMLElement;
globalThis.Node=dom.window.Node;globalThis.ShadowRoot=dom.window.ShadowRoot;globalThis.getComputedStyle=dom.window.getComputedStyle;
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const React=require('react');const {createRoot}=require('react-dom/client');
const {View,Text,TextInput,Pressable}=require('react-native-web');
const Component=createReactNativeA2UIComponent(React,{View,Text,TextInput,Pressable});const root=createRoot(document.getElementById('app'));
let receive;const errors=[],actions=[];const subscribe=callback=>{receive=callback;};
try{
 await React.act(()=>root.render(React.createElement(Component,{subscribe,onError:error=>errors.push(error),onAction:event=>actions.push(event)})));
 await React.act(()=>{
  receive({version:'v0.9.1',createSurface:{surfaceId:'main',catalogId:APP_MIXER_CATALOG}});
  receive({version:'v0.9.1',updateDataModel:{surfaceId:'main',value:{name:'Ada',secret:'private'}}});
  receive({version:'v0.9.1',updateComponents:{surfaceId:'main',components:[
   {id:'root',component:'Column',children:['title','field','button']},
   {id:'title',component:'Text',text:{path:'/name'}},
   {id:'field',component:'TextField',label:'Name',value:{path:'/name'}},
   {id:'button',component:'Button',child:'label',action:{event:{name:'save',context:{name:{path:'/name'}}}}},
   {id:'label',component:'Text',text:'Save'}
  ]}});
 });
 const input=document.querySelector('input');assert.ok(input);assert.equal(input.value,'Ada');assert.equal(input.getAttribute('aria-label'),'Name');
 const button=document.querySelector('[role="button"]');assert.ok(button);assert.equal(button.textContent,'Save');assert.notEqual(button.getAttribute('aria-disabled'),'true');
 await React.act(()=>{
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input,'Grace');
  input.dispatchEvent(new window.Event('input',{bubbles:true}));
 });
 assert.equal(document.querySelector('input').value,'Grace');
 await React.act(()=>document.querySelector('[role="button"]').click());
 assert.equal(actions.length,1);assert.deepEqual(actions[0].action.context,{name:'Grace'});assert.deepEqual(errors,[]);
 await React.act(()=>root.render(React.createElement(Component,{subscribe,onError:error=>errors.push(error)})));
 const disabled=document.querySelector('[role="button"]');assert.equal(disabled.getAttribute('aria-disabled'),'true');
 await React.act(()=>disabled.click());assert.equal(actions.length,1);
 await React.act(()=>root.render(React.createElement(Component,{subscribe,onError:error=>errors.push(error),onAction:event=>actions.push(event)})));
 await React.act(()=>receive({version:'v0.9.1',updateComponents:{surfaceId:'main',components:[
  {id:'root',component:'Column',children:['long-field','long-display','long-button']},
  {id:'long-field',component:'TextField',label:'Notes',value:{path:'/notes'},variant:'longText'},
  {id:'long-display',component:'Text',text:{path:'/notes'}},
  {id:'long-button',component:'Button',child:'long-label',action:{event:{name:'saveNotes',context:{notes:{path:'/notes'}}}}},
  {id:'long-label',component:'Text',text:'Save notes'}
 ]}}));
 const textarea=document.querySelector('textarea');assert.ok(textarea);assert.equal(textarea.getAttribute('aria-label'),'Notes');
 await React.act(()=>{
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set.call(textarea,'First line\nSecond line');
  textarea.dispatchEvent(new window.Event('input',{bubbles:true}));
 });
 assert.equal(document.querySelector('textarea').value,'First line\nSecond line');
 assert.ok([...document.querySelectorAll('*')].some(element=>element.children.length===0&&element.textContent==='First line\nSecond line'));
 await React.act(()=>document.querySelector('[role="button"]').click());
 assert.equal(actions.length,2);assert.equal(actions[1].action.name,'saveNotes');assert.deepEqual(actions[1].action.context,{notes:'First line\nSecond line'});assert.deepEqual(errors,[]);
 await React.act(()=>{
  receive({version:'v0.9.1',createSurface:{surfaceId:'other',catalogId:APP_MIXER_CATALOG}});
  receive({version:'v0.9.1',updateDataModel:{surfaceId:'other',value:{notes:'Separate'}}});
  receive({version:'v0.9.1',updateComponents:{surfaceId:'other',components:[
   {id:'root',component:'Column',children:['field','display']},
   {id:'field',component:'TextField',label:'Other notes',value:{path:'/notes'},variant:'longText'},
   {id:'display',component:'Text',text:{path:'/notes'}}
  ]}});
 });
 assert.equal(document.querySelector('[aria-label="Notes"]').value,'First line\nSecond line');
 assert.equal(document.querySelector('[aria-label="Other notes"]').value,'Separate');
 await React.act(()=>receive({version:'v0.9.1',updateDataModel:{surfaceId:'other',path:'/notes',value:'Changed elsewhere'}}));
 assert.equal(document.querySelector('[aria-label="Notes"]').value,'First line\nSecond line');
 assert.equal(document.querySelector('[aria-label="Other notes"]').value,'Changed elsewhere');
 const removed=document.querySelector('[aria-label="Other notes"]');
 await React.act(()=>receive({version:'v0.9.1',deleteSurface:{surfaceId:'other'}}));
 assert.equal(document.querySelector('[aria-label="Other notes"]'),null);
 await React.act(()=>{
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set.call(removed,'Late input');
  removed.dispatchEvent(new window.Event('input',{bubbles:true}));
 });
 assert.equal(document.querySelector('[aria-label="Notes"]').value,'First line\nSecond line');
 await React.act(()=>{
  receive({version:'v0.9.1',createSurface:{surfaceId:'other',catalogId:APP_MIXER_CATALOG}});
  receive({version:'v0.9.1',updateDataModel:{surfaceId:'other',value:{notes:'Replacement'}}});
  receive({version:'v0.9.1',updateComponents:{surfaceId:'other',components:[{id:'root',component:'TextField',label:'Other notes',value:{path:'/notes'},variant:'longText'}]}});
 });
 await React.act(()=>{
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set.call(removed,'Stale after recreation');
  removed.dispatchEvent(new window.Event('input',{bubbles:true}));
 });
 assert.equal(document.querySelector('[aria-label="Other notes"]').value,'Replacement');
 await React.act(()=>receive({version:'v0.9.1',deleteSurface:{surfaceId:'other'}}));
 assert.equal(actions.length,2);assert.deepEqual(errors,[]);
 await React.act(()=>receive({version:'v0.9.1',updateComponents:{surfaceId:'main',components:[
  {id:'root',component:'Column',children:['heading','caption']},
  {id:'heading',component:'Text',text:'Heading',variant:'h1'},
  {id:'caption',component:'Text',text:'Caption',variant:'caption'}
 ]}}));
 const heading=document.querySelector('[role="heading"]');assert.ok(heading);
 assert.equal(heading.style.fontSize,'32px');assert.equal(heading.style.fontWeight,'bold');
 const caption=[...document.querySelectorAll('*')].find(element=>element.textContent==='Caption' && element.children.length===0);
 assert.ok(caption);assert.equal(caption.style.fontSize,'13.33px');
 await React.act(()=>root.unmount());
}finally{dom.window.close();}
