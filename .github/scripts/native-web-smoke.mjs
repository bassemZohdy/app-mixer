import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createReactNativeA2UIComponent,APP_MIXER_CATALOG} from '../../packages/native/dist/index.js';
import {replayFixtures,nativeWebSurfaceRoot,nativeWebTree} from './fixture-tree.mjs';
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
 // The shared fixtures render through the React Native components (via react-native-web) as on the other adapters.
 const fixtureRoot=createRoot(document.getElementById('app'));let fixtureReceive;const fixtureErrors=[],fixtureActions=[];
 await React.act(()=>fixtureRoot.render(React.createElement(Component,{subscribe:callback=>{fixtureReceive=callback;},onError:error=>fixtureErrors.push(error),onAction:event=>fixtureActions.push(event)})));
 const deliver=message=>React.act(()=>fixtureReceive(message));deliver.click=element=>React.act(()=>element.click());
 deliver.type=(element,value)=>React.act(()=>{Object.getOwnPropertyDescriptor(element.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype,'value').set.call(element,value);element.dispatchEvent(new window.Event('input',{bubbles:true}));});
 await replayFixtures(deliver,document.getElementById('app'),{actions:()=>fixtureActions,errors:()=>fixtureErrors,root:nativeWebSurfaceRoot,tree:nativeWebTree});
 await React.act(()=>fixtureRoot.unmount());
 // The shared accessibility and typography reference, also checked on the web renderer and on Flutter.
 const reference=JSON.parse(readFileSync(new URL('../../adapters/flutter/test/fixtures/accessibility.json',import.meta.url),'utf8'));
 const a11yRoot=createRoot(document.getElementById('app'));let a11yReceive;const a11yErrors=[];
 await React.act(()=>a11yRoot.render(React.createElement(Component,{subscribe:callback=>{a11yReceive=callback;},onError:error=>a11yErrors.push(error),onAction:()=>{}})));
 await React.act(()=>{for(const message of reference.messages)a11yReceive(message);});
 const app=document.getElementById('app'),leaf=text=>[...app.querySelectorAll('*')].find(element=>element.children.length===0&&element.textContent===text);
 for(const expected of reference.semantics){
  if(expected.role==='heading'){const element=leaf(expected.name);assert.equal(element?.tagName,'H'+expected.level,expected.name);continue;}
  if(expected.role==='text'){const element=leaf(expected.name);assert.ok(element,expected.name);assert.equal(element.closest('h1,h2,h3,h4,h5,h6,button,[role="button"],[role="heading"]'),null,expected.name);continue;}
  if(expected.role==='textbox'){const element=app.querySelector(`[aria-label="${expected.name}"]`);assert.equal(element?.tagName,expected.multiline?'TEXTAREA':'INPUT',expected.name);assert.equal(element.value,expected.value,expected.name);continue;}
  if(expected.role==='button'){const element=[...app.querySelectorAll('[role="button"],button')].find(item=>item.textContent===expected.name);assert.ok(element,expected.name);assert.equal(element.getAttribute('aria-disabled')==='true'||element.disabled===true,!expected.enabled,expected.name);continue;}
  assert.fail('unknown role '+expected.role);
 }
 for(const expected of reference.typography){const style=leaf(expected.text).getAttribute('style')??'',size=Number(/font-size: ([\d.]+)px/.exec(style)?.[1]);assert.ok(Math.abs(size-expected.fontSize)<0.01,`${expected.text} font size ${size}`);assert.equal(/font-weight: (bold|700)/.test(style),expected.bold,`${expected.text} weight`);}
 assert.deepEqual(a11yErrors,[]);await React.act(()=>a11yRoot.unmount());
}finally{dom.window.close();}
