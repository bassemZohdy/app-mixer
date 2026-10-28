import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {createReactNativeA2UIComponent,APP_MIXER_CATALOG} from '../../packages/native/dist/index.js';
if(!process.env.REACT_SMOKE_DEPS)throw Error('REACT_SMOKE_DEPS is required');
const require=createRequire(resolve(process.env.REACT_SMOKE_DEPS,'package.json'));
const {JSDOM}=require('jsdom');const dom=new JSDOM('<!doctype html><div id="app"></div>',{url:'http://localhost/'});
globalThis.window=dom.window;globalThis.document=dom.window.document;
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const React=require('react');const {createRoot}=require('react-dom/client');
const View=({children,style})=>React.createElement('div',{style},children);
const Text=({children,accessibilityRole})=>React.createElement('span',{'data-role':accessibilityRole},children);
const Component=createReactNativeA2UIComponent(React,{View,Text});const root=createRoot(document.getElementById('app'));
let receive,unsubscribed=0;const errors=[];
const subscribe=callback=>{receive=callback;return ()=>{unsubscribed++;};};
try{
 await React.act(()=>root.render(React.createElement(React.StrictMode,null,React.createElement(Component,{subscribe,onError:error=>errors.push(error)}))));
 await React.act(()=>{
  receive({version:'v0.9.1',createSurface:{surfaceId:'main',catalogId:APP_MIXER_CATALOG}});
  receive({version:'v0.9.1',updateDataModel:{surfaceId:'main',value:{name:'Native hello'}}});
  receive({version:'v0.9.1',updateComponents:{surfaceId:'main',components:[{id:'root',component:'Column',children:['title']},{id:'title',component:'Text',text:{path:'/name'},variant:'h1'}]}});
 });
 assert.equal(document.querySelector('span').textContent,'Native hello');assert.equal(document.querySelector('span').dataset.role,'header');
 await React.act(()=>receive({version:'v0.9.1',updateComponents:{surfaceId:'main',components:[{id:'root',component:'Button'}]}}));
 assert.equal(errors.length,1);assert.equal(document.querySelector('span').textContent,'Native hello');
 await React.act(()=>root.unmount());assert.equal(unsubscribed,2);receive({version:'invalid'});assert.equal(errors.length,1);
}finally{dom.window.close();}
