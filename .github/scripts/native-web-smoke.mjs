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
 const input=document.querySelector('input');assert.ok(input);assert.equal(input.value,'Ada');
 await React.act(()=>{
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input,'Grace');
  input.dispatchEvent(new window.Event('input',{bubbles:true}));
 });
 assert.equal(document.querySelector('input').value,'Grace');
 await React.act(()=>document.querySelector('[role="button"]').click());
 assert.equal(actions.length,1);assert.deepEqual(actions[0].action.context,{name:'Grace'});assert.deepEqual(errors,[]);
 await React.act(()=>root.unmount());
}finally{dom.window.close();}
